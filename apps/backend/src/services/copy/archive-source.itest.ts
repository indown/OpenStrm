/**
 * 复制完归档，走真的 Provider（FakeDrive），不打桩：目录链建出来、真挪进「归档」、本地 strm 跟着删；
 * 归档里已有同名的不动、本来就在归档里的不动、不支持写的网盘不动、平铺复制的（没有任务目录）不动。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/archive-source.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { AxiosError } from "axios";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import type { OpenlistTaskInfo } from "../openlist/client.js";
import { flushOpenlistRefresh, setOpenlistRefreshDeps, startOpenlistRefresh, stopOpenlistRefresh } from "../openlist/refresh.js";
import type { NotifyEvent } from "../notify.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { __test_resetCopy, enqueueCopy, listCopies, setCopyServiceDeps, stopCopyWatcher, tickCopies } from "./service.js";

let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; openlistCopy: AppSettings["openlistCopy"] };
const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
let drive: FakeDrive;
/** OpenList 那一侧仍然是桩 */
let names: Record<string, string[]> = {};
let afterCopy: Record<string, string[]> = {};
const notified: NotifyEvent[] = [];
let now = 1_800_000_000_000;
const olTask = (over: Partial<OpenlistTaskInfo> = {}): OpenlistTaskInfo => ({ id: "tid1", name: "copy", state: 2, progress: 100, error: "", endedAt: now, ...over });
/** 提交过的复制任务：一条一个（OpenList 一次提交几个条目就回几个任务），盯任务时都当已经结束 */
let submitted: OpenlistTaskInfo[] = [];

const localTask: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "tv", targetPath: "copy-archive-itest/tv", strmPrefix: "/mnt" };
const LOCAL = path.join(DATA_DIR, "copy-archive-itest", "tv");
function localFile(rel: string): string {
  const full = path.join(LOCAL, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "/mnt/x");
  return full;
}

/** 登记 → 提交 → 报完成，一路跑到归档那一步 */
async function copyThrough(source: { path: string; isDir?: boolean; nodeId?: string }, over: Partial<Parameters<typeof enqueueCopy>[0]> = {}): Promise<void> {
  enqueueCopy({ account: "acc", sources: [source], rootPath: "/tv", taskId: "t1", trigger: "manual", afterCopy: "archive", ...over });
  await stopCopyWatcher();
  now += 30_000;
  await tickCopies();
  await tickCopies();
}
const detail = () => listCopies()[0].detail;

before(() => {
  baseline = { accounts: listAccounts(), tasks: listTasks(), openlistCopy: readAppSettings().openlistCopy };
  replaceAccounts([account, olAccount]);
  replaceTasks([localTask]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { acc: "/quark" } } });
  setCopyServiceDeps({
    openlist: {
      listNames: async (_cfg, dir) => names[dir] ?? [],
      mkdir: async () => {},
      copy: async (_cfg, srcDir, dstDir, ns) => {
        Object.assign(names, afterCopy);
        const tasks = ns.map((n, i) => olTask({ id: `tid-${submitted.length + i}`, name: `copy [/quark](${srcDir}/${n}) to [/local](${dstDir})`, state: 1, endedAt: null }));
        submitted.push(...tasks);
        return tasks;
      },
      copyTasks: async () => ({ undone: [], done: submitted.map((t) => ({ ...t, state: 2, endedAt: now })) }),
    },
    notify: async (ev) => {
      notified.push(ev);
    },
    now: () => now,
    embyRefresh: () => {},
    // archiveSource / removeLocalMirror / listDriveChildren 故意不给：就是要跑真的
  });
});

beforeEach(async () => {
  await __test_resetCopy();
  drive = new FakeDrive("quark", account);
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  fs.rmSync(LOCAL, { recursive: true, force: true });
  names = {};
  afterCopy = {};
  notified.length = 0;
  submitted = [];
});

after(async () => {
  fs.rmSync(path.join(DATA_DIR, "copy-archive-itest"), { recursive: true, force: true });
  await __test_resetCopy();
  setCopyServiceDeps(null);
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
  patchAppSettings({ openlistCopy: baseline.openlistCopy });
});

test("文件复制完：挪进任务目录下的「归档」，原来的层级留着，目录链建出来，本地 strm 删掉", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  const local = localFile("某剧/S01/E01.strm");
  names = { "/quark/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv", nodeId: drive.tree.get("/tv/某剧/S01/E01.mkv")!.id });
  assert.equal(listCopies()[0].status, "done");
  assert.match(detail(), /已归档到 \/tv\/归档\/某剧\/S01/);
  assert.match(detail(), /本地 strm 也删了/);
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E01.mkv"), "挪进了归档，层级照旧");
  assert.equal(drive.tree.get("/tv/某剧/S01/E01.mkv"), undefined);
  assert.equal(fs.existsSync(local), false);
  assert.equal(drive.calls.remove, 0, "归档不删东西");
  const done = notified.find((n) => n.type === "copy-done");
  assert.ok(done && !("kept" in done && done.kept), "源文件按设置处理了，通知里不提");
});

test("整目录复制完：整个目录挪进归档；同一轮里第二条走同一条目录链不再重建", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E02.mkv");
  drive.tree.addFile("/tv/电影/A.mkv");
  names = { "/quark/tv": ["某剧", "电影"] };
  afterCopy = { "/local/media": ["某剧", "电影"], "/local/media/某剧": ["S01"], "/local/media/某剧/S01": ["E01.mkv", "E02.mkv"], "/local/media/电影": ["A.mkv"] };
  enqueueCopy({ account: "acc", sources: [{ path: "/tv/某剧", isDir: true }, { path: "/tv/电影", isDir: true }], rootPath: "/tv", taskId: "t1", trigger: "manual", afterCopy: "archive" });
  await stopCopyWatcher();
  now += 30_000;
  await tickCopies();
  const mkdirsBefore = drive.calls.mkdir;
  await tickCopies();
  assert.ok(listCopies().every((c) => c.status === "done"));
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E02.mkv"));
  assert.ok(drive.tree.get("/tv/归档/电影/A.mkv"));
  assert.equal(drive.tree.get("/tv/某剧"), undefined);
  assert.equal(drive.calls.mkdir - mkdirsBefore, 1, "「归档」这一层只建一次，第二条从缓存里拿");
});

test("归档里已经有同名的：不覆盖不合并，源留着，说明和通知里都说", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/归档/某剧/S01/E01.mkv");
  names = { "/quark/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
  assert.equal(listCopies()[0].status, "done");
  assert.match(detail(), /归档目录里已经有同名的，源文件没动/);
  assert.ok(drive.tree.get("/tv/某剧/S01/E01.mkv"), "源还在");
  const done = notified.find((n) => n.type === "copy-done") as Extract<NotifyEvent, { type: "copy-done" }>;
  assert.deepEqual(done.kept, ["E01.mkv：归档目录里已经有同名的"]);
});

test("本来就在归档里的（把归档区选进来复制了）：不挪，不会把「归档」挪进「归档」", async () => {
  drive.tree.addFile("/tv/归档/某剧/S01/E01.mkv");
  names = { "/quark/tv/归档/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/归档/某剧/S01": ["E01.mkv"] };
  await copyThrough({ path: "/tv/归档/某剧/S01/E01.mkv" });
  assert.equal(listCopies()[0].status, "done");
  assert.match(detail(), /本来就在归档目录里/);
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E01.mkv"));
  assert.equal(drive.tree.get("/tv/归档/归档"), undefined);
});

test("平铺复制的（没有任务目录）归档不了；网盘不支持写也不动；源路径上换了别的文件不动", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/quark/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media": ["E01.mkv"] };
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv" }, { rootPath: undefined, taskId: undefined });
  assert.match(detail(), /不知道任务目录在哪.*源文件没动/);
  assert.ok(drive.tree.get("/tv/某剧/S01/E01.mkv"));

  await __test_resetCopy();
  const readOnly = new FakeDrive("quark", account, { write: false });
  readOnly.tree.addFile("/tv/某剧/S01/E01.mkv");
  setDriveProviderFactory((a) => (a.name === "acc" ? readOnly : null));
  names = { "/quark/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
  assert.match(detail(), /不支持移动，源文件没归档/);

  await __test_resetCopy();
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  const original = drive.tree.get("/tv/某剧/S01/E01.mkv")!.id;
  names = { "/quark/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  enqueueCopy({ account: "acc", sources: [{ path: "/tv/某剧/S01/E01.mkv", nodeId: original }], rootPath: "/tv", taskId: "t1", trigger: "manual", afterCopy: "archive" });
  await stopCopyWatcher();
  now += 30_000;
  await tickCopies();
  // 复制期间整理把它换成了另一个同名文件
  drive.tree.remove("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  await tickCopies();
  assert.match(detail(), /源路径上换成了别的文件，没归档/);
  assert.equal(drive.tree.get("/tv/归档/某剧/S01/E01.mkv"), undefined);
});

/** 网盘接口 30 秒没回（真机撞到过） */
const timeoutError = () => new AxiosError("timeout of 30000ms exceeded", "ECONNABORTED", { timeout: 30_000, headers: {} } as never);

test("归档碰上网盘超时：源留着、本地 strm 不动，一分钟后再挪，挪成了本地 strm 删掉、不再发通知", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  const local = localFile("某剧/S01/E01.strm");
  names = { "/quark/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  let failMove = true;
  drive.failWriteOn = (op) => (op === "move" && failMove ? timeoutError() : null);
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv", nodeId: drive.tree.get("/tv/某剧/S01/E01.mkv")!.id });
  assert.match(detail(), /归档源文件没成（网盘接口 30 秒没有回应），1 分钟后自动再试（1\/3）/);
  assert.ok(drive.tree.get("/tv/某剧/S01/E01.mkv"), "源还在原处");
  assert.ok(fs.existsSync(local), "没挪成，本地 strm 不动");

  failMove = false;
  now += 60_000;
  await tickCopies();
  assert.match(detail(), /^复制完成；网盘上那份已归档到 \/tv\/归档\/某剧\/S01，本地 strm 也删了$/);
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E01.mkv"));
  assert.equal(fs.existsSync(local), false);
  assert.equal(listCopies()[0].afterRetry, undefined);
  assert.deepEqual(notified.map((n) => n.type), ["copy-done"], "挪成了不再发通知");
});

test("上次其实挪过去了、只是没等到回话：到点再做时认出来算归档（节点 id 对得上才算），本地 strm 照删", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  const id = drive.tree.get("/tv/某剧/S01/E01.mkv")!.id;
  const local = localFile("某剧/S01/E01.strm");
  names = { "/quark/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  drive.failWriteOn = (op) => (op === "move" ? timeoutError() : null);
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv", nodeId: id });
  assert.equal(listCopies()[0].afterRetry?.attempts, 1);
  // 网盘那边其实挪成了（请求超时，挪动照样生效），id 不变
  drive.tree.move("/tv/某剧/S01/E01.mkv", "/tv/归档/某剧/S01/E01.mkv");
  drive.failWriteOn = null;
  now += 60_000;
  await tickCopies();
  assert.match(detail(), /^复制完成；网盘上那份已归档到 \/tv\/归档\/某剧\/S01（上次其实已经挪过去了），本地 strm 也删了$/);
  assert.equal(fs.existsSync(local), false);
  assert.equal(drive.calls.move, 1, "没再挪一次");

  // 归档里那个同名的不是它（id 对不上）：不能认成归档成了
  await __test_resetCopy();
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  notified.length = 0;
  submitted = [];
  drive.tree.addFile("/tv/某剧/S01/E02.mkv");
  names = { "/quark/tv/某剧/S01": ["E02.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv", "E02.mkv"] };
  drive.failWriteOn = (op) => (op === "move" ? timeoutError() : null);
  await copyThrough({ path: "/tv/某剧/S01/E02.mkv", nodeId: drive.tree.get("/tv/某剧/S01/E02.mkv")!.id });
  drive.tree.remove("/tv/某剧/S01/E02.mkv");
  drive.tree.addFile("/tv/归档/某剧/S01/E02.mkv");
  drive.failWriteOn = null;
  now += 60_000;
  await tickCopies();
  assert.match(detail(), /源文件已不在原处，没归档/);
  assert.equal(notified.filter((n) => n.type === "copy-kept").length, 1, "晚点再做的那次收场没成：另发一条");
});

test("归档之后让 OpenList 刷新源目录和归档目录连同上级", async () => {
  const listed: string[] = [];
  setOpenlistRefreshDeps({
    listDir: async (_acc, dir) => {
      listed.push(dir);
      return [];
    },
    quietMs: 10,
  });
  startOpenlistRefresh();
  try {
    drive.tree.addFile("/tv/某剧/S01/E01.mkv");
    names = { "/quark/tv/某剧/S01": ["E01.mkv"] };
    afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
    await copyThrough({ path: "/tv/某剧/S01/E01.mkv", nodeId: drive.tree.get("/tv/某剧/S01/E01.mkv")!.id });
    assert.match(detail(), /已归档到 \/tv\/归档\/某剧\/S01/);
    await flushOpenlistRefresh();
    assert.deepEqual(
      new Set(listed),
      new Set(["/quark/tv/某剧/S01", "/quark/tv", "/quark/tv/归档", "/quark/tv/归档/某剧", "/quark/tv/归档/某剧/S01"]),
      "源文件所在目录 + 归档目录链里任务目录以下每一层的父目录（这些目录可能是这次新建的）+ 落点本身",
    );
  } finally {
    stopOpenlistRefresh();
    setOpenlistRefreshDeps(null);
  }
});
