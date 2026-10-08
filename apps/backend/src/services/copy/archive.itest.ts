/**
 * 归档到暂存区：走真的 Provider（FakeDrive），不碰 OpenList。
 * 文件 / 整目录挪进任务目录下的「归档」、本地 strm 删掉、队列里同一个源的复制记录标成已归档；
 * 不动的几种（归档里同名、正在复制、网盘上没有、上次挪过了）；各种拒绝；网络问题停手、单条失败不影响别的。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/archive.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AxiosError } from "axios";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { events } from "../events.js";
import { __test_resetAutoOrganize, startAutoOrganize } from "../organize/auto.js";
import type { NotifyEvent } from "../notify.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { ARCHIVE_MAX, archiveToStaging, type ArchiveRequest } from "./archive.js";
import { saveCopies, type CopyRecord } from "./queue.js";
import { __test_resetCopy, canAfterCopy, listCopies, setCopyServiceDeps } from "./service.js";

const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "tv", targetPath: "copy-archive-itest/tv", strmPrefix: "/mnt" };
const LOCAL = path.join(DATA_DIR, "copy-archive-itest", "tv");

let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; openlistCopy: AppSettings["openlistCopy"]; tmdb: AppSettings["tmdb"] };
let drive: FakeDrive;
const notified: NotifyEvent[] = [];
const timeoutError = () => new AxiosError("timeout of 30000ms exceeded", "ECONNABORTED", { timeout: 30_000, headers: {} } as never);

function localFile(rel: string): string {
  const full = path.join(LOCAL, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "/mnt/x");
  return full;
}

/** 复制好了、去向是不动的一条记录（默认是 某剧/S01/E01.mkv） */
const rec = (over: Partial<CopyRecord>): CopyRecord => ({
  id: "r1",
  account: "acc",
  srcDir: "/tv/某剧/S01",
  name: "E01.mkv",
  isDir: false,
  dstDir: "/local/media/某剧/S01",
  dstBase: "/local/media",
  rootPath: "/tv",
  taskId: "t1",
  trigger: "monitor",
  afterCopy: "keep",
  addedAt: Date.now() - 60_000,
  status: "done",
  stage: "copying",
  detail: "复制完成",
  doneAt: Date.now() - 60_000,
  attempts: 0,
  waits: 0,
  misses: 0,
  ...over,
});

const E01 = "/tv/某剧/S01/E01.mkv";
const E02 = "/tv/某剧/S01/E02.mkv";
const go = (over: Partial<ArchiveRequest>) => archiveToStaging({ task, paths: [], ...over });
const rejects = async (p: Promise<unknown>, status: number, code: string, message?: RegExp) => {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof HttpError, String(err));
    assert.equal(err.status, status, err.message);
    assert.equal(err.extra.code, code, err.message);
    if (message) assert.match(err.message, message);
    return true;
  });
};

before(() => {
  startAutoOrganize();
  baseline = { accounts: listAccounts(), tasks: listTasks(), openlistCopy: readAppSettings().openlistCopy, tmdb: readAppSettings().tmdb };
  replaceAccounts([account]);
  replaceTasks([task]);
  setCopyServiceDeps({
    notify: async (ev) => {
      notified.push(ev);
    },
    // archiveSource / removeLocalMirror 故意不给：就是要跑真的
  });
});

beforeEach(async () => {
  await __test_resetCopy();
  __test_resetAutoOrganize();
  drive = new FakeDrive("quark", account);
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  fs.rmSync(LOCAL, { recursive: true, force: true });
  notified.length = 0;
  // 复制没配：归档到暂存区不该依赖它
  patchAppSettings({ openlistCopy: {}, tmdb: { apiKey: "k" } });
});

after(async () => {
  fs.rmSync(path.join(DATA_DIR, "copy-archive-itest"), { recursive: true, force: true });
  await __test_resetCopy();
  __test_resetAutoOrganize();
  setCopyServiceDeps(null);
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
  patchAppSettings({ openlistCopy: baseline.openlistCopy, tmdb: baseline.tmdb });
});

test("收一个文件：挪进归档、层级照旧，本地 strm 删掉，队列里复制好的那条标成已归档；不发通知、不碰 OpenList 设置", async () => {
  drive.tree.addFile(E01, { size: 100 });
  const local = localFile("某剧/S01/E01.strm");
  saveCopies([rec({ nodeId: drive.tree.get(E01)!.id })]);
  const progress: Array<[number, number]> = [];
  const r = await go({ paths: ["某剧/S01/E01.mkv", "某剧/S01/E01.mkv"], onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(r.done, 1);
  assert.equal(r.archiveDir, "/tv/归档");
  assert.deepEqual(r.items, [{ path: "某剧/S01/E01.mkv", name: "E01.mkv", isDir: false, outcome: "archived", to: "/tv/归档/某剧/S01", detail: "本地 strm 也删了" }]);
  assert.deepEqual(progress, [[1, 1]], "重复的路径只算一次");
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E01.mkv"), "挪进了归档，层级照旧");
  assert.equal(drive.tree.get(E01), undefined);
  assert.equal(fs.existsSync(local), false);
  assert.equal(drive.calls.remove, 0, "归档不删东西");
  const [c] = listCopies();
  assert.equal(c.afterCopy, "archive");
  assert.equal(c.sourceKept, undefined);
  assert.equal(c.detail, "复制完成；网盘上那份已归档到 /tv/归档/某剧/S01（归档到暂存区）");
  assert.equal(canAfterCopy(c), false, "面板和 copy_after 不再给它");
  assert.equal(notified.length, 0);
});

test("收整个目录：子项跟着走，本地目录整个删掉，目录下面复制好的记录也标成已归档；父目录在了子路径不单列", async () => {
  drive.tree.addFile(E01);
  drive.tree.addFile(E02);
  drive.tree.addFile("/tv/某剧/S02/E01.mkv");
  localFile("某剧/S01/E01.strm");
  localFile("某剧/S02/E01.strm");
  saveCopies([rec({ id: "a", nodeId: drive.tree.get(E01)!.id }), rec({ id: "b", name: "E02.mkv", nodeId: drive.tree.get(E02)!.id, afterCopy: "archive", sourceKept: "归档目录里已经有同名的" })]);
  const r = await go({ paths: ["某剧/S01", "某剧"] });
  assert.equal(r.done, 1);
  assert.deepEqual(r.items.map((i) => [i.path, i.outcome, i.to]), [["某剧", "archived", "/tv/归档"]]);
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E02.mkv") && drive.tree.get("/tv/归档/某剧/S02/E01.mkv"));
  assert.equal(drive.tree.get("/tv/某剧"), undefined);
  assert.equal(fs.existsSync(path.join(LOCAL, "某剧")), false, "本地目录整个删了");
  const byId = Object.fromEntries(listCopies().map((c) => [c.id, c]));
  assert.equal(byId.a.afterCopy, "archive");
  assert.match(byId.a.detail, /随上级目录归档到 \/tv\/归档（归档到暂存区）$/);
  assert.equal(byId.b.sourceKept, undefined, "当时没归档成的也算办了");
  assert.equal(canAfterCopy(byId.a) || canAfterCopy(byId.b), false);
});

test("不动的几种：归档里已有同名、正在复制到 OpenList（源是它 / 在它下面 / 它在那条源目录下面）、网盘上没有；上次挪过了的直接算归档", async () => {
  drive.tree.addFile(E01);
  drive.tree.addFile("/tv/归档/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/别的剧/S01/E01.mkv");
  drive.tree.addFile("/tv/第三部/E01.mkv");
  drive.tree.addFile("/tv/第四部/E01.mkv");
  drive.tree.addFile("/tv/归档/没了/E09.mkv");
  // 上次挪完、本地 strm 还没来得及删（响应丢了那种）：这次补上
  const stale = localFile("没了/E09.strm");
  saveCopies([rec({ id: "old", srcDir: "/tv/没了", name: "E09.mkv" })]);
  // 排着的：一个文件、一整个目录（登记时去向不动）
  const pending = (over: Partial<CopyRecord>) => rec({ status: "pending", stage: "waiting", detail: "等着复制到 OpenList", doneAt: undefined, ...over });
  saveCopies([
    ...listCopies(),
    pending({ id: "p1", srcDir: "/tv/别的剧/S01", name: "E01.mkv" }),
    pending({ id: "p2", srcDir: "/tv", name: "第三部", isDir: true }),
    pending({ id: "p3", srcDir: "/tv/第四部", name: "E01.mkv" }),
  ]);
  const r = await go({ paths: ["某剧/S01/E01.mkv", "别的剧", "第三部/E01.mkv", "第四部/E01.mkv", "没有的/E01.mkv", "没了/E09.mkv"] });
  assert.equal(r.done, 1);
  assert.deepEqual(
    r.items.map((i) => [i.path, i.outcome]),
    [
      ["某剧/S01/E01.mkv", "kept"],
      ["别的剧", "copying"],
      ["第三部/E01.mkv", "copying"],
      ["第四部/E01.mkv", "copying"],
      ["没有的/E01.mkv", "missing"],
      ["没了/E09.mkv", "archived"],
    ],
  );
  assert.match(r.items[0].detail ?? "", /归档目录里已经有同名的/);
  assert.match(r.items[1].detail ?? "", /正在复制到 OpenList.*copy_after/);
  assert.deepEqual(r.items[5], { path: "没了/E09.mkv", name: "E09.mkv", isDir: false, outcome: "archived", to: "/tv/归档/没了", detail: "已经在归档里（上次挪过了），本地 strm 也删了" });
  assert.equal(fs.existsSync(stale), false, "上次没做完的收尾补上了");
  assert.equal(listCopies().find((c) => c.id === "old")!.afterCopy, "archive", "记录也补标了");
  assert.ok(drive.tree.get(E01) && drive.tree.get("/tv/别的剧/S01/E01.mkv") && drive.tree.get("/tv/第三部/E01.mkv") && drive.tree.get("/tv/第四部/E01.mkv"), "一个都没动");
  assert.equal(drive.calls.move, 0);
  assert.equal(listCopies().filter((c) => c.status === "pending").length, 3, "排着的记录没被改");
});

test("拒绝：paths 空、太多、暂存区、任务目录本身；任务正在整理；网盘不支持移动——拒绝的一条都不动", async () => {
  drive.tree.addFile(E01);
  await rejects(go({ paths: [] }), 400, "VALIDATION", /不能为空/);
  await rejects(go({ paths: Array.from({ length: ARCHIVE_MAX + 1 }, (_, i) => `x${i}`) }), 400, "VALIDATION", /最多/);
  await rejects(go({ paths: ["归档/某剧"] }), 400, "VALIDATION", /暂存区.*不归档/);
  await rejects(go({ paths: ["重复文件/某剧"] }), 400, "VALIDATION", /暂存区/);
  await rejects(go({ paths: [""] }), 400, "VALIDATION", /任务目录本身.*归档/);
  await rejects(go({ paths: ["../x"] }), 400, "VALIDATION");
  // 攒着一次会直接执行的自动整理：整理会改名挪目录，这时不动
  events.emit("files.landed", { task: { ...task, organize: { mode: "auto" } }, paths: ["某剧"], trigger: "share", debounce: true });
  await rejects(go({ paths: ["某剧/S01/E01.mkv"] }), 409, "TASK_ORGANIZING", /整理完再归档/);
  __test_resetAutoOrganize();
  // 只读的网盘
  const readOnly = new FakeDrive("quark", account, { write: false });
  readOnly.tree.addFile(E01);
  setDriveProviderFactory((a) => (a.name === "acc" ? readOnly : null));
  await rejects(go({ paths: ["某剧/S01/E01.mkv"] }), 400, "UNSUPPORTED", /不支持移动/);
  assert.ok(drive.tree.get(E01) && readOnly.tree.get(E01), "拒绝的一条都没动");
  assert.equal(drive.calls.move + readOnly.calls.move, 0);
});

test("网络问题：第一阶段网盘读不到整个请求都不动；第二阶段挪的时候超时，那条记失败、后面的不试，修好再来都收进去（已经挪过的不重复）", async () => {
  drive.tree.addFile(E01);
  drive.tree.addFile(E02);
  drive.tree.addFile("/tv/某剧/S01/E03.mkv");
  const local = localFile("某剧/S01/E01.strm");
  drive.failWith = timeoutError();
  await assert.rejects(go({ paths: ["某剧/S01/E01.mkv"] }), /timeout/);
  drive.failWith = null;
  assert.ok(drive.tree.get(E01) && fs.existsSync(local), "没动");

  let moves = 0;
  drive.failWriteOn = (op) => (op === "move" && ++moves === 2 ? timeoutError() : null);
  const r = await go({ paths: ["某剧/S01/E01.mkv", "某剧/S01/E02.mkv", "某剧/S01/E03.mkv"] });
  assert.equal(r.done, 1);
  assert.deepEqual(r.items.map((i) => [i.path, i.outcome]), [["某剧/S01/E01.mkv", "archived"], ["某剧/S01/E02.mkv", "failed"], ["某剧/S01/E03.mkv", "skipped"]]);
  assert.equal(r.items[1].detail, "归档没成：网盘接口 30 秒没有回应");
  assert.match(r.items[2].detail ?? "", /前面一条碰上网络问题（网盘接口 30 秒没有回应），这条没试/);
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E01.mkv") && drive.tree.get(E02) && drive.tree.get("/tv/某剧/S01/E03.mkv"));
  assert.equal(fs.existsSync(local), false);

  drive.failWriteOn = null;
  const again = await go({ paths: ["某剧/S01/E01.mkv", "某剧/S01/E02.mkv", "某剧/S01/E03.mkv"] });
  assert.equal(again.done, 3);
  assert.deepEqual(again.items.map((i) => [i.outcome, i.detail]), [
    ["archived", "已经在归档里（上次挪过了）"],
    ["archived", undefined],
    ["archived", undefined],
  ]);
  assert.equal(drive.tree.children("/tv/某剧/S01").length, 0);
});

test("不是网络问题的单条失败（网盘拒了这一个）：那条记失败，别的照常收", async () => {
  drive.tree.addFile(E01);
  drive.tree.addFile(E02);
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("E01.mkv") ? new Error("这个文件被锁住了") : null);
  const r = await go({ paths: ["某剧/S01/E01.mkv", "某剧/S01/E02.mkv"] });
  assert.equal(r.done, 1);
  assert.deepEqual(r.items.map((i) => [i.path, i.outcome, i.detail]), [
    ["某剧/S01/E01.mkv", "failed", "归档没成：这个文件被锁住了"],
    ["某剧/S01/E02.mkv", "archived", undefined],
  ]);
  assert.ok(drive.tree.get(E01) && drive.tree.get("/tv/归档/某剧/S01/E02.mkv"));
});
