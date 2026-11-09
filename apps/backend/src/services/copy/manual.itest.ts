/**
 * 手动发起「复制到 OpenList」：到网盘核对路径、目标里已有同名目录时只补缺的、各种拒绝。假网盘 + OpenList 桩。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/manual.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { events } from "../events.js";
import { __test_resetAutoOrganize, startAutoOrganize } from "../organize/auto.js";
import { OpenlistError } from "../openlist/client.js";
import { FakeDrive, withoutWalk } from "../../test/fake-drive.js";
import { enqueueManualCopy, MANUAL_PATHS_MAX } from "./manual.js";
import { __test_resetCopy, enqueueCopy, listCopies, setCopyServiceDeps, stopCopyWatcher } from "./service.js";

const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const ol: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
/** 任务开着复制、复制完归档 */
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "tv", targetPath: "manual-itest/tv", strmPrefix: "/mnt", copyToOpenlist: { enabled: true, afterCopy: "archive" } };
const COPY_SETTINGS = { account: "ol", dstDir: "/local/media", mounts: { acc: "/quark" } };

let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; openlistCopy: AppSettings["openlistCopy"]; tmdb: AppSettings["tmdb"] };
let drive: FakeDrive;
/** OpenList 目标目录里现有的条目名；没有的目录当「还没建」 */
let names: Record<string, string[]> = {};
const listed: string[] = [];
/** 设了就让列 OpenList 目录一律报这个错（模拟 OpenList 挂了 / 超时） */
let listOutage: Error | null = null;

before(() => {
  startAutoOrganize();
  baseline = { accounts: listAccounts(), tasks: listTasks(), openlistCopy: readAppSettings().openlistCopy, tmdb: readAppSettings().tmdb };
  replaceAccounts([account, ol]);
  setCopyServiceDeps({
    openlist: {
      listNames: async (_cfg, dir) => {
        listed.push(dir);
        if (listOutage) throw listOutage;
        if (names[dir]) return names[dir];
        // OpenList 对不存在的目录就是这么说的（不是连不上）
        throw new OpenlistError("failed get objs: failed get dir: object not found", 500, false);
      },
      mkdir: async () => {},
      copy: async () => [],
      copyTasks: async () => ({ undone: [], done: [] }),
    },
    notify: async () => {},
  });
});

beforeEach(async () => {
  await __test_resetCopy();
  __test_resetAutoOrganize();
  names = {};
  listed.length = 0;
  listOutage = null;
  drive = new FakeDrive("quark", account);
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E02.mkv");
  drive.tree.addFile("/tv/某剧/S02/E01.mkv");
  drive.tree.addFile("/tv/电影.mkv");
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  replaceTasks([task]);
  patchAppSettings({ openlistCopy: COPY_SETTINGS, tmdb: { apiKey: "k" } });
});

after(async () => {
  await __test_resetCopy();
  __test_resetAutoOrganize();
  setCopyServiceDeps(null);
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
  patchAppSettings({ openlistCopy: baseline.openlistCopy, tmdb: baseline.tmdb });
});

const go = (paths: string[], over: Partial<Parameters<typeof enqueueManualCopy>[0]> = {}) => enqueueManualCopy({ task, paths, allowDelete: true, ...over });
const rows = () =>
  listCopies()
    .map((c) => ({ path: `${c.srcDir}/${c.name}`, isDir: c.isDir, nodeId: c.nodeId, dstDir: c.dstDir, afterCopy: c.afterCopy, trigger: c.trigger }))
    .sort((a, b) => a.path.localeCompare(b.path));
const rejects = async (p: Promise<unknown>, status: number, code: string, message?: RegExp) => {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof HttpError, String(err));
    assert.equal(err.status, status, err.message);
    assert.equal(err.extra.code, code, err.message);
    if (message) assert.match(err.message, message);
    return true;
  });
};

test("整目录：目标里还没有就整条登记，带节点 id 和目录标记，来源是手动，去向跟任务", async () => {
  const r = await go(["某剧"]);
  await stopCopyWatcher();
  assert.equal(r.queued, 1);
  assert.deepEqual(r.items, [{ path: "某剧", outcome: "queued", queued: 1, isDir: true }]);
  assert.equal(r.dstDir, "/local/media");
  assert.equal(r.afterCopy, "archive");
  assert.equal(r.deleteSource, false);
  assert.deepEqual(rows(), [{ path: "/tv/某剧", isDir: true, nodeId: drive.tree.get("/tv/某剧")!.id, dstDir: "/local/media", afterCopy: "archive", trigger: "manual" }]);
  assert.deepEqual(listed, ["/local/media"], "只看了一眼目标目录里有没有同名的");
});

test("补齐：目标里已经有同名目录，只补缺的文件和子目录；都齐了就不登记", async () => {
  names["/local/media"] = ["某剧"];
  names["/local/media/某剧"] = ["S01"];
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  const r = await go(["某剧"]);
  await stopCopyWatcher();
  assert.deepEqual(r.items, [{ path: "某剧", outcome: "filled", queued: 2, isDir: true }]);
  assert.deepEqual(rows(), [
    { path: "/tv/某剧/S01/E02.mkv", isDir: false, nodeId: drive.tree.get("/tv/某剧/S01/E02.mkv")!.id, dstDir: "/local/media/某剧/S01", afterCopy: "archive", trigger: "manual" },
    { path: "/tv/某剧/S02", isDir: true, nodeId: drive.tree.get("/tv/某剧/S02")!.id, dstDir: "/local/media/某剧", afterCopy: "archive", trigger: "manual" },
  ]);
  assert.deepEqual([...listed].sort(), ["/local/media", "/local/media/某剧", "/local/media/某剧/S01"], "目标里有的子目录才往下列，缺的整目录登记不再列");

  await __test_resetCopy();
  names["/local/media/某剧"] = ["S01", "S02"];
  names["/local/media/某剧/S01"] = ["E01.mkv", "E02.mkv"];
  names["/local/media/某剧/S02"] = ["E01.mkv"];
  const full = await go(["某剧"]);
  assert.equal(full.queued, 0);
  assert.deepEqual(full.items, [{ path: "某剧", outcome: "complete", queued: 0, isDir: true }]);
  assert.equal(full.reason, "目标里已经都有了");
  assert.equal(listCopies().length, 0);
});

test("文件：目标里已经有同名的跳过，没有的登记，网盘上没有的说不存在", async () => {
  names["/local/media"] = ["电影.mkv"];
  const r = await go(["电影.mkv", "某剧/S01/E01.mkv", "没有的.mkv"]);
  await stopCopyWatcher();
  assert.equal(r.queued, 1);
  assert.deepEqual(
    r.items.map((i) => [i.path, i.outcome, i.queued]),
    [
      ["电影.mkv", "exists", 0],
      ["某剧/S01/E01.mkv", "queued", 1],
      ["没有的.mkv", "missing", 0],
    ],
  );
  assert.deepEqual(rows().map((c) => [c.path, c.dstDir, c.isDir]), [["/tv/某剧/S01/E01.mkv", "/local/media/某剧/S01", false]]);
});

test("115 式（没有 walkSubtree）：补齐从文件路径推目录，节点 id 留到提交时再钉", async () => {
  const noWalk = withoutWalk(drive);
  setDriveProviderFactory((a) => (a.name === "acc" ? noWalk : null));
  names["/local/media"] = ["某剧"];
  names["/local/media/某剧"] = ["S01"];
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  const r = await go(["某剧"]);
  await stopCopyWatcher();
  assert.deepEqual(r.items, [{ path: "某剧", outcome: "filled", queued: 2, isDir: true }]);
  assert.deepEqual(rows().map((c) => [c.path, c.isDir, c.nodeId]), [
    ["/tv/某剧/S01/E02.mkv", false, undefined],
    ["/tv/某剧/S02", true, undefined],
  ]);
});

test("拒绝：任务目录本身、带 ..、暂存区、太多条、目标目录越界、复制没配好、任务正在整理", async () => {
  await rejects(go([""]), 400, "VALIDATION", /任务目录本身/);
  await rejects(go(["某剧/../电影.mkv"]), 400, "VALIDATION", /\.\./);
  await rejects(go(["归档/某剧"]), 400, "VALIDATION", /暂存区/);
  await rejects(go(["重复文件"]), 400, "VALIDATION", /暂存区/);
  await rejects(go(Array.from({ length: MANUAL_PATHS_MAX + 1 }, (_, i) => `x${i}`)), 400, "VALIDATION", /最多/);
  await rejects(go(["某剧"], { dstDir: "/elsewhere" }), 400, "COPY_DST_INVALID", /只能是/);
  assert.equal(listCopies().length, 0, "拒绝的一条都不登记");

  // 目标目录下面的子目录可以
  const sub = await go(["某剧"], { dstDir: "/local/media/精选/" });
  await stopCopyWatcher();
  assert.equal(rows()[0].dstDir, "/local/media/精选");

  patchAppSettings({ openlistCopy: { ...COPY_SETTINGS, mounts: {} } });
  await rejects(go(["某剧"]), 400, "COPY_NOT_READY", /挂载根/);
  patchAppSettings({ openlistCopy: COPY_SETTINGS });

  // 攒着一次会直接执行的自动整理：整理会改名挪目录，这时不登记
  events.emit("files.landed", { task: { ...task, organize: { mode: "auto" } }, paths: ["某剧"], trigger: "share", debounce: true });
  await rejects(go(["电影.mkv"]), 409, "TASK_ORGANIZING", /正在整理/);
  __test_resetAutoOrganize();
  assert.equal(sub.queued, 1);
});

test("目标目录的 OpenList 根 / 算没填：这一次指定成 / 的拒；设置页填的是 / 就是没有目标目录，任务上填了具体目录的照常", async () => {
  await rejects(go(["某剧"], { dstDir: "/" }), 400, "COPY_DST_INVALID", /不能是根 \//);
  patchAppSettings({ openlistCopy: { ...COPY_SETTINGS, dstDir: "/" } });
  await rejects(go(["某剧"]), 400, "COPY_NOT_READY", /设置页填的是根 \/，等于没填/);
  assert.equal(listCopies().length, 0);

  const r = await enqueueManualCopy({ task: { ...task, copyToOpenlist: { ...task.copyToOpenlist, dstDir: "/hhd/tv" } }, paths: ["某剧"], allowDelete: true });
  await stopCopyWatcher();
  assert.equal(r.dstDir, "/hhd/tv");
  assert.deepEqual(rows().map((c) => [c.path, c.dstDir]), [["/tv/某剧", "/hhd/tv"]]);
});

test("去向：不给按任务设置（任务没开复制就是不动），给了按给的；落到「删除」的要调用方允许，按任务设置落到的也一样", async () => {
  const off = await go(["电影.mkv"], { task: { ...task, copyToOpenlist: { enabled: false, afterCopy: "delete" } } });
  await stopCopyWatcher();
  assert.equal(off.afterCopy, "keep", "任务没开复制：一次性发起的不认任务上留着的去向");
  assert.equal(rows()[0].afterCopy, "keep");

  await __test_resetCopy();
  const del = await go(["电影.mkv"], { afterCopy: "delete" });
  await stopCopyWatcher();
  assert.equal(del.afterCopy, "delete");
  assert.equal(del.deleteSource, true);
  assert.equal(rows()[0].afterCopy, "delete");

  await __test_resetCopy();
  const deleting = { ...task, copyToOpenlist: { enabled: true, afterCopy: "delete" as const } };
  await rejects(go(["电影.mkv"], { task: deleting, allowDelete: false }), 403, "INSUFFICIENT_SCOPE", /删除/);
  await rejects(go(["电影.mkv"], { afterCopy: "delete", allowDelete: false }), 403, "INSUFFICIENT_SCOPE");
  assert.equal(listCopies().length, 0, "拒了就一条都不登记");
  const archived = await go(["电影.mkv"], { task: deleting, afterCopy: "archive", allowDelete: false });
  await stopCopyWatcher();
  assert.equal(archived.afterCopy, "archive", "改成归档就不用删除权限");
});

test("回话里的去向按真会发生的说：已经排着一条要删源的，这次要归档也没再排，说的是删除", async () => {
  enqueueCopy({ account: "acc", sources: [{ path: "/tv/电影.mkv", nodeId: "s1" }], rootPath: "/tv", taskId: "t1", trigger: "share", afterCopy: "delete" });
  await stopCopyWatcher();
  const r = await go(["电影.mkv"], { afterCopy: "archive" });
  assert.equal(r.queued, 0);
  assert.equal(r.items[0].outcome, "duplicate");
  assert.equal(r.afterCopy, "delete", "排着的那条会删源，不能说成归档");
  assert.equal(r.deleteSource, true);
});

test("整目录复制还没提交时，里面的路径不单独登记（会被它带过去）；一次里父目录和子路径都选了只登记父目录", async () => {
  enqueueCopy({ account: "acc", sources: [{ path: "/tv/某剧", isDir: true, nodeId: "d1" }], rootPath: "/tv", taskId: "t1", trigger: "share", afterCopy: "archive" });
  await stopCopyWatcher();
  const inside = await go(["某剧/S01/E01.mkv"]);
  assert.equal(inside.queued, 0);
  assert.deepEqual(inside.items, [{ path: "某剧/S01/E01.mkv", outcome: "covered", queued: 0, isDir: false }]);
  assert.match(inside.reason ?? "", /整目录的复制会把它们一起带过去/);
  assert.equal(listCopies().length, 1);

  await __test_resetCopy();
  const both = await go(["某剧/S01", "某剧", "某剧/S02/E01.mkv"]);
  await stopCopyWatcher();
  assert.deepEqual(both.items.map((i) => [i.path, i.outcome]), [["某剧", "queued"]], "子路径去掉，只剩父目录");
  assert.equal(listCopies().length, 1);
});

test("目录名带尾空格：路径不削空格，按网盘上真实的名字登记", async () => {
  drive.tree.addFile("/tv/Show/Season 1 /E01.mkv");
  const r = await go(["Show/Season 1 /E01.mkv"]);
  await stopCopyWatcher();
  assert.equal(r.queued, 1, JSON.stringify(r.items));
  assert.equal(rows()[0].path, "/tv/Show/Season 1 /E01.mkv");
  assert.equal(rows()[0].dstDir, "/local/media/Show/Season 1 ");
});

test("OpenList 连不上（不是「没有这个目录」）：整个请求报错、一条都不登记，不把它猜成目标里还没有", async () => {
  listOutage = new OpenlistError("connect ECONNREFUSED", 0, true);
  await assert.rejects(go(["电影.mkv", "某剧"]), (err: unknown) => err instanceof HttpError && /读 OpenList/.test(err.message));
  assert.equal(listCopies().length, 0, "前一条路径也不能先登记上");
});

test("再发一次：已经排着的算重复，不再登记；手动登记的整目录会把随后监控按文件报上来的并进来", async () => {
  await go(["某剧"]);
  const again = await go(["某剧"]);
  assert.equal(again.queued, 0);
  assert.deepEqual(again.items, [{ path: "某剧", outcome: "duplicate", queued: 0, isDir: true }]);
  assert.match(again.reason ?? "", /已经在队列里/);
  const monitor = enqueueCopy({ account: "acc", sources: [{ path: "/tv/某剧/S01/E01.mkv", nodeId: "m1" }], rootPath: "/tv", taskId: "t1", trigger: "monitor" });
  await stopCopyWatcher();
  assert.equal(monitor.queued, 0);
  assert.equal(monitor.covered, 1);
  assert.equal(listCopies().length, 1);
});
