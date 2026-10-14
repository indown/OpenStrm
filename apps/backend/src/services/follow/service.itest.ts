/**
 * 分享追更：分享和网盘换成内存假网盘（test/fake-drive.ts），通知和时间换成桩，直接驱动 checkFollow / tickFollows 验证状态机。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/follow/service.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, OrganizeHint, ShareFollowOrganized, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { getShareFollow, updateShareFollow } from "../../db/repositories/share-follows.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { __test_resetCopy, listCopies } from "../copy/service.js";
import { __test_flushAutoOrganize, __test_resetAutoOrganize, setAutoOrganizeDeps, startAutoOrganize } from "../organize/auto.js";
import { HttpError } from "../../lib/http-error.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { FakeDrive, type FakeTree } from "../../test/fake-drive.js";
import type { NotifyEvent } from "../notify.js";
import {
  __test_resetFollows,
  checkFollow,
  createFollow,
  deleteFollow,
  FOLLOW,
  getFollowWatcherStatus,
  learnFollowOrganized,
  listFollows,
  revertFollowOrganized,
  rewriteFollowSubPaths,
  setFollowServiceDeps,
  startFollowWatcher,
  stopFollowWatcher,
  tickFollows,
  updateFollow,
} from "./service.js";

let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt" };

/** 假网盘：每个用例重建；分享树里的条目带 hash（115 的样子） */
let drive: FakeDrive;
let share: FakeTree;
let notified: NotifyEvent[] = [];
const T0 = 1_800_000_000_000;
let now = T0;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const LOCAL = path.join(DATA_DIR, "tv");

function seed() {
  drive = new FakeDrive("115", account, { share: true, withHash: true });
  // 分享每页只回 2 条，顺便把翻页也走到
  drive.share!.pageSize = 2;
  // 网盘里已经有任务目录和「The Show」这一层（转存落点）
  drive.tree.addDir("/tv/The Show");
  share = drive.share!.define("abc", { title: "The Show", password: "1234" });
  share.addFile("/E01.mkv", { hash: "a" });
  share.addFile("/E02.mkv", { hash: "b" });
  share.addDir("/Extras");
  share.addFile("/Extras/making.mkv", { hash: "x" });
  for (const code of ["other", "other2", "aaa", "bbb"]) {
    const t = drive.share!.define(code, { title: code, password: "1234" });
    t.addFile("/one.mkv", { hash: `${code}-1` });
  }
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
}

const subscribe = (over: Record<string, unknown> = {}) =>
  createFollow({ shareCode: "abc", receiveCode: "1234", watchCid: "0", watchPath: "The Show", scope: [""], taskId: "t1", subPath: "The Show", name: "The Show", ...over });

const events = (type: NotifyEvent["type"]) => notified.filter((e) => e.type === type);
const received = () => drive.share!.calls.receive;
const inDrive = (p: string) => drive.tree.get(p) !== undefined;
const strmExists = (rel: string) => fs.existsSync(path.join(LOCAL, ...rel.split("/")));

before(() => {
  startAutoOrganize();
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceAccounts([account]);
  replaceTasks([task]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [] });
  setFollowServiceDeps({
    notify: async (ev) => {
      notified.push(ev);
    },
    now: () => now,
    random: () => 0.5,
    gapMs: 0,
  });
});

beforeEach(async () => {
  await __test_resetFollows();
  seed();
  notified = [];
  now = T0;
  replaceTasks([task]);
  replaceAccounts([account]);
  fs.rmSync(LOCAL, { recursive: true, force: true });
});

after(async () => {
  await __test_resetFollows();
  setFollowServiceDeps(null);
  setDriveProviderFactory(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(LOCAL, { recursive: true, force: true });
});

test("建订阅：范围内现有的全部记进快照（递归、翻页），不转存，按间隔排下次检查", async () => {
  const s = await subscribe({ intervalMinutes: 60 });
  assert.equal(s.knownCount, 4);
  assert.equal(s.enabled, true);
  assert.equal(s.status, "idle");
  assert.equal(s.nextCheckAt, T0 + HOUR, "random 钉在 0.5，没有抖动");
  assert.deepEqual(drive.share!.log, ["list 0", "list 0@1", `list ${share.get("/Extras")!.id}`], "根目录 3 条要翻两页，Extras 一页");
  assert.equal(received(), 0);
  const full = getShareFollow(s.id)!;
  assert.deepEqual(
    full.known.map((e) => e.path).sort(),
    ["E01.mkv", "E02.mkv", "Extras", "Extras/making.mkv"],
  );
  assert.ok(full.known.every((e) => e.id), "快照带分享内的 id");
  assert.ok(!("known" in s), "summary 不带快照");
});

test("建订阅：同一分享目录 409，任务不存在 404，范围目录都找不到 400，间隔夹在上下限之间", async () => {
  await subscribe();
  await assert.rejects(subscribe(), (err: HttpError) => err.status === 409);
  await assert.rejects(subscribe({ shareCode: "other", taskId: "nope" }), (err: HttpError) => err.status === 404);
  await assert.rejects(subscribe({ shareCode: "other", scope: ["Nope"] }), (err: HttpError) => err.status === 400 && /Nope/.test(err.message));
  const s = await subscribe({ shareCode: "other2", intervalMinutes: 1 });
  assert.equal(s.intervalMinutes, FOLLOW.MIN_INTERVAL_MIN);
});

test("建订阅：分享的网盘和任务账号不同类 400", async () => {
  await assert.rejects(
    createFollow({ shareUrl: "https://pan.quark.cn/s/abcdef?pwd=1234", taskId: "t1", subPath: "x" }),
    (err: HttpError) => err.status === 400 && /夸克网盘的分享/.test(err.message),
  );
});

test("检查：没变化就只更新时间，不转存不通知", async () => {
  const s = await subscribe();
  now += HOUR;
  const { run, follow } = await checkFollow(s.id);
  assert.equal(run, null);
  assert.equal(follow.status, "idle");
  assert.equal(follow.lastCheckedAt, now);
  assert.equal(follow.nextCheckAt, now + FOLLOW.DEFAULT_INTERVAL_MIN * 60_000);
  assert.equal(received(), 0);
  assert.equal(notified.length, 0);
});

test("新集：只转存新的那条到同一位置，生成 strm，记进快照，通知", async () => {
  const s = await subscribe();
  const e3 = share.addFile("/E03.mkv", { hash: "c" });
  now += HOUR;
  const { run, follow } = await checkFollow(s.id);
  assert.equal(received(), 1);
  assert.equal(drive.share!.log.at(-1), `receive ${e3.id} -> ${drive.tree.get("/tv/The Show")!.id}`);
  assert.ok(inDrive("/tv/The Show/E03.mkv"), "转存进了任务目录下的 The Show");
  assert.ok(strmExists("The Show/E03.strm"));
  assert.equal(fs.readFileSync(path.join(LOCAL, "The Show", "E03.strm"), "utf8"), "/mnt/tv/The Show/E03.mkv");
  assert.deepEqual(run?.added, ["E03.mkv"]);
  assert.equal(run?.generated, 1);
  assert.equal(follow.lastChangeAt, now);
  assert.equal(follow.recent.length, 1);
  assert.ok(getShareFollow(s.id)!.known.some((e) => e.path === "E03.mkv"));
  const ev = events("follow-added")[0] as Extract<NotifyEvent, { type: "follow-added" }>;
  assert.deepEqual(ev.added, ["E03.mkv"]);
  assert.equal(ev.target, "tv/The Show");
  assert.equal(ev.generated, 1);
});

test("任务开了「复制到 OpenList」：新集顺手进复制队列；没开就不进", async () => {
  const settingsBefore = readAppSettings();
  replaceAppSettings({
    ...settingsBefore,
    openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { acc: "/115" } },
  });
  replaceAccounts([...listAccounts(), { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" }]);
  const s = await subscribe();
  await __test_resetCopy();
  try {
    // 没开开关：转存照做，复制队列一条都不进
    share.addFile("/E03.mkv", { hash: "c" });
    now += HOUR;
    await checkFollow(s.id);
    assert.equal(listCopies().length, 0, "任务没开复制就不进队列");

    replaceTasks([{ ...task, copyToOpenlist: { enabled: true } }]);
    // 两组：分享根上的新集、已知目录里的新文件，各组转存完各自登记
    drive.tree.addDir("/tv/The Show/Extras");
    share.addFile("/E04.mkv", { hash: "d" });
    share.addFile("/Extras/bloopers.mkv", { hash: "y2" });
    now += HOUR;
    const { copy } = await checkFollow(s.id);
    const rows = listCopies().sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(
      rows.map((c) => [c.srcDir, c.name, c.dstDir, c.trigger]),
      [
        ["/tv/The Show/Extras", "bloopers.mkv", "/local/media/The Show/Extras", "follow"],
        ["/tv/The Show", "E04.mkv", "/local/media/The Show", "follow"],
      ],
      "任务目录里的层级原样带过去，来源写成追更",
    );
    assert.deepEqual(copy, { queued: 2, dstDir: "/local/media", afterCopy: "keep", deleteSource: false }, "两组的结果合成一份");
  } finally {
    // 失败也要收拾干净：留着配置和真循环会祸害后面的用例（它们会去连 http://ol.local）
    await __test_resetCopy();
    replaceTasks([task]);
    replaceAccounts([account]);
    replaceAppSettings(settingsBefore);
  }
});

test("新目录整项转存；已知目录里的新文件落到对应子目录", async () => {
  const s = await subscribe();
  drive.tree.addDir("/tv/The Show/Extras");
  share.addFile("/Season 2/S02E01.mkv", { hash: "s21" });
  share.addFile("/Extras/bloopers.mkv", { hash: "y" });
  const { run } = await checkFollow(s.id);
  assert.equal(received(), 2);
  assert.ok(inDrive("/tv/The Show/Season 2/S02E01.mkv"), "整个新目录连同里面的文件转存");
  assert.ok(inDrive("/tv/The Show/Extras/bloopers.mkv"), "已知目录里的新文件落到对应子目录");
  assert.ok(strmExists("The Show/Season 2/S02E01.strm"), "新目录按子树生成 strm");
  assert.ok(strmExists("The Show/Extras/bloopers.strm"));
  assert.deepEqual(run?.added.sort(), ["Extras/bloopers.mkv", "Season 2"]);
  const known = getShareFollow(s.id)!.known.map((e) => e.path);
  assert.ok(known.includes("Season 2/S02E01.mkv"), "新目录里的文件随目录一起记进快照");
});

test("被替换 / 改名：只记一笔，不转存；下一轮不再重复报", async () => {
  const s = await subscribe();
  share.remove("/E01.mkv");
  share.addFile("/E01.mkv", { hash: "a2" });
  share.move("/E02.mkv", "/E02.fixed.mkv");
  const { run } = await checkFollow(s.id);
  assert.equal(received(), 0);
  assert.equal(run?.skipped.length, 2);
  assert.match(run!.skipped[0], /E01\.mkv：.*被替换/);
  assert.match(run!.skipped[1], /E02\.fixed\.mkv：改名或搬家/);
  assert.equal(notified.length, 0);
  const second = await checkFollow(s.id);
  assert.equal(second.run, null);
});

test("范围只有某几个目录：根目录的新增不管，范围目录不见了记一笔", async () => {
  share.addFile("/S1/S01E01.mkv", { hash: "s1" });
  drive.tree.addDir("/tv/The Show/S1");
  const s = await subscribe({ scope: ["S1", "Extras"] });
  assert.equal(s.knownCount, 4, "S1、S1/S01E01、Extras、Extras/making");
  share.addFile("/E03.mkv", { hash: "c" });
  share.addFile("/S1/S01E02.mkv", { hash: "s2" });
  share.remove("/Extras");
  const { run } = await checkFollow(s.id);
  assert.equal(received(), 1);
  assert.ok(inDrive("/tv/The Show/S1/S01E02.mkv"));
  assert.ok(!inDrive("/tv/The Show/E03.mkv"), "根目录的新增不在范围里");
  assert.deepEqual(run?.added, ["S1/S01E02.mkv"]);
  assert.deepEqual(run?.skipped, ["Extras：范围目录已不在分享里"]);
});

test("转存失败：记错误、退避、失败的下次再试；连续 3 次才通知", async () => {
  const s = await subscribe({ intervalMinutes: 60 });
  share.addFile("/E03.mkv", { hash: "c" });
  // 任务目录在网盘上没了：不替它建（任务配错了、被挪走了，建出来的也不是用户要的地方），这次转存不了
  drive.tree.remove("/tv");
  now += HOUR;
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.equal(r.follow.errorStreak, 1);
  assert.match(r.follow.lastError, /\.：任务的网盘目录「tv」不存在/);
  assert.equal(drive.tree.get("/tv"), undefined, "任务目录不替它建");
  assert.equal(r.follow.nextCheckAt, now + 2 * HOUR, "第一次失败等两倍间隔");
  assert.ok(!getShareFollow(s.id)!.known.some((e) => e.path === "E03.mkv"), "失败的不进快照");
  assert.equal(events("follow-failed").length, 0);

  await checkFollow(s.id);
  r = await checkFollow(s.id);
  assert.equal(r.follow.errorStreak, 3);
  assert.equal(events("follow-failed").length, 1);
  assert.equal(r.follow.recent.length, 1, "同一个错误连着来只占一条动态");

  drive.tree.addDir("/tv/The Show");
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle");
  assert.equal(r.follow.errorStreak, 0);
  assert.deepEqual(r.run?.added, ["E03.mkv"]);
});

/** 看交给自动整理的是什么：任务开 auto、配上 TMDB，createRun 换成记账的假函数，不真建 run */
type OrganizeCall = { paths: string[]; trigger: string; hints?: OrganizeHint[] };

async function withOrganizeCalls(fn: (calls: OrganizeCall[]) => Promise<void>): Promise<void> {
  const settings = readAppSettings();
  replaceAppSettings({ ...settings, tmdb: { apiKey: "x" } });
  replaceTasks([{ ...task, organize: { mode: "auto" } }]);
  const calls: OrganizeCall[] = [];
  setAutoOrganizeDeps({
    createRun: async (input) => {
      calls.push({ paths: input.paths ?? [], trigger: input.trigger ?? "", ...(input.hints?.length ? { hints: input.hints } : {}) });
      return {} as never;
    },
  });
  try {
    await fn(calls);
  } finally {
    __test_resetAutoOrganize();
    setAutoOrganizeDeps(null);
    replaceAppSettings(settings);
    replaceTasks([task]);
  }
}

test("落点不在了（整理挪空删了、被人删了）：建出来接着转存，建出来的整个交给整理、来源「追更」；落点在的照旧交条目", async () => {
  await withOrganizeCalls(async (calls) => {
    const s = await subscribe();
    const round = async () => {
      calls.length = 0;
      now += HOUR;
      const r = await checkFollow(s.id);
      await __test_flushAutoOrganize();
      return r;
    };

    // 订阅的落点整个没了
    drive.tree.remove("/tv/The Show");
    share.addFile("/E03.mkv", { hash: "c" });
    let r = await round();
    assert.equal(r.follow.status, "idle", r.follow.lastError);
    assert.ok(inDrive("/tv/The Show/E03.mkv"), "落点建回来、接着转存");
    assert.deepEqual(calls, [{ paths: ["The Show"], trigger: "follow" }], "建出来的目录整个交给整理，挪空了跟着删");

    // 分享里的层级（Extras）网盘上没有：只建这一层，也只交这一层
    share.addFile("/Extras/trailer.mkv", { hash: "t" });
    r = await round();
    assert.equal(r.follow.status, "idle", r.follow.lastError);
    assert.ok(inDrive("/tv/The Show/Extras/trailer.mkv"));
    assert.deepEqual(calls, [{ paths: ["The Show/Extras"], trigger: "follow" }]);

    // 落点都在：照旧交条目
    share.addFile("/E04.mkv", { hash: "d" });
    await round();
    assert.deepEqual(calls, [{ paths: ["The Show/E04.mkv"], trigger: "follow" }]);

    // 一轮里好几组：后面落在前面那组建的目录里的，也交前面那组建的（那组的整理可能已经跑完，只交里面那层会把它留成空壳）
    drive.tree.remove("/tv/The Show");
    share.addFile("/E05.mkv", { hash: "e" });
    share.addFile("/Extras/bts.mkv", { hash: "f" });
    r = await round();
    assert.equal(r.follow.status, "idle", r.follow.lastError);
    assert.ok(inDrive("/tv/The Show/E05.mkv") && inDrive("/tv/The Show/Extras/bts.mkv"));
    assert.deepEqual([...new Set(calls.flatMap((c) => c.paths))], ["The Show"]);
  });
});

test("转存没成：为它建出来的落点删回去（不然下一轮当成原来就有的，整理完留空壳），下一轮再建", async () => {
  const s = await subscribe();
  drive.tree.remove("/tv/The Show");
  share.addFile("/E03.mkv", { hash: "c" });
  const fake = drive.share!;
  const receive = fake.receive.bind(fake);
  fake.receive = async () => {
    throw new Error("空间不足");
  };
  now += HOUR;
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.match(r.follow.lastError, /空间不足/);
  assert.equal(drive.tree.get("/tv/The Show"), undefined, "建出来的空目录删回去了");
  assert.ok(drive.tree.get("/tv"), "任务目录不动");

  fake.receive = receive;
  now += 3 * HOUR;
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle", r.follow.lastError);
  assert.ok(inDrive("/tv/The Show/E03.mkv"));
});

test("分享失效：分享接口连续 3 次说不行 → expired 并停掉，通知一次；中途恢复就清零", async () => {
  const s = await subscribe();
  const def = drive.share!.shares.get("abc")!;
  def.gone = true;
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.equal(r.follow.enabled, true);
  assert.match(r.follow.lastError, /分享不可用：share not exist/);
  await checkFollow(s.id);
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "expired");
  assert.equal(r.follow.enabled, false);
  assert.equal(events("follow-expired").length, 1);
  assert.equal(events("follow-failed").length, 0);

  // 重新打开 + 分享恢复：状态清掉，照常检查
  def.gone = false;
  const reopened = updateFollow(s.id, { enabled: true });
  assert.equal(reopened.status, "idle");
  assert.equal(reopened.errorStreak, 0);
  assert.equal(reopened.nextCheckAt, now);
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle");
});

test("cookie 失效 / 封控：走账号告警，不算分享失效", async () => {
  const s = await subscribe();
  drive.failWith = new Error("登录超时，请重新登录");
  for (let i = 0; i < 3; i++) await checkFollow(s.id);
  const f = getShareFollow(s.id)!;
  assert.equal(f.status, "error");
  assert.equal(f.enabled, true, "账号的问题不该把订阅停掉");
  assert.equal(events("account-alert").length, 3, "去重在 notify 层，这里每次都发");
  assert.equal(events("follow-expired").length, 0);
});

test("网络错误：普通退避；分享目录太大：报明原因", async () => {
  const s = await subscribe({ intervalMinutes: 60 });
  drive.failWith = new Error("socket hang up");
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.equal(r.follow.lastError, "socket hang up");
  assert.equal(r.follow.nextCheckAt, now + 2 * HOUR);

  drive.failWith = null;
  for (let i = 0; i < 70; i++) share.addDir(`/Dir ${i}`);
  r = await checkFollow(s.id);
  assert.match(r.follow.lastError, /分享目录太大/);
});

test("同步任务被删：记错误，不转存", async () => {
  const s = await subscribe();
  replaceTasks([]);
  share.addFile("/E03.mkv", { hash: "c" });
  const r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.match(r.follow.lastError, /同步任务 t1 已不存在/);
  assert.equal(received(), 0);
});

test("60 天没有新增：自动暂停并通知；有新增就从那时重新算", async () => {
  const s = await subscribe();
  now += 30 * DAY;
  share.addFile("/E03.mkv", { hash: "c" });
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle");
  now += 59 * DAY;
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle", "距上次新增 59 天，还没到");
  now += 2 * DAY;
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "stale");
  assert.equal(r.follow.enabled, false);
  assert.equal(events("follow-stale").length, 1);
});

test("改设置：间隔从上次检查算起；关掉就不到期；改任务要存在", async () => {
  const s = await subscribe({ intervalMinutes: 360 });
  const shorter = updateFollow(s.id, { intervalMinutes: 60 });
  assert.equal(shorter.nextCheckAt, T0 + HOUR);
  const off = updateFollow(s.id, { enabled: false });
  assert.equal(off.enabled, false);
  const listed = drive.share!.calls.list;
  now += 2 * HOUR;
  await tickFollows();
  assert.equal(drive.share!.calls.list, listed, "建订阅时列的之外没有再列");
  assert.throws(() => updateFollow(s.id, { taskId: "nope" }), (err: HttpError) => err.status === 404);
  const renamed = updateFollow(s.id, { name: "  ", subPath: " a / b " });
  assert.equal(renamed.name, "The Show", "空名字不覆盖");
  assert.equal(renamed.subPath, "a/b");
});

test("循环：只跑到期的，按顺序；没开着的订阅就不起，建了就起，全关就停", async () => {
  startFollowWatcher();
  assert.equal(getFollowWatcherStatus().running, false);
  const a = await subscribe({ shareCode: "aaa", intervalMinutes: 60 });
  assert.equal(getFollowWatcherStatus().running, true);
  await stopFollowWatcher();
  const b = await subscribe({ shareCode: "bbb", intervalMinutes: 120 });
  await stopFollowWatcher();
  now += 61 * 60_000;
  await tickFollows();
  assert.equal(getShareFollow(a.id)!.lastCheckedAt, now, "a 到期了");
  assert.equal(getShareFollow(b.id)!.lastCheckedAt, T0, "b 还没到");
  assert.equal(getFollowWatcherStatus().lastTickAt, now);
  updateFollow(a.id, { enabled: false });
  updateFollow(b.id, { enabled: false });
  startFollowWatcher();
  assert.equal(getFollowWatcherStatus().running, false, "全关了就不起");
});

test("列表和删除", async () => {
  const s = await subscribe();
  const { follows, watcher } = listFollows();
  assert.equal(follows.length, 1);
  assert.equal(follows[0].knownCount, 4);
  assert.equal(typeof watcher.running, "boolean");
  deleteFollow(s.id);
  assert.equal(listFollows().follows.length, 0);
  assert.throws(() => deleteFollow(s.id), (err: HttpError) => err.status === 404);
});

test("服务端更新信号（夸克）：说没更新就不列目录；连续 3 次后照常列一遍；上一轮有转存失败也不信", async () => {
  const s = await subscribe();
  const fake = drive.share!;
  const listBefore = fake.calls.list;
  fake.updateSignal = "none";
  share.addFile("/E03.mkv", { hash: "c" });
  for (let i = 0; i < 3; i++) {
    now += HOUR;
    const { run, follow } = await checkFollow(s.id);
    assert.equal(run, null);
    assert.equal(follow.status, "idle");
    assert.equal(follow.lastCheckedAt, now);
    assert.equal(follow.nextCheckAt, now + FOLLOW.DEFAULT_INTERVAL_MIN * 60_000);
  }
  assert.equal(fake.calls.list, listBefore, "三轮都信了信号，没列目录");
  assert.equal(fake.calls.updates, 3);
  assert.equal(received(), 0);

  // 第四轮信不过了：照常列，发现新集
  now += HOUR;
  const fourth = await checkFollow(s.id);
  assert.deepEqual(fourth.run?.added, ["E03.mkv"]);
  assert.equal(received(), 1);
  // 信不过的那轮根本不问信号；列过一遍后信任重新计数：又能跳过
  assert.equal(fake.calls.updates, 3);
  now += HOUR;
  assert.equal((await checkFollow(s.id)).run, null);
  assert.equal(fake.calls.updates, 4);

  // 说有 / 认不出：照常列
  fake.updateSignal = "some";
  share.addFile("/E04.mkv", { hash: "d" });
  now += HOUR;
  assert.deepEqual((await checkFollow(s.id)).run?.added, ["E04.mkv"]);
  fake.updateSignal = "unknown";
  share.addFile("/E05.mkv", { hash: "e" });
  now += HOUR;
  assert.deepEqual((await checkFollow(s.id)).run?.added, ["E05.mkv"]);

  // 上一轮转存失败（任务目录没了；落点没了会建回来，不算失败）→ 即使信号说没更新，也要列目录把失败的再试一次
  drive.tree.remove("/tv");
  share.addFile("/E06.mkv", { hash: "f" });
  now += HOUR;
  const failedRun = await checkFollow(s.id);
  assert.equal(failedRun.follow.status, "error");
  assert.equal(failedRun.follow.errorStreak, 1);
  drive.tree.addDir("/tv/The Show");
  fake.updateSignal = "none";
  const updatesBefore = fake.calls.updates;
  now += HOUR;
  const retry = await checkFollow(s.id);
  assert.equal(fake.calls.updates, updatesBefore, "有失败在身就不问信号");
  assert.deepEqual(retry.run?.added, ["E06.mkv"]);
  assert.equal(retry.follow.errorStreak, 0);
});

test("分享里名字带 / 的条目：建订阅和检查都跳过它，不当成子目录去转存，也不算错误", async () => {
  const hook = (dirId: string, entries: Parameters<NonNullable<typeof drive.share>["listHook"] & object>[1]) =>
    dirId === "0" ? [...entries, { id: "weird", name: "part 1/2.mkv", isDir: false, token: "tok-weird" }] : entries;
  drive.share!.listHook = hook;
  const s = await subscribe();
  assert.ok(!getShareFollow(s.id)!.known.some((e) => e.path.includes("part 1")), "建订阅时快照里没有它");
  drive.share!.listHook = null;
  const clean = await subscribe({ shareCode: "other", name: "other" });
  // 建订阅时没有、检查时才出现：同样跳过，不当新增去转存
  drive.share!.listHook = hook;
  now += HOUR;
  const { run, follow } = await checkFollow(clean.id);
  assert.equal(run, null);
  assert.equal(follow.status, "idle");
  assert.equal(follow.errorStreak, 0);
  assert.equal(received(), 0);
  assert.ok(!getShareFollow(clean.id)!.known.some((e) => e.path.includes("part 1")));
});

test("改订阅的任务：换到别的网盘类型的任务 400，同类的可以", async () => {
  const quarkAccount: AccountInfo = { accountType: "quark", name: "qacc", cookie: "c" };
  const quarkTask: TaskDefinition = { id: "tq", account: "qacc", accountType: "quark", originPath: "kk", targetPath: "kk", strmPrefix: "/mnt" };
  const sibling: TaskDefinition = { ...task, id: "t1b", targetPath: "tv-b" };
  const quarkDrive = new FakeDrive("quark", quarkAccount, { share: true });
  replaceAccounts([account, quarkAccount]);
  replaceTasks([task, sibling, quarkTask]);
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : a.name === "qacc" ? quarkDrive : null));
  const s = await subscribe();
  await assert.rejects(
    async () => updateFollow(s.id, { taskId: "tq" }),
    (e: unknown) => e instanceof HttpError && e.status === 400 && /不能换到 夸克网盘/.test(e.message),
  );
  assert.equal(updateFollow(s.id, { taskId: "t1b" }).taskId, "t1b");
});

test("同一分享在同一账号上还有别的订阅：服务端信号不信，照常列目录", async () => {
  const s1 = await subscribe();
  const extras = share.get("/Extras")!;
  const s2 = await subscribe({ watchCid: extras.id, watchPath: "Extras", subPath: "The Show/Extras", name: "Extras" });
  const fake = drive.share!;
  fake.updateSignal = "none";
  share.addFile("/E03.mkv", { hash: "c" });
  const updatesBefore = fake.calls.updates;
  now += HOUR;
  const { run } = await checkFollow(s1.id);
  assert.deepEqual(run?.added, ["E03.mkv"], "没信信号，列目录发现了新集");
  assert.equal(fake.calls.updates, updatesBefore, "根本没问信号");
  assert.ok(s2.id);
});

test("改订阅的任务：旧任务已经删了也能换到同类的新任务", async () => {
  const sibling: TaskDefinition = { ...task, id: "t1b", targetPath: "tv-b" };
  const s = await subscribe();
  replaceTasks([sibling]);
  assert.equal(updateFollow(s.id, { taskId: "t1b" }).taskId, "t1b");
});

/* ------------------------------- 整理结果 ------------------------------- */

const organizedRec = (over: Partial<ShareFollowOrganized> = {}): ShareFollowOrganized => ({
  dir: "",
  mediaType: "tv",
  tmdbId: 7,
  title: "The Show",
  year: "2020",
  season: null,
  seasonFallback: null,
  episodeOffset: 0,
  workDir: "The Show (2020)",
  filesDir: "The Show (2020)/Season 01",
  titles: ["the show"],
  runId: "r0",
  prev: null,
  at: 1,
  ...over,
});

test("整理结果：这个目录的新文件（不含目录）带上提示交给整理，别的目录不带；不再沿用、换任务都清掉", async () => {
  await withOrganizeCalls(async (calls) => {
    const s = await subscribe();
    updateShareFollow(s.id, { organized: [organizedRec({ season: 2, episodeOffset: -12 })] });
    share.addFile("/E03.mkv", { hash: "c" });
    share.addFile("/Season 3/S03E01.mkv", { hash: "s31" });
    share.addFile("/Extras/bts.mkv", { hash: "f" });
    drive.tree.addDir("/tv/The Show/Extras");
    now += HOUR;
    const r = await checkFollow(s.id);
    assert.equal(r.follow.status, "idle", r.follow.lastError);
    await __test_flushAutoOrganize();
    const hints = calls.flatMap((c) => c.hints ?? []);
    assert.deepEqual(hints.map((h) => h.path), ["The Show/E03.mkv"], "只给直接放在记录目录里的文件：新目录、别的目录都不带");
    assert.deepEqual(
      [hints[0].tmdbId, hints[0].season, hints[0].episodeOffset, hints[0].seasonFallback, hints[0].titles, hints[0].label],
      [7, 2, -12, null, ["the show"], "The Show"],
    );
  });
  const s = listFollows().follows[0];
  assert.equal(updateFollow(s.id, { clearOrganized: true }).organized.length, 0, "不再沿用");
  updateShareFollow(s.id, { organized: [organizedRec()] });
  replaceTasks([task, { ...task, id: "t2", originPath: "tv2" }]);
  drive.tree.addDir("/tv2");
  assert.equal(updateFollow(s.id, { taskId: "t2" }).organized.length, 0, "换了任务，按旧任务记的目录用不上了");
});

test("记整理结果：快照里的原样文件按分享里的目录记，进了不同作品 / 是电影不记；值没变不刷 runId；整理页又动了这批文件就跟着改、偏移累加；撤销退回上一版；目录改写跟着走", async () => {
  const s = await subscribe();
  const unit = (over: Record<string, unknown> = {}) => ({ mediaType: "tv" as const, tmdbId: 7, title: "The Show", year: "2020", seasonOverride: null, episodeOffset: 0, dstRoot: "The Show (2020)", ...over });
  const video = (src: string, dst: string, season: number | null, over: Record<string, unknown> = {}, titles = ["the show"]) => ({ src, dst, season, titles, unit: unit(over) });
  const rows = () => getShareFollow(s.id)!.organized;
  const S2 = "The Show (2020)/Season 02";

  // 另一条记录的视频目录碰巧就是这次原样文件所在的目录：原样文件只按分享里的目录记，不当成在改那一条
  updateShareFollow(s.id, { organized: [organizedRec({ dir: "Extras", filesDir: "The Show", season: 5, runId: "r0" })] });
  // 第一次整理：人把季改成 2
  learnFollowOrganized("t1", "r1", [
    video("The Show/E01.mkv", `${S2}/The Show - S02E01.mkv`, 2, { seasonOverride: 2 }),
    video("The Show/E02.mkv", `${S2}/The Show - S02E02.mkv`, 2, { seasonOverride: 2 }),
    video("别处/E01.mkv", `${S2}/x.mkv`, 2, { seasonOverride: 2 }),
  ]);
  assert.deepEqual(rows().map((o) => [o.dir, o.season, o.seasonFallback, o.episodeOffset, o.workDir, o.filesDir, o.titles, o.runId, o.prev]), [
    ["Extras", 5, null, 0, "The Show (2020)", "The Show", ["the show"], "r0", null],
    ["", 2, null, 0, "The Show (2020)", S2, ["the show"], "r1", null],
  ]);
  updateShareFollow(s.id, { organized: rows().slice(1) });

  // 追更每来一集整理一次，值一样：不刷 runId，片名照样补
  learnFollowOrganized("t1", "r2", [video("The Show/E01.mkv", `${S2}/The Show - S02E01.mkv`, 2, { seasonOverride: 2 }, ["the show", "show"])]);
  assert.deepEqual([rows()[0].runId, rows()[0].titles], ["r1", ["the show", "show"]]);

  // 同一个目录的文件进了不同作品、或者认成电影：不猜，原来的留着
  learnFollowOrganized("t1", "r3", [video("The Show/E01.mkv", "A/x.mkv", 1, { tmdbId: 8 }), video("The Show/E02.mkv", "B/y.mkv", 1)]);
  learnFollowOrganized("t1", "r3", [video("The Show/E01.mkv", "Movie (2020)/m.mkv", null, { mediaType: "movie", tmdbId: 9 })]);
  assert.equal(rows()[0].runId, "r1");

  // 整理页又动了这批文件（改成第 3 季、集数 +5）：跟着改，偏移在上次的基础上累加；原来那条放进 prev
  learnFollowOrganized("t1", "r4", [
    video(`${S2}/The Show - S02E01.mkv`, "The Show (2020)/Season 03/The Show - S03E06.mkv", 3, { seasonOverride: 3, episodeOffset: 5 }),
  ]);
  const moved = rows()[0];
  assert.deepEqual([moved.season, moved.episodeOffset, moved.filesDir, moved.runId, moved.prev?.runId, moved.prev?.season], [3, 5, "The Show (2020)/Season 03", "r4", "r1", 2]);
  learnFollowOrganized("t1", "r5", [video("The Show (2020)/Season 03/The Show - S03E06.mkv", "The Show (2020)/Season 03/x.mkv", 3, { episodeOffset: 2 })]);
  assert.deepEqual([rows()[0].season, rows()[0].episodeOffset], [3, 7], "人没定季就留着原来的季，偏移累加");

  // 目录改写：作品目录挪走了，记的目录跟着走
  rewriteFollowSubPaths("t1", [{ from: "The Show (2020)", to: "剧集/The Show (2020)" }]);
  assert.deepEqual([rows()[0].workDir, rows()[0].filesDir], ["剧集/The Show (2020)", "剧集/The Show (2020)/Season 03"]);
  assert.equal(getShareFollow(s.id)!.subPath, "The Show", "订阅落点不在映射里，不动");

  // 撤销：退回上一版；最早那次也撤了就删掉
  assert.equal(revertFollowOrganized("t1", "r5"), 1);
  assert.deepEqual([rows()[0].season, rows()[0].episodeOffset, rows()[0].runId], [3, 5, "r4"]);
  revertFollowOrganized("t1", "r4");
  assert.deepEqual([rows()[0].season, rows()[0].runId, rows()[0].prev], [2, "r1", null]);
  assert.equal(revertFollowOrganized("t1", "r9"), 0, "别的整理不动它");
  revertFollowOrganized("t1", "r1");
  assert.deepEqual(rows(), []);

  // 没人定季：记的是落到的季（只补空）；落到几个季就不记
  learnFollowOrganized("t1", "r6", [video("The Show/E01.mkv", `${S2}/a.mkv`, 2), video("The Show/E02.mkv", `${S2}/b.mkv`, 2)]);
  assert.deepEqual([rows()[0].season, rows()[0].seasonFallback], [null, 2]);
  learnFollowOrganized("t1", "r7", [video("The Show/E01.mkv", "The Show (2020)/Season 01/a.mkv", 1), video("The Show/E02.mkv", `${S2}/b.mkv`, 2)]);
  assert.deepEqual([rows()[0].seasonFallback, rows()[0].filesDir], [null, "The Show (2020)"], "视频落到几个目录：认作品目录");
});
