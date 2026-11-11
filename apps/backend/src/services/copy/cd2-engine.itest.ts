/**
 * 复制队列换成 CloudDrive2 引擎，对着假 gRPC 服务（test/fake-cd2.ts）跑真引擎：
 * 登记 → 列源目录 → 建目标目录 → CopyFile → 盯 GetCopyTasks → 完成；Failed 带原因；任务从列表里消失但目标里有了算完成；
 * 两个条目一批提交。网盘那侧是 FakeDrive，OpenList 一个字节都不碰。CD2 的连接来自账号表里的 CD2 账号（设置里选的那个）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/cd2-engine.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { events, type FilesLandedEvent } from "../events.js";
import { FakeCd2 } from "../../test/fake-cd2.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { __test_resetCd2Tokens } from "../cd2/client.js";
import { __test_resetCopy, enqueueCopy, listCopies, setCopyServiceDeps, stopCopyWatcher, tickCopies } from "./service.js";

const fake = new FakeCd2();
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const drive = new FakeDrive("115", account);
let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; openlistCopy: AppSettings["openlistCopy"]; cd2: AppSettings["cd2"] };
/** 和假服务一样用真实时钟：CopyTask 的 endTime 是假服务按真实时间写的，队列按提交时间过滤它 */
let now = Date.now();
/** 队列看到的任务表（复制完找「目标目录落在哪个任务下」用）；默认没有任务 */
let tasks: TaskDefinition[] = [];
const landed: FilesLandedEvent[] = [];
events.on("files.landed", (input) => {
  landed.push(input);
});

async function copyThrough(sources: string[]): Promise<void> {
  enqueueCopy({ account: "acc", sources, rootPath: "/tv", taskId: "t1", trigger: "manual" });
  await stopCopyWatcher();
  now += 30_000;
  await tickCopies(); // 阶段一：源在 CD2 里可见 → 建目标目录 → CopyFile
}

before(async () => {
  baseline = { accounts: listAccounts(), tasks: listTasks(), openlistCopy: readAppSettings().openlistCopy, cd2: readAppSettings().cd2 };
  await fake.start();
  replaceAccounts([account, { accountType: "cd2", name: "nas-cd2", url: fake.url, apiToken: "api-token" }]);
  replaceTasks([]);
  patchAppSettings({ openlistCopy: { engine: "cd2", dstDir: "/hdd/media" }, cd2: { account: "nas-cd2", mounts: { acc: "/115" } } });
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  setCopyServiceDeps({ notify: async () => {}, now: () => now, embyRefresh: () => {}, listTasks: () => tasks });
});

beforeEach(async () => {
  await __test_resetCopy();
  __test_resetCd2Tokens();
  fake.reset();
  tasks = [];
  landed.length = 0;
  fake.tree = { "/": ["115/", "hdd/"], "/115": ["tv/"], "/115/tv": ["某剧/"], "/115/tv/某剧": ["S01/"], "/115/tv/某剧/S01": ["E01.mkv", "E02.mkv"], "/hdd": ["media/"], "/hdd/media": [] };
  drive.tree.nodes.clear();
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E02.mkv");
});

after(async () => {
  await __test_resetCopy();
  await fake.stop();
  setCopyServiceDeps(null);
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
  patchAppSettings({ openlistCopy: baseline.openlistCopy, cd2: baseline.cd2 });
});

test("一条文件：列源目录（forceRefresh）→ 逐级建目标目录 → CopyFile → 盯任务到 Completed → done；说明里写的是 CloudDrive2", async () => {
  await copyThrough(["/tv/某剧/S01/E01.mkv"]);
  let [c] = listCopies();
  assert.equal(c.status, "pending");
  assert.equal(c.stage, "copying");
  assert.match(c.detail, /已提交 CloudDrive2 复制/);
  assert.deepEqual(fake.copyRequests, [{ sources: ["/115/tv/某剧/S01/E01.mkv"], dest: "/hdd/media/某剧/S01" }], "源路径按 CD2 映射换算，目标按任务目录的层级落到 dstDir 下");
  assert.deepEqual(fake.tree["/hdd/media/某剧/S01"], [], "目标目录链建出来了");
  assert.ok(fake.calls.some((x) => x.method === "GetSubFiles" && x.path === "/115/tv/某剧/S01" && x.forceRefresh), "列源目录绕过 CD2 缓存");
  assert.ok(!fake.calls.some((x) => x.method === "GetToken"), "API 令牌直接用");

  await tickCopies(); // 阶段二：任务还在跑
  [c] = listCopies();
  assert.equal(c.status, "pending");
  assert.match(c.detail, /CloudDrive2 复制中 0%/);

  fake.advanceCopies();
  await tickCopies();
  [c] = listCopies();
  assert.equal(c.status, "done");
  assert.equal(c.detail, "复制完成");
  assert.deepEqual(fake.tree["/hdd/media/某剧/S01"], ["E01.mkv"]);
});

test("两个条目同一目录：一次 CopyFile 带两个源路径，各自对各自的任务；一个 Failed 带 CD2 的错误原文，另一个完成", async () => {
  await copyThrough(["/tv/某剧/S01/E01.mkv", "/tv/某剧/S01/E02.mkv"]);
  assert.deepEqual(fake.copyRequests, [{ sources: ["/115/tv/某剧/S01/E01.mkv", "/115/tv/某剧/S01/E02.mkv"], dest: "/hdd/media/某剧/S01" }]);
  fake.failSources.set("/115/tv/某剧/S01/E02.mkv", "quota exceeded");
  fake.advanceCopies();
  await tickCopies();
  const byName = Object.fromEntries(listCopies().map((c) => [c.name, c]));
  assert.equal(byName["E01.mkv"]!.status, "done");
  assert.equal(byName["E02.mkv"]!.status, "failed");
  assert.match(byName["E02.mkv"]!.detail, /CloudDrive2 复制失败：quota exceeded/);
});

test("CD2 把完成的任务从列表里拿掉了：任务列表里找不到，但目标里已经有了这一份 → 按目标核对算完成", async () => {
  fake.dropCompleted = true;
  await copyThrough(["/tv/某剧/S01/E01.mkv"]);
  fake.advanceCopies();
  assert.equal(fake.copyTasks.length, 0, "任务已经不在 CD2 的列表里");
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "done");
  assert.match(c.detail, /目标里核对到了这一份/);
});

test("任务列表里找不到、目标里也没有：记一次没找到，下轮再看", async () => {
  await copyThrough(["/tv/某剧/S01/E01.mkv"]);
  fake.copyTasks = [];
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "pending");
  assert.equal(c.misses, 1);
  assert.match(c.detail, /CloudDrive2 任务列表里暂时没找到这次复制（1\//);
});

test("CopyFile 本身被拒（success=false）：这一轮退回排队并带上 CD2 的原话", async () => {
  fake.failNextCopy = "disk full";
  await copyThrough(["/tv/某剧/S01/E01.mkv"]);
  const [c] = listCopies();
  assert.equal(c.status, "pending");
  assert.equal(c.stage, "waiting");
  assert.match(c.detail, /提交 CloudDrive2 复制失败，稍后重试（1\/\d+）：CD2 CopyFile 失败：disk full/);
});

test("CD2 的任务 id 是「源→目标」：上一轮同一条留在列表里的旧任务（早就结束）不算这次的结果，等这次的任务完成才算", async () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  fake.copyTasks.push(
    { sourcePath: "/115/tv/某剧/S01/E01.mkv", destPath: "/hdd/media/某剧/S01", status: 4, totalFiles: 1, uploadedFiles: 0, failedFiles: 1, errors: ["old failure"], endedAt: old },
    { sourcePath: "/115/tv/某剧/S01/E02.mkv", destPath: "/hdd/media/某剧/S01", status: 3, totalFiles: 1, uploadedFiles: 1, failedFiles: 0, errors: [], endedAt: old },
  );
  await copyThrough(["/tv/某剧/S01/E01.mkv", "/tv/某剧/S01/E02.mkv"]);
  await tickCopies();
  let byName = Object.fromEntries(listCopies().map((c) => [c.name, c]));
  assert.equal(byName["E01.mkv"]!.status, "pending", "旧的 Failed 不算这次失败");
  assert.equal(byName["E02.mkv"]!.status, "pending", "旧的 Completed 不算这次完成，也不会提前去删源");
  assert.match(byName["E01.mkv"]!.detail, /复制中/);
  fake.advanceCopies();
  await tickCopies();
  byName = Object.fromEntries(listCopies().map((c) => [c.name, c]));
  assert.equal(byName["E01.mkv"]!.status, "done");
  assert.equal(byName["E02.mkv"]!.status, "done");
});

test("令牌没有「获取传输任务」权限（GetCopyTasks 被拒）：不卡死，改按目标目录核对，文件落了就算完成", async () => {
  fake.denyCopyTasks = true;
  await copyThrough(["/tv/某剧/S01/E01.mkv"]);
  await tickCopies();
  let [c] = listCopies();
  assert.equal(c.status, "pending");
  assert.match(c.detail, /读不到 CloudDrive2 的复制任务列表（.*permission required.*），改按目标目录核对：目标里没看到这一份/);
  fake.advanceCopies();
  await tickCopies();
  [c] = listCopies();
  assert.equal(c.status, "done");
  assert.match(c.detail, /任务列表读不到，按目标目录核对到了这一份/);
});

test("目标目录在某个 CD2 账号任务的目录下：复制完给那个任务发 files.landed（听它的是自动整理和目录缓存刷新）；别的账号的任务、没罩住目标的任务不发", async () => {
  const cd2Task = { id: "cd2-media", account: "nas-cd2", originPath: "/hdd/media", targetPath: "media", strmPrefix: "/mnt/cd2" } as TaskDefinition;
  tasks = [
    cd2Task,
    { id: "cd2-other", account: "nas-cd2", originPath: "/hdd/other", targetPath: "other", strmPrefix: "/mnt/cd2" } as TaskDefinition,
    { id: "drive-task", account: "acc", originPath: "/hdd/media", targetPath: "x", strmPrefix: "/mnt/x" } as TaskDefinition,
  ];
  await copyThrough(["/tv/某剧/S01/E01.mkv"]);
  assert.equal(landed.length, 0, "还没复制完");
  fake.advanceCopies();
  await tickCopies();
  assert.equal(listCopies()[0]?.status, "done");
  assert.deepEqual(
    landed.map((l) => [l.task.id, l.paths, l.trigger]),
    [["cd2-media", ["某剧/S01/E01.mkv"], "copy"]],
  );
});
