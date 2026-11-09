/**
 * 云下载回执循环：115 的任务列表、strm 生成、交给复制队列这三步都换成桩，
 * 逐轮驱动 tickFollowups 验证状态机。真正的复制在 services/copy 里，那边另有测试。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/offline/followup.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { setOfflineTransport, type OfflineListPage, type OfflineTask, type OfflineTransport } from "../cloud-115/offline.js";
import type { NotifyEvent } from "../notify.js";
import type { CopyRequest } from "../copy/service.js";
import {
  __test_resetOffline,
  addOfflineTasks,
  getOfflineWatcherStatus,
  listFollowups,
  removeOfflineTasks,
  rewriteOfflineSubPaths,
  setOfflineServiceDeps,
  startOfflineWatcher,
  stopOfflineWatcher,
  tickFollowups,
  type GenerateParams,
} from "./service.js";

let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; openlistCopy: AppSettings["openlistCopy"] };
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt" };

/** 每轮列表桩回什么 */
let pages: OfflineTask[][] = [[]];
let listError: Error | null = null;
const listCalls: number[] = [];
const generated: GenerateParams[] = [];
const notified: NotifyEvent[] = [];
let generateError: Error | null = null;
/** 生成 strm 那一步（对 115 是整目录导出，可能要几分钟）中途插进来的别的动作：加任务、删任务、整理改落点 */
let onGenerate: (() => Promise<void>) | null = null;

/** 交给复制队列的请求 */
const copyCalls: CopyRequest[] = [];
/** 115 目录 id → 网盘绝对路径 的桩 */
let dirPaths: Record<string, string> = {};
/** 复制队列收不收：默认收下一条 */
let enqueueResult: { queued: number; skipped: string | null; duplicates?: number } = { queued: 1, skipped: null };

const row = (over: Partial<OfflineTask>): OfflineTask => ({
  infoHash: "hash0", name: "Show.S01", url: "magnet:?xt=urn:btih:one", size: 1, percent: 100, status: 2, state: "done",
  statusText: "下载成功", addTime: 1, lastUpdate: 1, leftTime: 0, peers: 0, rateDownload: 0, dirId: "999",
  resultId: "r1", resultName: "Show.S01", isDir: true, move: 1, pickCode: "pc", ...over,
});

const transport: OfflineTransport = {
  async web(_acc, ac) {
    // 删任务只要 115 说成了；别的 web 接口回执测试用不到
    if (ac === "task_del") return { state: true };
    throw new Error("回执测试里不该走 web 传输层");
  },
  async ssp(_acc, _ac, payload) {
    const urls = Object.keys(payload).filter((k) => k.startsWith("url[")).map((k) => String(payload[k]));
    // 链接里带 "dup" 的模拟 115 的「任务已存在」：state=false 但仍回 info_hash
    const result = urls.map((url, i) =>
      url.includes("dup")
        ? { state: false, error_msg: "任务已存在", info_hash: `hash${i}`, url }
        : { state: true, info_hash: url.includes("solo") ? "hash9" : `hash${i}`, name: `name${i}`, url },
    );
    return { state: true, data: { result } };
  },
  async downPath() { return { state: true, data: [] }; },
};

async function seed(urls = "magnet:?xt=urn:btih:one", subPath = "S1") {
  const r = await addOfflineTasks({ urls, taskId: "t1", subPath });
  // addOfflineTasks 会把循环拉起来；这里手动驱动，先停掉
  await stopOfflineWatcher();
  return r;
}

/** 下载到 115 默认目录 + 勾选「复制到 OpenList」 */
async function seedCopy(urls = "magnet:?xt=urn:btih:one") {
  const r = await addOfflineTasks({ urls, copyToOpenlist: true });
  await stopOfflineWatcher();
  return r;
}

before(() => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), openlistCopy: readAppSettings().openlistCopy };
  replaceAccounts([account, olAccount]);
  replaceTasks([task]);
  setOfflineTransport(transport);
  setOfflineServiceDeps({
    resolveDirId: async () => "999",
    list: async (_acc, page): Promise<OfflineListPage> => {
      listCalls.push(page);
      if (listError) throw listError;
      const tasks = pages[page - 1] ?? [];
      return { page, pageCount: pages.length, pageSize: 30, count: 0, quota: null, total: null, tasks };
    },
    generate: async (p) => {
      generated.push(p);
      if (onGenerate) await onGenerate();
      if (generateError) throw generateError;
      return { generatedCount: 3, skippedCount: 1, invalidNames: [] };
    },
    notify: async (ev) => { notified.push(ev); },
    enqueueCopy: (req) => { copyCalls.push(req); return enqueueResult; },
    resolveDirPath: async (_acc, cid) => dirPaths[cid] ?? null,
  });
});

beforeEach(async () => {
  await __test_resetOffline();
  pages = [[]];
  listError = null;
  generateError = null;
  onGenerate = null;
  listCalls.length = 0;
  generated.length = 0;
  notified.length = 0;
  copyCalls.length = 0;
  dirPaths = { "999": "/云下载", "5": "/别的目录" };
  enqueueResult = { queued: 1, skipped: null };
  replaceTasks([task]);
  replaceAccounts([account, olAccount]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/dl", mounts: { acc: "/115" } } });
});

after(async () => {
  await __test_resetOffline();
  setOfflineTransport(null);
  setOfflineServiceDeps(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  patchAppSettings({ openlistCopy: baseline.openlistCopy });
});

test("下载中：只更新说明，保持待办", async () => {
  await seed();
  pages = [[row({ state: "downloading", status: 1, percent: 42 })]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "pending");
  assert.match(f.detail, /下载中 42%/);
  assert.equal(generated.length, 0);
});

test("完成（目录）：用 115 给的产物 id 生成 strm，回执 done，通知 Telegram", async () => {
  await seed();
  pages = [[row({ isDir: true, resultId: "r1", resultName: "Show.S01" })]];
  await tickFollowups();
  assert.equal(generated.length, 1);
  const g = generated[0];
  assert.equal(g.task.id, "t1");
  assert.equal(g.accountInfo.name, "acc");
  assert.equal(g.subPath, "S1");
  assert.deepEqual(g.item, { name: "Show.S01", isDir: true, id: "r1" });
  const [f] = listFollowups();
  assert.equal(f.status, "done");
  assert.match(f.detail, /已生成 3 个 strm（跳过 1 个）/);
  assert.equal(f.name, "Show.S01", "名字用列表里的最新值");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "offline-done");
  assert.equal((notified[0] as { name: string }).name, "Show.S01");
  assert.equal(getOfflineWatcherStatus().pending, 0);
});

test("完成（单文件）：按 del_path 生成，不带产物 id", async () => {
  await seed();
  pages = [[row({ isDir: false, resultId: "f1", resultName: "ep1.mkv", name: "ep1" })]];
  await tickFollowups();
  assert.deepEqual(generated[0].item, { name: "ep1.mkv", isDir: false, id: undefined });
});

test("115 报失败：回执 failed 并带上 115 的说法，不生成", async () => {
  await seed();
  pages = [[row({ state: "failed", status: -1, statusText: "资源违规" })]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /115 下载失败：资源违规/);
  assert.equal(generated.length, 0);
});

test("列表里连续 3 轮找不到：当作被删了", async () => {
  await seed();
  pages = [[row({ infoHash: "someone-else" })]];
  await tickFollowups();
  assert.equal(listFollowups()[0].status, "pending");
  assert.match(listFollowups()[0].detail, /1\/3/);
  await tickFollowups();
  await tickFollowups();
  assert.equal(listFollowups()[0].status, "failed");
  assert.match(listFollowups()[0].detail, /不在 115 的云下载列表/);
});

test("翻页：第一页没有就翻下一页，找齐就停；最多 5 页", async () => {
  await seed("magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:two");
  pages = [[row({ infoHash: "x" })], [row({ infoHash: "hash1", isDir: false, resultName: "b.mkv" })], [row({ infoHash: "hash0" })]];
  await tickFollowups();
  assert.deepEqual(listCalls, [1, 2, 3]);
  assert.deepEqual(listFollowups().map((f) => f.status), ["done", "done"]);

  await __test_resetOffline();
  await seed();
  listCalls.length = 0;
  pages = Array.from({ length: 8 }, () => [row({ infoHash: "nope" })]);
  await tickFollowups();
  assert.deepEqual(listCalls, [1, 2, 3, 4, 5]);
});

test("生成 strm 失败：重试 3 次后作废，中间保持待办并写明原因", async () => {
  await seed();
  pages = [[row({})]];
  generateError = new Error("导出目录树超时");
  await tickFollowups();
  let [f] = listFollowups();
  assert.equal(f.status, "pending");
  assert.equal(f.attempts, 1);
  assert.match(f.detail, /稍后重试（1\/3）：导出目录树超时/);
  await tickFollowups();
  await tickFollowups();
  [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /生成 strm 失败：导出目录树超时/);
  assert.equal(generated.length, 3);
});

test("列表拿不到：这一轮什么都不改，状态里记下错误", async () => {
  await seed();
  listError = new Error("115 接口返回 405");
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "pending");
  assert.equal(f.misses, 0, "拿不到列表不算「找不到」");
  assert.equal(getOfflineWatcherStatus().lastError, "115 接口返回 405");
});

test("同步任务已被删：回执 failed", async () => {
  await seed();
  replaceTasks([]);
  pages = [[row({})]];
  await tickFollowups();
  assert.match(listFollowups()[0].detail, /同步任务 t1 已不存在/);
  assert.equal(generated.length, 0);
});

test("账号没了：这个账号的回执全部作废", async () => {
  await seed();
  replaceAccounts([]);
  try {
    await tickFollowups();
    assert.equal(listFollowups()[0].status, "failed");
    assert.match(listFollowups()[0].detail, /账号 acc/);
  } finally {
    replaceAccounts([account, olAccount]);
  }
});

test("循环的启停：没待办不起；有待办才起；兑现完自己停", async () => {
  startOfflineWatcher();
  assert.equal(getOfflineWatcherStatus().running, false);
  await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1" });
  assert.equal(getOfflineWatcherStatus().running, true);
  await stopOfflineWatcher();
  assert.equal(getOfflineWatcherStatus().running, false);
  pages = [[row({})]];
  await tickFollowups();
  startOfflineWatcher();
  assert.equal(getOfflineWatcherStatus().running, false, "都兑现了就不该再起");
});

/* ------------------------------- 交给复制队列 ------------------------------- */

test("勾了复制但没配好：加任务时当场拒绝，不留回执", async () => {
  patchAppSettings({ openlistCopy: undefined });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /还没配置好/);
  patchAppSettings({ openlistCopy: { account: "acc", dstDir: "/local/dl" } });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /不是 openlist 账号/);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/dl" } });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /挂载根/);
  // 挂载根填了，可设置页和这次都没给目标目录：下完了也没地方复制，当场说
  patchAppSettings({ openlistCopy: { account: "ol", mounts: { acc: "/115" } } });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /没有复制目标目录/);
  assert.equal(listFollowups().length, 0, "拒绝时不该留下任何回执");
});

test("下到 115 默认目录：下完把产物的网盘路径交给复制队列", async () => {
  const r = await seedCopy();
  assert.equal(r.followup, true);
  let [f] = listFollowups();
  assert.equal(f.kind, "openlist-copy");
  assert.equal(f.taskId, "");
  assert.equal(f.copyDstDir, "/local/dl");

  pages = [[row({})]];
  await tickFollowups();
  [f] = listFollowups();
  assert.equal(f.status, "done");
  assert.match(f.detail, /已交给复制队列/);
  assert.equal(copyCalls.length, 1);
  assert.deepEqual(copyCalls[0], {
    account: "acc",
    sources: [{ path: "/云下载/Show.S01", isDir: true, nodeId: "r1" }],
    // 不属于任何任务：平铺到目标目录（没有 rootPath），也没有任务级的删源开关
    rootPath: undefined,
    taskId: undefined,
    dstDir: "/local/dl",
    afterCopy: "keep",
    trigger: "offline",
  });
});

test("任务开着会直接执行的自动整理：交给复制队列时说一声先等整理", async () => {
  const tmdb = readAppSettings().tmdb;
  replaceTasks([{ ...task, organize: { mode: "auto" } }]);
  patchAppSettings({ tmdb: { apiKey: "k" } });
  try {
    await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", subPath: "S1", copyToOpenlist: true });
    await stopOfflineWatcher();
    pages = [[row({})]];
    await tickFollowups();
    assert.equal(copyCalls[0]?.holdForOrganize, true, "整理马上要在网盘上改名，先复制会复制成整理前的样子");
  } finally {
    patchAppSettings({ tmdb });
  }
});

test("下到任意目录也能复制：不再限定 115 默认目录", async () => {
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", dirId: "5", copyToOpenlist: true });
  await stopOfflineWatcher();
  assert.equal(r.followup, true);
  pages = [[row({ dirId: "5" })]];
  await tickFollowups();
  assert.equal(listFollowups()[0].status, "done");
  assert.deepEqual(copyCalls[0]?.sources, [{ path: "/别的目录/Show.S01", isDir: true, nodeId: "r1" }]);
});

test("下到任务目录 + 勾复制：先生成 strm，再交给复制队列", async () => {
  await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", subPath: "S1", copyToOpenlist: true });
  await stopOfflineWatcher();
  pages = [[row({})]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "done");
  assert.match(f.detail, /已生成 3 个 strm/);
  assert.equal(generated.length, 1, "strm 照生成");
  assert.equal(copyCalls.length, 1);
  assert.deepEqual(copyCalls[0], {
    account: "acc",
    sources: [{ path: "tv/S1/Show.S01", isDir: true, nodeId: "r1" }],
    rootPath: "tv",
    taskId: "t1",
    dstDir: "/local/dl",
    afterCopy: "keep",
    trigger: "offline",
    holdForOrganize: false,
  });
});

test("加任务时选了目的子目录：交给队列时用它，不用设置里的 dstDir", async () => {
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true, copyDstDir: "/local/dl/movies/" });
  await stopOfflineWatcher();
  assert.equal(r.followup, true);
  assert.equal(listFollowups()[0].copyDstDir, "/local/dl/movies", "尾斜杠在登记时就归一化");
  pages = [[row({})]];
  await tickFollowups();
  assert.equal(copyCalls[0]?.dstDir, "/local/dl/movies");
});

test("重复提交（任务已存在）：复制回执照登并由循环接管，strm 回执不登", async () => {
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:dup", copyToOpenlist: true });
  await stopOfflineWatcher();
  assert.equal(r.added, 0, "115 没接受新任务");
  assert.equal(r.followup, true, "但复制回执要登上");
  const [f] = listFollowups();
  assert.equal(f.kind, "openlist-copy");
  assert.equal(f.infoHash, "hash0");

  // 已存在的任务往往已经下完：下一轮直接交给复制队列
  pages = [[row({})]];
  await tickFollowups();
  assert.equal(copyCalls.length, 1);
  assert.equal(listFollowups()[0].status, "done");

  // strm 模式的重复不登：已存在的任务可能不在任务目录里，生成的 strm 路径会是错的
  await __test_resetOffline();
  const r2 = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:dup", taskId: "t1" });
  await stopOfflineWatcher();
  assert.equal(r2.followup, false);
  assert.equal(listFollowups().length, 0);
});

test("115 下载失败的复制回执：作废并用复制的通知文案", async () => {
  await seedCopy();
  pages = [[row({ state: "failed", status: -1, statusText: "资源违规" })]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /115 下载失败：资源违规/);
  assert.equal(copyCalls.length, 0, "没下成就不该交给复制队列");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "offline-copy-failed");
});

test("复制队列没收下（配置没配好）：回执如实报失败，不记成已交付", async () => {
  await seedCopy();
  enqueueResult = { queued: 0, skipped: "账号 acc 没填「在 OpenList 里的挂载根」" };
  pages = [[row({})]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /没能交给复制队列：账号 acc 没填/);
});

test("落点目录解析不出来：回执失败，不乱猜路径", async () => {
  await seedCopy();
  pages = [[row({ dirId: "不存在的目录" })]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /解析不出 115 上的落点目录/);
  assert.equal(copyCalls.length, 0);
});

test("strm 回执和复制回执混在一轮里：各走各的", async () => {
  await seed("magnet:?xt=urn:btih:one");
  await addOfflineTasks({ urls: "magnet:?xt=urn:btih:solo", copyToOpenlist: true });
  await stopOfflineWatcher();
  assert.equal(listFollowups().length, 2);

  pages = [[row({ infoHash: "hash0" }), row({ infoHash: "hash9", name: "Other" })]];
  await tickFollowups();
  const done = listFollowups().filter((f) => f.status === "done");
  assert.equal(done.length, 2, "两条都办完了");
  assert.equal(generated.length, 1, "只有 strm 那条生成了 strm");
  assert.equal(copyCalls.length, 1, "只有复制那条进了队列");
});

test("下完交给复制队列却没排上（设置被改坏了）：写进回执说明和通知，不悄悄没了；已经排着一样的不算没排上", async () => {
  await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", subPath: "S1", copyToOpenlist: true });
  await stopOfflineWatcher();
  enqueueResult = { queued: 0, skipped: "「复制到 OpenList」没配置好：OpenList 账号不存在：ol" };
  pages = [[row({})]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "done", "strm 照样生成好了");
  assert.match(f.detail, /已生成 3 个 strm/);
  assert.match(f.detail, /没能交给复制队列：「复制到 OpenList」没配置好/);
  const done = notified.find((n) => n.type === "offline-done") as { detail?: string } | undefined;
  assert.match(done?.detail ?? "", /没能交给复制队列/, "通知里也说");

  // 只复制的回执：队列里已经排着一样的，那一条会照办，不记成失败
  await __test_resetOffline();
  await seedCopy();
  enqueueResult = { queued: 0, skipped: "这些条目已经在队列里或刚复制过", duplicates: 1 };
  pages = [[row({})]];
  await tickFollowups();
  assert.equal(listFollowups()[0].status, "done");
  assert.match(listFollowups()[0].detail, /复制队列里已经有这一项/);
});

test("删不删源在加任务那一刻冻结，之后改设置不影响；115 上原本就有、不在任务目录里的不删，在任务目录里的照删", async () => {
  replaceTasks([{ ...task, copyToOpenlist: { enabled: true, afterCopy: "delete" } }]);
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", subPath: "S1" });
  await stopOfflineWatcher();
  assert.equal(r.copyAfterCopy, "delete");
  assert.equal(listFollowups()[0].copyAfterCopy, "delete");
  // 下完之前关掉了删源：已经登记的照登记时的办（同转存 / 追更在登记时冻结）
  replaceTasks([{ ...task, copyToOpenlist: { enabled: true, afterCopy: "keep" } }]);
  pages = [[row({})]];
  await tickFollowups();
  assert.equal(copyCalls[0]?.afterCopy, "delete");

  // 「任务已存在」的只复制回执：产物躺在任务目录外面（/别的目录），不能因为这个任务开着删源就删它
  await __test_resetOffline();
  copyCalls.length = 0;
  replaceTasks([{ ...task, copyToOpenlist: { enabled: true, afterCopy: "delete" } }]);
  await addOfflineTasks({ urls: "magnet:?xt=urn:btih:dup", taskId: "t1" });
  await stopOfflineWatcher();
  assert.equal(listFollowups()[0].kind, "openlist-copy");
  pages = [[row({ dirId: "5" })]];
  await tickFollowups();
  assert.equal(copyCalls[0]?.afterCopy, "keep");

  // 躺在任务目录里的照删
  await __test_resetOffline();
  copyCalls.length = 0;
  dirPaths["7"] = "/tv/S1";
  await addOfflineTasks({ urls: "magnet:?xt=urn:btih:dup", taskId: "t1" });
  await stopOfflineWatcher();
  pages = [[row({ dirId: "7" })]];
  await tickFollowups();
  assert.equal(copyCalls[0]?.afterCopy, "delete");

  // 归档同样在加任务那一刻冻结
  await __test_resetOffline();
  copyCalls.length = 0;
  replaceTasks([{ ...task, copyToOpenlist: { enabled: true, afterCopy: "archive" } }]);
  const archived = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", subPath: "S1" });
  await stopOfflineWatcher();
  assert.equal(archived.copyAfterCopy, "archive");
  pages = [[row({})]];
  await tickFollowups();
  assert.equal(copyCalls[0]?.afterCopy, "archive");
});

test("任务开着复制、OpenList 账号却被删了：照常下载，回执不带复制目标，结果里说卡在哪；明说要复制的当场拒绝", async () => {
  replaceTasks([{ ...task, copyToOpenlist: { enabled: true } }]);
  replaceAccounts([account]);
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1" });
  await stopOfflineWatcher();
  assert.equal(r.added, 1);
  assert.equal(r.copyDstDir, null);
  assert.match(r.copyBlocked ?? "", /OpenList 账号不存在/);
  assert.equal(listFollowups()[0].copyDstDir, undefined, "不许诺下完复制");
  await __test_resetOffline();
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", copyToOpenlist: true }), /OpenList 账号不存在/);
  assert.equal(listFollowups().length, 0);
});

test("这次指定的复制目标只能在任务上、设置页的目标目录下面；都没填就不能指定", async () => {
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true, copyDstDir: "/quark/x" }), /复制目标只能是 \/local\/dl/);
  replaceTasks([{ ...task, copyToOpenlist: { enabled: true, dstDir: "/local/tv" } }]);
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", copyDstDir: "/local/tv/S1" });
  await stopOfflineWatcher();
  assert.equal(r.copyDstDir, "/local/tv/S1");
  // 任务上开着复制、没填目标目录，设置页也没填：这次指定的目标没有根可比，不收（以前是悄悄不复制）
  await __test_resetOffline();
  patchAppSettings({ openlistCopy: { account: "ol", mounts: { acc: "/115" } } });
  replaceTasks([{ ...task, copyToOpenlist: { enabled: true } }]);
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", copyDstDir: "/local/x" }), /都没填复制的目标目录/);
  assert.equal(listFollowups().length, 0);
});

test("OpenList 根 / 当复制目标：这次指定成 / 的拒；设置页填的是 / 等于没填", async () => {
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true, copyDstDir: "/" }), /不能是根 \//);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/", mounts: { acc: "/115" } } });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /没有复制目标目录/);
  assert.equal(listFollowups().length, 0, "拒绝时不该留下任何回执");
});

test("同一批里有新有旧：新的登记 strm 回执（兼办复制），115 上原本就有的也登记一条只复制的", async () => {
  replaceTasks([{ ...task, copyToOpenlist: { enabled: true } }]);
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:dup", taskId: "t1" });
  await stopOfflineWatcher();
  assert.equal(r.strmFollowup, true);
  assert.equal(r.copyDstDir, "/local/dl");
  const byHash = new Map(listFollowups().map((f) => [f.infoHash, f]));
  assert.equal(byHash.get("hash0")?.kind ?? "strm", "strm");
  assert.equal(byHash.get("hash0")?.copyDstDir, "/local/dl");
  assert.equal(byHash.get("hash1")?.kind, "openlist-copy", "原本就有的不能漏掉");
});

/* ------------------------------- 一轮中途别处改了回执 ------------------------------- */

const byHash = () => new Map(listFollowups().map((f) => [f.infoHash, f]));

test("一轮中途新加的回执不会被这一轮的写回盖掉", async () => {
  await seed();
  pages = [[row({})]];
  onGenerate = async () => {
    await addOfflineTasks({ urls: "magnet:?xt=urn:btih:solo", taskId: "t1", subPath: "S2" });
    await stopOfflineWatcher();
  };
  await tickFollowups();
  assert.equal(byHash().get("hash0")?.status, "done");
  assert.equal(byHash().get("hash9")?.status, "pending", "中途加的那条还在，等下一轮去对");
  assert.equal(byHash().get("hash9")?.subPath, "S2");
});

test("一轮中途被删掉的回执不会被写回复活", async () => {
  await seed("magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:two");
  pages = [[row({ infoHash: "hash0" }), row({ infoHash: "hash1", state: "downloading", status: 1, percent: 10 })]];
  onGenerate = async () => {
    await removeOfflineTasks("acc", ["hash1"], false);
  };
  await tickFollowups();
  assert.deepEqual(listFollowups().map((f) => f.infoHash), ["hash0"]);
  assert.equal(listFollowups()[0].status, "done");
});

test("一轮中途整理改写了落点：这一轮写回时不把它改回去", async () => {
  await seed("magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:two");
  pages = [[row({ infoHash: "hash0" }), row({ infoHash: "hash1", state: "downloading", status: 1, percent: 10 })]];
  onGenerate = async () => {
    rewriteOfflineSubPaths("t1", [{ from: "S1", to: "Season 1" }]);
  };
  await tickFollowups();
  const f = byHash().get("hash1");
  assert.equal(f?.subPath, "Season 1", "整理改过的落点要留住");
  assert.match(f?.detail ?? "", /下载中 10%/, "这一轮的进度照样写进去");
});

test("一轮中途同一个磁力被重新登记：按新登记的算，不被这一轮的结果盖成已完成", async () => {
  await seed();
  pages = [[row({})]];
  onGenerate = async () => {
    // 登记时间要和上一条分得开：同一毫秒里登记的分不出新旧
    await new Promise((resolve) => setTimeout(resolve, 2));
    await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", subPath: "S1" });
    await stopOfflineWatcher();
  };
  await tickFollowups();
  assert.equal(listFollowups().length, 1);
  assert.equal(listFollowups()[0].status, "pending", "新登记的那条等下一轮自己去对");
});
