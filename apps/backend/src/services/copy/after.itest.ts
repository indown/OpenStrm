/**
 * 事后处理已复制条目的源文件（归档 / 删除）：走真的 Provider（FakeDrive），OpenList 那一侧是桩。
 * 按记录 id 和按路径两种指法；动手前核对源在不在、目标里齐不齐（目录逐层比名字、文件比大小）；
 * 还在复制的补去向；各种不能处理的原因；删除要允许；临时错误交给循环再做。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/after.itest.ts
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
import { OpenlistError } from "../openlist/client.js";
import type { NotifyEvent } from "../notify.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { AFTER_MAX, settleAfterCopy, type AfterCopyInput } from "./after.js";
import { hasCopyWork, saveCopies, type CopyRecord } from "./queue.js";
import { __test_resetCopy, canAfterCopy, enqueueCopy, listCopies, setCopyServiceDeps, stopCopyWatcher, tickCopies } from "./service.js";

const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const ol: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "tv", targetPath: "copy-after-itest/tv", strmPrefix: "/mnt" };
const COPY_SETTINGS = { account: "ol", dstDir: "/local/media", mounts: { acc: "/quark" } };
const LOCAL = path.join(DATA_DIR, "copy-after-itest", "tv");

let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; openlistCopy: AppSettings["openlistCopy"]; tmdb: AppSettings["tmdb"] };
let drive: FakeDrive;
/** OpenList 目标目录里现有的条目；没有的目录当「还没建」 */
let targets: Record<string, Array<{ name: string; size?: number; isDir?: boolean }>> = {};
const notified: NotifyEvent[] = [];
let now = Date.now();
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
  addedAt: now - 60_000,
  status: "done",
  stage: "copying",
  detail: "复制完成",
  doneAt: now - 60_000,
  attempts: 0,
  waits: 0,
  misses: 0,
  ...over,
});

const E01 = "/tv/某剧/S01/E01.mkv";
const go = (over: Partial<AfterCopyInput>) => settleAfterCopy({ afterCopy: "archive", allowDelete: false, ...over });
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
  replaceAccounts([account, ol]);
  replaceTasks([task]);
  setCopyServiceDeps({
    openlist: {
      listNames: async (_cfg, dir) => {
        if (!targets[dir]) throw new OpenlistError("failed get objs: failed get dir: object not found", 500, false);
        return targets[dir].map((e) => e.name);
      },
      listEntries: async (_cfg, dir) => {
        if (!targets[dir]) throw new OpenlistError("failed get objs: failed get dir: object not found", 500, false);
        return targets[dir];
      },
      mkdir: async () => {},
      copy: async () => [],
      copyTasks: async () => ({ undone: [], done: [] }),
    },
    notify: async (ev) => {
      notified.push(ev);
    },
    now: () => now,
    embyRefresh: () => {},
    // archiveSource / removeSource / removeLocalMirror / listDriveChildren 故意不给：就是要跑真的
  });
});

beforeEach(async () => {
  await __test_resetCopy();
  __test_resetAutoOrganize();
  drive = new FakeDrive("quark", account);
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  fs.rmSync(LOCAL, { recursive: true, force: true });
  targets = {};
  notified.length = 0;
  now = Date.now();
  patchAppSettings({ openlistCopy: COPY_SETTINGS, tmdb: { apiKey: "k" } });
});

after(async () => {
  fs.rmSync(path.join(DATA_DIR, "copy-after-itest"), { recursive: true, force: true });
  await __test_resetCopy();
  __test_resetAutoOrganize();
  setCopyServiceDeps(null);
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
  patchAppSettings({ openlistCopy: baseline.openlistCopy, tmdb: baseline.tmdb });
});

test("按记录 id：复制好、去向是不动的文件，核对目标里有同名同大小后挪进归档，本地 strm 删掉，记录改成归档；当场回话不发通知", async () => {
  drive.tree.addFile(E01, { size: 100 });
  const local = localFile("某剧/S01/E01.strm");
  targets = { "/local/media/某剧/S01": [{ name: "E01.mkv", size: 100 }] };
  saveCopies([rec({ nodeId: drive.tree.get(E01)!.id })]);
  const progress: Array<[number, number]> = [];
  const r = await go({ ids: ["r1", "r1"], onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(r.afterCopy, "archive");
  assert.equal(r.done, 1);
  assert.deepEqual(r.items, [{ path: "某剧/S01/E01.mkv", id: "r1", name: "E01.mkv", isDir: false, outcome: "archived", to: "/tv/归档/某剧/S01" }]);
  assert.deepEqual(progress, [[1, 1]], "重复的 id 只算一次");
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E01.mkv"), "挪进了归档，层级照旧");
  assert.equal(drive.tree.get(E01), undefined);
  assert.equal(fs.existsSync(local), false);
  assert.equal(drive.calls.remove, 0, "归档不删东西");
  const [c] = listCopies();
  assert.equal(c.afterCopy, "archive");
  assert.equal(c.status, "done");
  assert.equal(c.detail, "复制完成（事后归档）；网盘上那份已归档到 /tv/归档/某剧/S01，本地 strm 也删了");
  assert.equal(c.sourceKept, undefined);
  assert.equal(canAfterCopy(c), false, "处理过了就不再给事后处理");
  assert.equal(notified.length, 0);
  assert.equal(hasCopyWork(), false, "没留下要循环再做的");
});

test("整目录：目标里少了文件、或文件大小对不上的不动并说清楚；齐了才整个挪进归档", async () => {
  drive.tree.addFile(E01, { size: 100 });
  drive.tree.addFile("/tv/某剧/S01/E02.mkv", { size: 100 });
  targets = {
    "/local/media": [{ name: "某剧", isDir: true }],
    "/local/media/某剧": [{ name: "S01", isDir: true }],
    "/local/media/某剧/S01": [{ name: "E01.mkv", size: 100 }],
  };
  saveCopies([rec({ id: "d1", srcDir: "/tv", name: "某剧", isDir: true, dstDir: "/local/media", nodeId: drive.tree.get("/tv/某剧")!.id })]);
  const missing = await go({ ids: ["d1"] });
  assert.equal(missing.done, 0);
  assert.equal(missing.items[0].outcome, "incomplete");
  assert.match(missing.items[0].detail ?? "", /少了 1 项（E02\.mkv）/);
  assert.ok(drive.tree.get("/tv/某剧/S01/E02.mkv"), "没动");
  assert.equal(listCopies()[0].afterCopy, "keep", "记录没改");

  targets["/local/media/某剧/S01"] = [{ name: "E01.mkv", size: 100 }, { name: "E02.mkv", size: 5 }];
  const smaller = await go({ ids: ["d1"] });
  assert.equal(smaller.items[0].outcome, "incomplete");
  assert.match(smaller.items[0].detail ?? "", /1 个文件大小对不上（E02\.mkv）/);

  targets["/local/media/某剧/S01"] = [{ name: "E01.mkv", size: 100 }, { name: "E02.mkv", size: 100 }];
  const ok = await go({ ids: ["d1"] });
  assert.equal(ok.done, 1);
  assert.deepEqual(ok.items, [{ path: "某剧", id: "d1", name: "某剧", isDir: true, outcome: "archived", to: "/tv/归档" }]);
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E02.mkv"));
  assert.equal(drive.tree.get("/tv/某剧"), undefined);
});

test("还在复制的：去向补成这次要的，复制完按它处理（节点 id 钉上）；记录上已经有去向的不改、照实说", async () => {
  drive.tree.addFile("/tv/某剧/S01/E03.mkv");
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E03.mkv"], rootPath: "/tv", taskId: "t1", trigger: "monitor" });
  await stopCopyWatcher();
  const [p] = listCopies();
  assert.equal(p.afterCopy, "keep");
  const r = await go({ ids: [p.id] });
  assert.equal(r.done, 0);
  assert.equal(r.items[0].outcome, "scheduled");
  assert.match(r.items[0].detail ?? "", /复制完会归档/);
  const upgraded = listCopies().find((c) => c.id === p.id)!;
  assert.equal(upgraded.status, "pending");
  assert.equal(upgraded.afterCopy, "archive");
  assert.equal(upgraded.nodeId, drive.tree.get("/tv/某剧/S01/E03.mkv")!.id);
  assert.ok(drive.tree.get("/tv/某剧/S01/E03.mkv"), "还没复制完，源不动");

  const again = await go({ ids: [p.id], afterCopy: "delete", allowDelete: true });
  assert.equal(again.items[0].outcome, "pending");
  assert.match(again.items[0].detail ?? "", /记录上的去向（归档）/);
  assert.equal(listCopies().find((c) => c.id === p.id)!.afterCopy, "archive", "先登记的算");
});

test("不能处理的各种记录都照实说原因，好的那条照常处理", async () => {
  drive.tree.addFile(E01, { size: 100 });
  targets = { "/local/media/某剧/S01": [{ name: "E01.mkv", size: 100 }] };
  saveCopies([
    rec({ id: "ok", nodeId: drive.tree.get(E01)!.id }),
    rec({ id: "f1", status: "failed" }),
    rec({ id: "s1", status: "skipped" }),
    rec({ id: "a1", adopted: true, srcDir: "", taskId: "", rootPath: undefined }),
    rec({ id: "x1", afterCopy: "archive", detail: "复制完成；网盘上那份已归档到 /tv/归档/某剧/S01" }),
    rec({ id: "w1", afterCopy: "archive", afterRetry: { attempts: 1, nextAt: now + 60_000, why: "超时" } }),
    rec({ id: "flat", taskId: "", rootPath: undefined }),
    rec({ id: "orphan", taskId: "nope" }),
  ]);
  const r = await go({ ids: ["f1", "s1", "a1", "x1", "w1", "flat", "orphan", "nope-id", "ok"] });
  assert.equal(r.done, 1);
  const by = new Map(r.items.map((i) => [i.id, i]));
  assert.equal(by.get("ok")!.outcome, "archived");
  for (const id of ["f1", "s1", "a1", "x1", "w1", "flat", "orphan", "nope-id"]) assert.equal(by.get(id)!.outcome, "invalid", id);
  assert.match(by.get("f1")!.detail!, /没复制成/);
  assert.match(by.get("s1")!.detail!, /没复制成/);
  assert.match(by.get("a1")!.detail!, /接管的/);
  assert.match(by.get("x1")!.detail!, /已经按设置归档过了/);
  assert.match(by.get("w1")!.detail!, /正在自动重试/);
  assert.match(by.get("flat")!.detail!, /平铺复制的/);
  assert.match(by.get("orphan")!.detail!, /任务已经不在了/);
  assert.match(by.get("nope-id")!.detail!, /不存在/);
  assert.equal(by.get("nope-id")!.path, "", "不存在的记录没有路径可说");
  // 没动的那些记录原样
  assert.equal(listCopies().find((c) => c.id === "flat")!.afterCopy, "keep");
});

test("没动的两种：归档里已经有同名的（记录留着可以再来）；源路径上换成了别的文件（记录不改）", async () => {
  drive.tree.addFile(E01, { size: 100 });
  drive.tree.addFile("/tv/归档/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E02.mkv", { size: 100 });
  targets = { "/local/media/某剧/S01": [{ name: "E01.mkv", size: 100 }, { name: "E02.mkv", size: 100 }] };
  saveCopies([rec({ id: "r1", nodeId: drive.tree.get(E01)!.id }), rec({ id: "r2", name: "E02.mkv", nodeId: "someone-else" })]);
  const r = await go({ ids: ["r1", "r2"] });
  assert.equal(r.done, 0);
  const by = new Map(r.items.map((i) => [i.id, i]));
  assert.equal(by.get("r1")!.outcome, "kept");
  assert.equal(by.get("r1")!.detail, "归档目录里已经有同名的");
  assert.equal(by.get("r2")!.outcome, "kept");
  assert.match(by.get("r2")!.detail!, /换成了别的文件/);
  assert.ok(drive.tree.get(E01) && drive.tree.get("/tv/某剧/S01/E02.mkv"), "源都还在");
  const r1 = listCopies().find((c) => c.id === "r1")!;
  assert.equal(r1.afterCopy, "archive");
  assert.equal(r1.sourceKept, "归档目录里已经有同名的");
  assert.equal(r1.detail, "复制完成（事后归档）；归档目录里已经有同名的，源文件没动");
  assert.equal(canAfterCopy(r1), true, "清掉归档里那份之后还能再来");
  const r2 = listCopies().find((c) => c.id === "r2")!;
  assert.equal(r2.afterCopy, "keep");
  assert.equal(r2.detail, "复制完成");
});

test("按路径：队列里没有记录的（两天前复制的）新记一条「目标里已经有这一份」，整目录核对齐了挪进归档", async () => {
  drive.tree.addFile("/tv/电影/A.mkv", { size: 7 });
  const local = localFile("电影/A.strm");
  targets = { "/local/media": [{ name: "电影", isDir: true }], "/local/media/电影": [{ name: "A.mkv", size: 7 }] };
  const r = await go({ task, paths: ["电影/"] });
  assert.equal(r.done, 1);
  const [c] = listCopies();
  assert.deepEqual(r.items, [{ path: "电影", id: c.id, name: "电影", isDir: true, outcome: "archived", to: "/tv/归档" }]);
  assert.equal(c.trigger, "manual");
  assert.equal(c.status, "done");
  assert.equal(c.afterCopy, "archive");
  assert.deepEqual([c.srcDir, c.name, c.isDir, c.dstDir, c.dstBase, c.rootPath, c.taskId], ["/tv", "电影", true, "/local/media", "/local/media", "/tv", "t1"]);
  assert.equal(c.nodeId, drive.tree.get("/tv/归档/电影")!.id, "钉的是核对时找到的那个节点");
  assert.equal(c.detail, "目标里已经有这一份，事后处理源文件；网盘上那份已归档到 /tv/归档，本地 strm 也删了");
  assert.ok(drive.tree.get("/tv/归档/电影/A.mkv"));
  assert.equal(fs.existsSync(local), false);
});

test("按路径：队列里有复制好的那条就接着用它、不另记；网盘上没有的、目标里没有的照实说", async () => {
  drive.tree.addFile(E01, { size: 100 });
  drive.tree.addFile("/tv/B.mkv", { size: 3 });
  targets = { "/local/media/某剧/S01": [{ name: "E01.mkv", size: 100 }], "/local/media": [{ name: "某剧", isDir: true }] };
  saveCopies([rec({ id: "r1", nodeId: drive.tree.get(E01)!.id })]);
  const r = await go({ task, paths: ["某剧/S01/E01.mkv", "没有的.mkv", "B.mkv"] });
  assert.equal(r.done, 1);
  assert.deepEqual(
    r.items.map((i) => [i.path, i.id, i.outcome]),
    [
      ["某剧/S01/E01.mkv", "r1", "archived"],
      ["没有的.mkv", undefined, "missing"],
      ["B.mkv", r.items[2].id, "incomplete"],
    ],
  );
  assert.match(r.items[2].detail ?? "", /目标 \/local\/media 里没有这一份/);
  assert.equal(listCopies().length, 1, "接着用 r1，没核对过的 B.mkv 也没记");
  assert.equal(listCopies()[0].id, "r1");
});

test("拒绝：ids 和路径二选一、都没给、路径没给任务、太多条、暂存区、任务目录本身、目标目录越界、复制没配好、任务正在整理；删除要允许", async () => {
  drive.tree.addFile(E01, { size: 100 });
  targets = { "/local/media/某剧/S01": [{ name: "E01.mkv", size: 100 }] };
  saveCopies([rec({ id: "r1", nodeId: drive.tree.get(E01)!.id })]);
  await rejects(go({ ids: ["r1"], task, paths: ["x"] }), 400, "VALIDATION", /二选一/);
  await rejects(go({}), 400, "VALIDATION", /ids/);
  await rejects(go({ paths: ["x"] }), 400, "VALIDATION", /task/);
  await rejects(go({ ids: Array.from({ length: AFTER_MAX + 1 }, (_, i) => `id${i}`) }), 400, "VALIDATION", /最多/);
  await rejects(go({ task, paths: ["归档/某剧"] }), 400, "VALIDATION", /暂存区/);
  await rejects(go({ task, paths: [""] }), 400, "VALIDATION", /任务目录本身/);
  await rejects(go({ task, paths: ["某剧"], dstDir: "/elsewhere" }), 400, "COPY_DST_INVALID", /只能是/);
  await rejects(go({ ids: ["r1"], afterCopy: "delete" }), 403, "INSUFFICIENT_SCOPE", /删除/);
  patchAppSettings({ openlistCopy: { dstDir: "/local/media", mounts: { acc: "/quark" } } });
  await rejects(go({ ids: ["r1"] }), 400, "COPY_NOT_READY", /OpenList/);
  patchAppSettings({ openlistCopy: COPY_SETTINGS });
  // 攒着一次会直接执行的自动整理：整理会改名挪目录，这时不动
  events.emit("files.landed", { task: { ...task, organize: { mode: "auto" } }, paths: ["某剧"], trigger: "share", debounce: true });
  await rejects(go({ ids: ["r1"] }), 409, "TASK_ORGANIZING", /正在整理/);
  await rejects(go({ task, paths: ["某剧/S01/E01.mkv"] }), 409, "TASK_ORGANIZING");
  __test_resetAutoOrganize();
  assert.ok(drive.tree.get(E01), "拒绝的一条都没动");
  assert.equal(listCopies()[0].afterCopy, "keep");
});

test("删除：允许了才删，网盘上那份进回收站、本地 strm 删掉，记录改成删除", async () => {
  drive.tree.addFile(E01, { size: 100 });
  const local = localFile("某剧/S01/E01.strm");
  targets = { "/local/media/某剧/S01": [{ name: "E01.mkv", size: 100 }] };
  saveCopies([rec({ id: "r1", nodeId: drive.tree.get(E01)!.id })]);
  const r = await go({ ids: ["r1"], afterCopy: "delete", allowDelete: true });
  assert.equal(r.afterCopy, "delete");
  assert.equal(r.done, 1);
  assert.equal(r.items[0].outcome, "deleted");
  assert.equal(drive.calls.remove, 1);
  assert.equal(drive.calls.move, 0);
  assert.equal(drive.tree.get(E01), undefined);
  assert.equal(fs.existsSync(local), false);
  const [c] = listCopies();
  assert.equal(c.afterCopy, "delete");
  assert.equal(c.detail, "复制完成（事后删除）；网盘上那份已删，本地 strm 也删了");
});

test("归档碰上网盘超时：源和本地 strm 不动，记成稍后再做并把循环拉起来；到点循环挪成，不发通知", async () => {
  drive.tree.addFile(E01, { size: 100 });
  const local = localFile("某剧/S01/E01.strm");
  targets = { "/local/media/某剧/S01": [{ name: "E01.mkv", size: 100 }] };
  saveCopies([rec({ id: "r1", nodeId: drive.tree.get(E01)!.id })]);
  drive.failWriteOn = (op) => (op === "move" ? timeoutError() : null);
  const r = await go({ ids: ["r1"] });
  assert.equal(r.done, 0);
  assert.equal(r.items[0].outcome, "retrying");
  assert.match(r.items[0].detail ?? "", /归档源文件没成（网盘接口 30 秒没有回应）/);
  assert.ok(drive.tree.get(E01) && fs.existsSync(local), "没成就都不动");
  const [c] = listCopies();
  assert.equal(c.status, "done");
  assert.equal(c.afterCopy, "archive");
  assert.deepEqual(c.afterRetry && { attempts: c.afterRetry.attempts, nextAt: c.afterRetry.nextAt }, { attempts: 1, nextAt: now + 60_000 });
  assert.match(c.detail, /1 分钟后自动再试（1\/3）/);
  assert.equal(hasCopyWork(), true, "循环有活了");
  await stopCopyWatcher();

  drive.failWriteOn = null;
  now += 61_000;
  await tickCopies();
  const done = listCopies()[0];
  assert.equal(done.afterRetry, undefined);
  assert.equal(done.detail, "复制完成；网盘上那份已归档到 /tv/归档/某剧/S01，本地 strm 也删了");
  assert.ok(drive.tree.get("/tv/归档/某剧/S01/E01.mkv"));
  assert.equal(fs.existsSync(local), false);
  assert.equal(notified.length, 0, "重试成了不发通知");
});
