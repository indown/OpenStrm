/**
 * 清理归档：走真的 Provider（FakeDrive）。
 * 列归档目录一层（不存在 / 空 / 目录在前带大小和时间）；按 paths 删文件和目录（「归档/」前缀、重复、父子路径）；all 删光一层但留着目录本身；
 * 没有的记 missing；各种拒绝一条都不动；网络问题停手、修好再来；单条被拒不影响别的。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/archive-clean.itest.ts
 */
import assert from "node:assert/strict";
import { AxiosError } from "axios";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { CLEAN_MAX, cleanArchive, listArchive, uniqueArchivePaths, type CleanRequest } from "./archive-clean.js";

const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "tv", targetPath: "copy-archive-clean-itest/tv", strmPrefix: "/mnt" };

let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[] };
let drive: FakeDrive;
const timeoutError = () => new AxiosError("timeout of 30000ms exceeded", "ECONNABORTED", { timeout: 30_000, headers: {} } as never);

const A = "/tv/归档";
const go = (over: Partial<CleanRequest>) => cleanArchive({ task, ...over });
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
  baseline = { accounts: listAccounts(), tasks: listTasks() };
  replaceAccounts([account]);
  replaceTasks([task]);
});

beforeEach(() => {
  drive = new FakeDrive("quark", account);
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
});

after(() => {
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
});

test("列归档：目录不存在当空的、空目录也是空的；有东西时只列一层，目录在前、再按名字，文件带大小、有时间的带时间", async () => {
  drive.tree.addDir("/tv");
  assert.deepEqual(await listArchive(task), { archiveDir: A, exists: false, items: [] });
  drive.tree.addDir(A);
  assert.deepEqual(await listArchive(task), { archiveDir: A, exists: true, items: [] });

  drive.tree.addFile(`${A}/某剧/S01/E01.mkv`, { size: 100 });
  drive.tree.addFile(`${A}/zz.mkv`, { size: 7, modifiedAt: 1_700_000_000_000 });
  drive.tree.addFile(`${A}/aa.mkv`, { size: 9 });
  // 夸克的目录条目带 size: 0，不是真的大小：列表里目录不给大小
  drive.tree.addDir(`${A}/别的剧`, { modifiedAt: 1_700_000_001_000, size: 0 });
  const r = await listArchive(task);
  assert.equal(r.exists, true);
  assert.deepEqual(r.items, [
    { path: "别的剧", name: "别的剧", isDir: true, modifiedAt: 1_700_000_001_000 },
    { path: "某剧", name: "某剧", isDir: true },
    { path: "aa.mkv", name: "aa.mkv", isDir: false, size: 9 },
    { path: "zz.mkv", name: "zz.mkv", isDir: false, size: 7, modifiedAt: 1_700_000_000_000 },
  ]);
  assert.equal(drive.calls.remove, 0, "只看不改");
});

test("路径归一：相对归档目录；「归档/」前缀剥掉；重复只算一次；父目录在了子路径不单列；归档目录本身、.. 拒", () => {
  assert.deepEqual(uniqueArchivePaths(["某剧/S01", "归档/某剧", "某剧", "/aa.mkv/", "归档/aa.mkv"]), ["某剧", "aa.mkv"]);
  assert.throws(() => uniqueArchivePaths([]), /要删哪些没说/);
  assert.throws(() => uniqueArchivePaths(["归档"]), /归档目录本身/);
  assert.throws(() => uniqueArchivePaths(["/"]), /归档目录本身/);
  assert.throws(() => uniqueArchivePaths(["../x"]), /\.\./);
  assert.throws(() => uniqueArchivePaths(Array.from({ length: CLEAN_MAX + 1 }, (_, i) => `x${i}`)), /最多/);
});

test("按 paths 删：文件和整个目录（子项跟着没了）、「归档/」前缀也认；没有的记 missing；归档目录本身和别的条目不动；进度按要删的条数报", async () => {
  drive.tree.addFile(`${A}/某剧/S01/E01.mkv`, { size: 100 });
  drive.tree.addFile(`${A}/某剧/S02/E01.mkv`);
  drive.tree.addFile(`${A}/lone.mkv`, { size: 9 });
  drive.tree.addFile(`${A}/留着.mkv`);
  drive.tree.addFile("/tv/某剧/S03/E01.mkv");
  const progress: Array<[number, number]> = [];
  const r = await go({ paths: ["归档/某剧", "lone.mkv", "没有的/E01.mkv", "某剧/S01"], onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(r.done, 2);
  assert.equal(r.archiveDir, A);
  assert.deepEqual(r.items, [
    { path: "某剧", name: "某剧", isDir: true, outcome: "deleted" },
    { path: "lone.mkv", name: "lone.mkv", isDir: false, size: 9, outcome: "deleted" },
    { path: "没有的/E01.mkv", name: "E01.mkv", outcome: "missing", detail: "归档里没有这条路径（可能已经删掉或挪走了）" },
  ]);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.equal(drive.tree.get(`${A}/某剧`), undefined);
  assert.equal(drive.tree.get(`${A}/某剧/S02/E01.mkv`), undefined, "子项跟着没了");
  assert.equal(drive.tree.get(`${A}/lone.mkv`), undefined);
  assert.ok(drive.tree.get(`${A}/留着.mkv`) && drive.tree.get(A), "没选的和归档目录本身都在");
  assert.ok(drive.tree.get("/tv/某剧/S03/E01.mkv"), "任务目录里同名的作品不受影响");
  assert.equal(drive.calls.remove, 2);
  assert.equal(drive.calls.move, 0);
});

test("all：删光归档目录这一层，目录本身留着；归档目录不存在时什么都不做；再来一次是空的", async () => {
  drive.tree.addDir("/tv");
  assert.deepEqual(await go({ all: true }), { done: 0, archiveDir: A, items: [] });

  drive.tree.addFile(`${A}/某剧/S01/E01.mkv`);
  drive.tree.addFile(`${A}/lone.mkv`, { size: 9 });
  const r = await go({ all: true });
  assert.equal(r.done, 2);
  assert.deepEqual(r.items.map((i) => [i.path, i.isDir, i.outcome]), [["某剧", true, "deleted"], ["lone.mkv", false, "deleted"]]);
  assert.ok(drive.tree.get(A), "归档目录本身留着");
  assert.equal(drive.tree.children(A).length, 0);
  assert.deepEqual(await go({ all: true }), { done: 0, archiveDir: A, items: [] });
});

test("拒绝：paths 空、太多、..、归档目录本身、paths + all 一起给；网盘不支持写——拒绝的一条都不动", async () => {
  drive.tree.addFile(`${A}/lone.mkv`);
  await rejects(go({}), 400, "VALIDATION", /要删哪些没说/);
  await rejects(go({ paths: [] }), 400, "VALIDATION", /要删哪些没说/);
  await rejects(go({ paths: Array.from({ length: CLEAN_MAX + 1 }, (_, i) => `x${i}`) }), 400, "VALIDATION", /最多/);
  await rejects(go({ paths: ["../x"] }), 400, "VALIDATION", /\.\./);
  await rejects(go({ paths: [""] }), 400, "VALIDATION", /归档目录本身/);
  await rejects(go({ paths: ["归档"] }), 400, "VALIDATION", /归档目录本身/);
  await rejects(go({ paths: ["lone.mkv"], all: true }), 400, "VALIDATION", /二选一/);
  const readOnly = new FakeDrive("quark", account, { write: false });
  readOnly.tree.addFile(`${A}/lone.mkv`);
  setDriveProviderFactory((a) => (a.name === "acc" ? readOnly : null));
  await rejects(go({ paths: ["lone.mkv"] }), 400, "UNSUPPORTED", /不支持删除/);
  await rejects(go({ all: true }), 400, "UNSUPPORTED");
  assert.ok(drive.tree.get(`${A}/lone.mkv`) && readOnly.tree.get(`${A}/lone.mkv`), "一条都没动");
  assert.equal(drive.calls.remove + readOnly.calls.remove, 0);
});

test("网络问题：第一阶段网盘读不到整个请求都不动；第二阶段删的时候超时，那条记失败、后面的不试，修好再来（已经删掉的记 missing）", async () => {
  drive.tree.addFile(`${A}/a.mkv`);
  drive.tree.addFile(`${A}/b.mkv`);
  drive.tree.addFile(`${A}/c.mkv`);
  drive.failWith = timeoutError();
  await assert.rejects(go({ paths: ["a.mkv"] }), /timeout/);
  await assert.rejects(listArchive(task), /timeout/);
  drive.failWith = null;
  assert.ok(drive.tree.get(`${A}/a.mkv`), "没动");

  let removes = 0;
  drive.failWriteOn = (op) => (op === "remove" && ++removes === 2 ? timeoutError() : null);
  const r = await go({ paths: ["a.mkv", "b.mkv", "c.mkv"] });
  assert.equal(r.done, 1);
  assert.deepEqual(r.items.map((i) => [i.path, i.outcome]), [["a.mkv", "deleted"], ["b.mkv", "failed"], ["c.mkv", "skipped"]]);
  assert.equal(r.items[1].detail, "删除没成：网盘接口 30 秒没有回应");
  assert.match(r.items[2].detail ?? "", /前面一条碰上网络问题（网盘接口 30 秒没有回应），这条没试/);
  assert.ok(!drive.tree.get(`${A}/a.mkv`) && drive.tree.get(`${A}/b.mkv`) && drive.tree.get(`${A}/c.mkv`));

  drive.failWriteOn = null;
  const again = await go({ paths: ["a.mkv", "b.mkv", "c.mkv"] });
  assert.equal(again.done, 2);
  assert.deepEqual(again.items.map((i) => i.outcome), ["missing", "deleted", "deleted"]);
  assert.equal(drive.tree.children(A).length, 0);
});

test("不是网络问题的单条失败（网盘拒了这一个）：那条记失败，别的照常删", async () => {
  drive.tree.addFile(`${A}/a.mkv`);
  drive.tree.addFile(`${A}/b.mkv`);
  drive.failWriteOn = (op, p) => (op === "remove" && p.endsWith("a.mkv") ? new Error("这个文件被锁住了") : null);
  const r = await go({ all: true });
  assert.equal(r.done, 1);
  assert.deepEqual(r.items.map((i) => [i.path, i.outcome, i.detail]), [
    ["a.mkv", "failed", "删除没成：这个文件被锁住了"],
    ["b.mkv", "deleted", undefined],
  ]);
  assert.ok(drive.tree.get(`${A}/a.mkv`) && !drive.tree.get(`${A}/b.mkv`));
});
