/**
 * 机器人的命令、链接、按钮：所有外部依赖都是桩，只验证"谁能做什么、调了什么、回了什么"。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/telegram/commands.test.ts
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { AppSettings, LibraryHit, LibrarySearchResult, OAuthPendingRequest, ResourceHit, ResourceKind, TaskDefinition, TaskExecutionSummary } from "@openstrm/shared";
import type { SettledResult } from "../pansou/search.js";
import type { BotLike, InlineKeyboard, TelegramUpdate } from "./bot.js";
import { __test_waitSearches, handleUpdate, setCommandDeps, type CommandDeps } from "./commands.js";
import { __test_clearPending } from "./session.js";

type Sent = { chatId: string; text: string; buttons?: InlineKeyboard };
const sent: Sent[] = [];
const edited: Sent[] = [];
const answered: string[] = [];
/** 设了就让 editMessage 失败：和 TelegramBot 在 Bot API 回 400 时一个样，原话在 error 里（见 bot.itest.ts） */
let editFailure: string | null = null;
const NOT_MODIFIED = "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message";
const bot: BotLike = {
  async sendMessage(chatId, text, opts) {
    sent.push({ chatId: String(chatId), text, buttons: opts?.buttons });
    return { ok: true, result: { message_id: 1 } };
  },
  async editMessage(chatId, _id, text, buttons) {
    if (editFailure) return { ok: false, error_code: 400, error: editFailure };
    edited.push({ chatId: String(chatId), text, buttons });
    return { ok: true };
  },
  async answerCallback(_id, text) {
    answered.push(text ?? "");
    return { ok: true };
  },
};

const tasks: TaskDefinition[] = [
  { id: "t1", account: "115", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt", cronExpression: "0 3 * * *" },
  { id: "t2", account: "ol", accountType: "openlist", originPath: "kuake/anime", targetPath: "anime", strmPrefix: "http://x" },
];
const run = (over: Partial<TaskExecutionSummary>): TaskExecutionSummary => ({
  id: "e1", taskId: "t1", startTime: Date.now() - 60_000, endTime: Date.now(), status: "completed",
  summary: { totalFiles: 10, downloadedFiles: 10, deletedFiles: 0 },
  taskInfo: { account: "115", originPath: "tv", targetPath: "tv", removeExtraFiles: false },
  ...over,
});

let settings: AppSettings;
const calls: Array<{ fn: string; args: unknown }> = [];
let running: string[] = [];
/** 桩 115 目录树：segments.join("/") → 子目录名 */
let subdirTree: Record<string, string[]> = {};
let subdirError: Error | null = null;
/** 桩 OpenList 目录树：完整路径 → 子目录名 */
let olDirTree: Record<string, string[]> = {};
/** 资源搜索的桩：配没配、搜出来什么、要不要出错 */
let searchConfigured = false;
let searchResult: SettledResult = { keyword: "", complete: true, counts: {}, items: [] };
const NO_LIBRARY: LibrarySearchResult = { hits: [], total: 0, expired: 0, indexing: 0 };
let libraryResult: LibrarySearchResult = NO_LIBRARY;
let libraryHas = false;

/** 影库里的一条（只填 Telegram 用得到的） */
const libHit = (name: string, over: Partial<LibraryHit> = {}): LibraryHit => ({
  sourceId: "s1",
  nodeId: "n1",
  parentId: "p1",
  name,
  path: `老K/1. 电影/${name}`,
  crumbs: [
    { id: "k", name: "老K" },
    { id: "m", name: "1. 电影" },
    { id: "n1", name },
  ],
  shareKind: "115",
  shareCode: "pack",
  shareUrl: "https://115.com/s/pack?password=ab12",
  shareTitle: "老K",
  size: 51 * 1024 ** 3,
  videoCount: 1,
  files: [],
  subdirs: [],
  subdirCount: 0,
  tags: [],
  matched: "name",
  childHits: 0,
  keyword: name,
  health: { status: "ok", reason: "", checkedAt: null, expiredAt: null },
  indexedAt: null,
  ...over,
});
let searchError: Error | null = null;
/** 设了就让搜索卡在这里，放行了才出结果 */
let searchGate: Promise<void> | null = null;

const hit = (kind: ResourceKind, i: number): ResourceHit => ({
  key: `${kind}:${i}`,
  kind,
  panType: kind === "other" ? "baidu" : kind,
  panLabel: kind === "other" ? "百度" : kind,
  url:
    kind === "115"
      ? `https://115.com/s/sw${String(i).padStart(9, "0")}?password=ab12`
      : kind === "quark"
        ? `https://pan.quark.cn/s/q${i}`
        : kind === "magnet"
          ? `magnet:?xt=urn:btih:${String(i).padStart(40, "a")}`
          : `https://pan.baidu.com/s/${i}`,
  title: `片 ${i}`,
  publishedAt: "2025-01-02T12:00:00Z",
  source: { type: "tg", name: "chan" },
  // 桩账号里 115、夸克都有：分享能转存、磁力能云下载；别家网盘什么也做不了
  action: kind === "115" || kind === "quark" ? "share" : kind === "other" ? null : "offline",
});

/** 待批准的授权请求：只有这两个配对码有（不带连字符、空一格也认） */
const pendingCodes = new Set(["WXYZ2345", "HJKLMNPQ"]);
const oauthRequest: OAuthPendingRequest = {
  id: "r1", clientId: "c1", clientName: "Claude", clientKind: "dcr", clientHost: null, redirectHost: "claude.ai",
  redirectInsecure: false, redirectLoopback: false, passwordApproval: false, requestedScopes: [], ip: "1.2.3.4", createdAt: 0, expiresAt: 0,
};
/** 桩追更：f1 起了名；f2 没起名（名字就是分享码）；f3 名字填的是链接；f4 名字里拿不出片名 */
const follows: Record<string, { name: string; shareCode: string }> = {
  f1: { name: "【完结】繁花 (2023) / S1", shareCode: "swf1code001" },
  f2: { name: "sw3xk9pq2mz", shareCode: "sw3xk9pq2mz" },
  f3: { name: "https://115.com/s/sw3xk9pq2mz?password=ab12", shareCode: "sw3xk9pq2mz" },
  f4: { name: " ", shareCode: "q4code" },
};

const deps: Partial<CommandDeps> = {
  settings: () => settings,
  listTasks: () => tasks,
  accounts: () => [
    { name: "115", kind: "115", share: true },
    { name: "ol", kind: "openlist", share: false },
  ],
  latestExecutions: () => new Map([["t1", run({})]]),
  recentExecutions: () => [run({}), run({ id: "e2", taskId: "t2", status: "failed", summary: { totalFiles: 3, downloadedFiles: 1, deletedFiles: 0, failedFiles: 2, errorMessage: "2 个文件失败：a、b" } })],
  taskExecutions: (taskId) => (taskId === "t1" ? [run({})] : []),
  runningTaskIds: () => running,
  runningPercent: () => "42.10",
  startTask: async (taskId) => { calls.push({ fn: "startTask", args: taskId }); return { ok: true, message: "开始处理 5 个文件" }; },
  cancelTask: (taskId) => { calls.push({ fn: "cancelTask", args: taskId }); return running.includes(taskId); },
  addOffline: async (input) => {
    calls.push({ fn: "addOffline", args: input });
    return { account: "115", dirId: "9", dirPath: "tv", added: 1, failed: 1, invalid: [],
      followup: Boolean(input.taskId) || input.copyToOpenlist === true,
      strmFollowup: Boolean(input.taskId),
      copyDstDir: input.copyToOpenlist === true ? (input.copyDstDir ?? "/local") : null,
      copyAfterCopy: "keep",
      // 和真服务一样：引擎是添加时核对配置用的那一家
      copyEngine: input.copyToOpenlist === true ? (settings.openlistCopy?.engine === "cd2" ? "cd2" : "openlist") : null,
      copyBlocked: null,
      results: [{ url: "magnet:?xt=urn:btih:aaa", ok: true, infoHash: "h" }, { url: "magnet:?xt=urn:btih:bbb", ok: false, message: "任务已存在" }] };
  },
  listOffline: async () => ({ tasks: [{ name: "Show.mkv", state: "done", statusText: "下载成功", percent: 100 }], count: 1, quota: 5, total: 10 }),
  offlinePending: () => 2,
  lifeStatus: () => ({ running: true, accounts: [{ name: "115", running: true, lastError: null }] }),
  shareInfo: async (link) => {
    calls.push({ fn: "shareInfo", args: link });
    return { link, kind: "115", name: "剧集合集", count: 2, items: [{ id: "1", name: "S01", isDir: true, token: "t1" }, { id: "2", name: "readme.txt", isDir: false }] };
  },
  receiveShare: async (input) => { calls.push({ fn: "receiveShare", args: input }); return { ok: true, message: "已转存，后台同步已启动" }; },
  listSubdirs: async (task, segments) => {
    calls.push({ fn: "listSubdirs", args: { taskId: task.id, segments } });
    if (subdirError) throw subdirError;
    return subdirTree[segments.join("/")] ?? [];
  },
  listOpenlistDirs: async (path) => {
    calls.push({ fn: "listOpenlistDirs", args: path });
    return olDirTree[path] ?? [];
  },
  resourceSearchConfigured: () => searchConfigured,
  searchLibrary: () => libraryResult,
  libraryHasSources: () => libraryHas,
  searchResources: async (keyword) => {
    calls.push({ fn: "searchResources", args: keyword });
    if (searchGate) await searchGate;
    if (searchError) throw searchError;
    return searchResult;
  },
  findOAuthByCode: (code) => (pendingCodes.has(code.toUpperCase().replace(/[\s-]/g, "")) ? oauthRequest : null),
  shareFollow: (id) => follows[id] ?? null,
};

const msg = (text: string, o: { user?: number; chat?: number; type?: string } = {}): TelegramUpdate => ({
  update_id: 1,
  message: {
    message_id: 10,
    from: { id: o.user ?? 42, is_bot: false, first_name: "A" },
    chat: { id: o.chat ?? o.user ?? 42, type: o.type ?? "private" },
    date: 0,
    text,
  },
});
const cb = (data: string, o: { user?: number; chat?: number; type?: string } = {}): TelegramUpdate => ({
  update_id: 2,
  callback_query: {
    id: "q",
    from: { id: o.user ?? 42, is_bot: false, first_name: "A" },
    message: { message_id: 10, chat: { id: o.chat ?? o.user ?? 42, type: o.type ?? "private" }, date: 0 },
    data,
  },
});
const lastButtons = () => sent[sent.length - 1].buttons ?? [];
const findButton = (needle: string) => lastButtons().flat().find((b) => b.text.includes(needle));

beforeEach(() => {
  settings = { telegram: { botToken: "t", chatId: "-100", allowedUsers: [42], allowTaskStart: false, allowOfflineAdd: false, allowShareReceive: false } };
  sent.length = 0; edited.length = 0; answered.length = 0; calls.length = 0; running = [];
  subdirTree = { "": ["某剧", "另一部"], "某剧": ["Season 1"], "某剧/Season 1": [] };
  subdirError = null;
  olDirTree = {};
  searchConfigured = false;
  searchResult = { keyword: "", complete: true, counts: {}, items: [] };
  libraryResult = NO_LIBRARY;
  libraryHas = false;
  searchError = null;
  searchGate = null;
  editFailure = null;
  __test_clearPending();
  setCommandDeps(deps);
});
after(() => setCommandDeps(null));

test("权限：私聊里的陌生人得到自己的 id；群里的陌生人被无视；非指定群里的白名单用户也被无视", async () => {
  await handleUpdate(bot, msg("/tasks", { user: 7 }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<code>7<\/code>/);
  await handleUpdate(bot, msg("/tasks", { user: 7, chat: -100, type: "supergroup" }));
  assert.equal(sent.length, 1, "群里不理陌生人");
  await handleUpdate(bot, msg("/tasks", { user: 42, chat: -200, type: "supergroup" }));
  assert.equal(sent.length, 1, "不是配置的那个群也不理");
  await handleUpdate(bot, msg("/tasks@openstrm_bot", { user: 42, chat: -100, type: "supergroup" }));
  assert.equal(sent.length, 2, "指定的群里响应，且能处理 /cmd@bot 的写法");
  assert.match(sent[1].text, /任务（2）/);
});

test("/tasks：列出任务、上次结果、定时；未开启启动权限时没有「运行」按钮并有提示", async () => {
  await handleUpdate(bot, msg("/tasks"));
  const { text } = sent[0];
  assert.match(text, /tv → tv/);
  assert.match(text, /kuake\/anime → anime/);
  assert.match(text, /✅ 成功 · 10\/10 个文件/);
  assert.match(text, /<code>0 3 \* \* \*<\/code>/);
  assert.match(text, /「运行」按钮未开启/);
  assert.equal(findButton("运行"), undefined);
  assert.ok(findButton("记录"));

  settings.telegram!.allowTaskStart = true;
  sent.length = 0;
  await handleUpdate(bot, msg("/tasks"));
  assert.equal(findButton("运行")?.callback_data, "run:t1");
});

test("运行按钮：关着时只提示；开着时经 startTask 启动并回结果；回调也过白名单", async () => {
  await handleUpdate(bot, cb("run:t1"));
  assert.equal(calls.length, 0, "未开启不能启动");
  assert.match(sent[0].text, /未开启/);

  settings.telegram!.allowTaskStart = true;
  sent.length = 0;
  await handleUpdate(bot, cb("run:t1"));
  assert.deepEqual(calls, [{ fn: "startTask", args: "t1" }]);
  assert.match(sent[0].text, /🚀 <b>tv → tv<\/b>\n开始处理 5 个文件/);

  calls.length = 0;
  await handleUpdate(bot, cb("run:t1", { user: 7 }));
  assert.equal(calls.length, 0, "陌生人点按钮不能启动");
  assert.equal(answered.at(-1), "没有权限");
});

test("/status 和 /cancel：正在跑的任务带进度，取消按钮走 cancelTask", async () => {
  running = ["t1"];
  await handleUpdate(bot, msg("/status"));
  assert.match(sent[0].text, /🔄 tv → tv · 42.10%/);
  assert.match(sent[0].text, /2 个下载完成后待生成 strm/);
  assert.match(sent[0].text, /网盘监控：运行中（账号 115）/);

  await handleUpdate(bot, msg("/cancel"));
  assert.equal(findButton("tv")?.callback_data, "cancel:t1");
  await handleUpdate(bot, cb("cancel:t1"));
  assert.deepEqual(calls, [{ fn: "cancelTask", args: "t1" }]);
  assert.match(sent.at(-1)!.text, /已取消 tv → tv/);

  running = [];
  sent.length = 0;
  await handleUpdate(bot, msg("/cancel"));
  assert.match(sent[0].text, /没有正在运行的任务/);
});

test("/history、记录按钮、/offline", async () => {
  await handleUpdate(bot, msg("/history"));
  assert.match(sent[0].text, /kuake\/anime → anime[\s\S]*❌ 失败 · 2 个文件失败：a、b/);
  await handleUpdate(bot, cb("hist:t1"));
  assert.match(sent[1].text, /<b>tv → tv<\/b>\n\n✅ 成功/);
  await handleUpdate(bot, cb("hist:t2"));
  assert.match(sent[2].text, /还没有执行记录/);
  await handleUpdate(bot, msg("/offline"));
  assert.match(sent[3].text, /共 1，配额剩余 5\/10[\s\S]*✅ Show\.mkv · 下载成功/);
});

test("贴磁力链接：选任务后先浏览子目录，可逐层进入，「就放这里」才提交 addOffline", async () => {
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa\nmagnet:?xt=urn:btih:bbb"));
  assert.match(sent[0].text, /云下载功能未开启/);

  settings.telegram!.allowOfflineAdd = true;
  sent.length = 0;
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa\nmagnet:?xt=urn:btih:bbb\nthunder://x"));
  assert.match(sent[0].text, /收到 2 条链接/);
  const dest = findButton("tv")!;
  assert.match(dest.callback_data, /^ofl:[\w-]+:t1$/);
  assert.equal(findButton("anime"), undefined, "openlist 账号的任务不能当云下载目的地");
  assert.ok(findButton("115 默认目录"));

  // 选任务 → 列 originPath 这一层，消息被改成浏览界面
  await handleUpdate(bot, cb(dest.callback_data));
  assert.deepEqual(calls, [{ fn: "listSubdirs", args: { taskId: "t1", segments: [] } }]);
  assert.match(edited[0].text, /下载到：<b>tv<\/b>[\s\S]*子文件夹 2 个/);
  const flat0 = edited[0].buttons!.flat();
  assert.ok(flat0.some((b) => b.text.includes("就放这里")));
  assert.equal(flat0.some((b) => b.text.includes("返回上一级")), false, "根上没有返回");

  // 进入 某剧 → 再进 Season 1（空目录）
  calls.length = 0;
  await handleUpdate(bot, cb(flat0.find((b) => b.text.includes("某剧"))!.callback_data));
  assert.deepEqual(calls, [{ fn: "listSubdirs", args: { taskId: "t1", segments: ["某剧"] } }]);
  assert.match(edited[1].text, /下载到：<b>tv\/某剧<\/b>/);
  await handleUpdate(bot, cb(edited[1].buttons!.flat().find((b) => b.text.includes("Season 1"))!.callback_data));
  assert.match(edited[2].text, /tv\/某剧\/Season 1[\s\S]*没有子文件夹/);
  assert.ok(edited[2].buttons!.flat().some((b) => b.text.includes("返回上一级")));

  // 就放这里 → 带 subPath 提交，结果写回原消息
  const go = edited[2].buttons!.flat().find((b) => b.text.includes("就放这里"))!;
  calls.length = 0;
  await handleUpdate(bot, cb(go.callback_data));
  assert.deepEqual(calls, [
    { fn: "addOffline", args: { urls: "magnet:?xt=urn:btih:aaa\nmagnet:?xt=urn:btih:bbb", taskId: "t1", subPath: "某剧/Season 1" } },
  ]);
  assert.match(edited[3].text, /已添加 1 个云下载[\s\S]*目录：tv\/某剧\/Season 1，下完自动生成 strm[\s\S]*未接受 1 条[\s\S]*任务已存在/);

  await handleUpdate(bot, cb(go.callback_data));
  assert.equal(calls.length, 1, "提交后 token 已取走，再点不会重复提交");
  assert.equal(answered.at(-1), "已过期，请重新发一次链接");
});

test("贴磁力链接：配置了 OpenList 复制才多一个目的地按钮，可进目的子目录再提交", async () => {
  settings.telegram!.allowOfflineAdd = true;
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa"));
  assert.equal(findButton("OpenList 复制走"), undefined, "没配置就不给按钮");

  settings.openlistCopy = { account: "ol", dstDir: "/local/dl/" };
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa"));
  assert.equal(findButton("OpenList 复制走"), undefined, "这个 115 账号没填挂载根也不给");

  settings.openlistCopy = { account: "ol", dstDir: "/local/dl/", mounts: { "115": "/115" } };
  olDirTree = { "/local/dl": ["movies", "tv"], "/local/dl/movies": [] };
  sent.length = 0;
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa"));
  const btn = findButton("OpenList 复制走")!;
  assert.match(btn.callback_data, /^ofl:[\w-]+:defcopy$/);

  // 点按钮 → 从设置的 dstDir 出发浏览（尾斜杠归一化）
  calls.length = 0;
  await handleUpdate(bot, cb(btn.callback_data));
  assert.deepEqual(calls, [{ fn: "listOpenlistDirs", args: "/local/dl" }]);
  assert.match(edited[0].text, /115 下完后，OpenList 复制到：<b>\/local\/dl<\/b>[\s\S]*子文件夹 2 个/);
  const flat0 = edited[0].buttons!.flat();
  assert.ok(flat0.some((b) => b.text.includes("就复制到这里")));

  // 进 movies → 就复制到这里 → 带 copyDstDir 提交
  await handleUpdate(bot, cb(flat0.find((b) => b.text.includes("movies"))!.callback_data));
  assert.match(edited[1].text, /OpenList 复制到：<b>\/local\/dl\/movies<\/b>[\s\S]*没有子文件夹/);
  const go = edited[1].buttons!.flat().find((b) => b.text.includes("就复制到这里"))!;
  calls.length = 0;
  await handleUpdate(bot, cb(go.callback_data));
  assert.deepEqual(calls, [
    { fn: "addOffline", args: { urls: "magnet:?xt=urn:btih:aaa", copyToOpenlist: true, copyDstDir: "/local/dl/movies" } },
  ]);
  assert.match(edited[2].text, /已添加 1 个云下载[\s\S]*目录：115 默认目录，下完让 OpenList 复制到 \/local\/dl\/movies/);

  await handleUpdate(bot, cb(go.callback_data));
  assert.equal(calls.length, 1, "提交后 token 已取走，再点不会重复提交");
});

test("贴磁力链接：复制引擎选的是 CloudDrive2 时按钮和回话都说 CloudDrive2，配没配看 CD2 那一份", async () => {
  settings.telegram!.allowOfflineAdd = true;
  // OpenList 那份齐全也不算：引擎选了 CD2，按钮出不出只看设置页「网盘挂载」里 CloudDrive2 的账号和路径
  settings.openlistCopy = { engine: "cd2", account: "ol", dstDir: "/hdd/media", mounts: { "115": "/115" } };
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa"));
  assert.equal(findButton("复制走"), undefined, "CD2 还没选账号就不给按钮");

  settings.cd2 = { account: "nas-cd2", mounts: { "115": "/115open" } };
  olDirTree = { "/hdd/media": [] };
  sent.length = 0;
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa"));
  assert.equal(findButton("OpenList 复制走"), undefined);
  const btn = findButton("CloudDrive2 复制走")!;
  assert.match(btn.text, /115 默认目录，下完让 CloudDrive2 复制走/);

  await handleUpdate(bot, cb(btn.callback_data));
  assert.match(edited[0].text, /115 下完后，CloudDrive2 复制到：<b>\/hdd\/media<\/b>/);
  const go = edited[0].buttons!.flat().find((b) => b.text.includes("就复制到这里"))!;
  await handleUpdate(bot, cb(go.callback_data));
  assert.match(edited[1].text, /目录：115 默认目录，下完让 CloudDrive2 复制到 \/hdd\/media/);
});

test("浏览：翻页不重新列目录，返回上一级重列，列目录失败原地重试", async () => {
  settings.telegram!.allowOfflineAdd = true;
  subdirTree = { "": Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 部`), "第 1 部": [] };
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa"));
  await handleUpdate(bot, cb(findButton("tv")!.callback_data));

  // 12 个子目录：第一页 10 个 + 下一页
  let flat = edited[0].buttons!.flat();
  assert.match(edited[0].text, /子文件夹 12 个（第 1\/2 页）/);
  assert.ok(flat.some((b) => b.text.includes("第 10 部")));
  assert.equal(flat.some((b) => b.text.includes("第 11 部")), false);
  calls.length = 0;
  await handleUpdate(bot, cb(flat.find((b) => b.text.includes("下一页"))!.callback_data));
  assert.equal(calls.length, 0, "翻页不重新列目录");
  flat = edited[1].buttons!.flat();
  assert.ok(flat.some((b) => b.text.includes("第 11 部")));
  assert.ok(flat.some((b) => b.text.includes("上一页")));

  // 从第二页进目录再返回：回到第一页视角
  await handleUpdate(bot, cb(flat.find((b) => b.text.includes("第 11 部"))!.callback_data));
  assert.match(edited[2].text, /下载到：<b>tv\/第 11 部<\/b>/);
  await handleUpdate(bot, cb(edited[2].buttons!.flat().find((b) => b.text.includes("返回上一级"))!.callback_data));
  assert.match(edited[3].text, /下载到：<b>tv<\/b>/);

  // 列目录失败：报错但 token 没被取走，重点一次就是重试
  subdirError = new Error("115 接口超时");
  const into = edited[3].buttons!.flat().find((b) => b.text.includes("第 1 部"))!;
  await handleUpdate(bot, cb(into.callback_data));
  assert.match(sent.at(-1)!.text, /操作失败[\s\S]*115 接口超时/);
  subdirError = null;
  await handleUpdate(bot, cb(into.callback_data));
  assert.match(edited.at(-1)!.text, /下载到：<b>tv\/第 1 部<\/b>/);
});

test("贴磁力链接：默认目录不带 taskId；别人不能点我的按钮；「取消」把消息改成已取消", async () => {
  settings.telegram!.allowOfflineAdd = true;
  await handleUpdate(bot, msg("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  const dflt = findButton("115 默认目录")!;
  const drop = findButton("取消")!;
  await handleUpdate(bot, cb(dflt.callback_data, { user: 7 }));
  assert.equal(calls.length, 0);
  await handleUpdate(bot, cb(dflt.callback_data));
  assert.deepEqual(calls[0], { fn: "addOffline", args: { urls: "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });

  sent.length = 0; edited.length = 0;
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:ccc"));
  const drop2 = findButton("取消")!;
  await handleUpdate(bot, cb(drop2.callback_data));
  assert.match(edited[0].text, /已取消/);
  void drop;
});

test("贴 115 分享链接：读分享、选任务 → 浏览子目录 → 「就存这里」带 subPath 走 receiveShare", async () => {
  await handleUpdate(bot, msg("https://115cdn.com/s/swhk9bx3wwq?password=sff1"));
  assert.match(sent[0].text, /分享转存功能未开启/);

  settings.telegram!.allowShareReceive = true;
  sent.length = 0;
  await handleUpdate(bot, msg("看看这个 https://115cdn.com/s/swhk9bx3wwq?password=sff1 不错"));
  assert.deepEqual(calls, [{ fn: "shareInfo", args: "https://115cdn.com/s/swhk9bx3wwq?password=sff1" }]);
  assert.match(sent[0].text, /📦 <b>剧集合集<\/b>\n📁 S01\n📄 readme\.txt/);
  const dest = findButton("转存到 tv")!;
  calls.length = 0;
  await handleUpdate(bot, cb(dest.callback_data));
  assert.deepEqual(calls, [{ fn: "listSubdirs", args: { taskId: "t1", segments: [] } }]);
  assert.match(edited[0].text, /📦 <b>剧集合集<\/b>\n转存到：<b>tv<\/b>/);

  await handleUpdate(bot, cb(edited[0].buttons!.flat().find((b) => b.text.includes("某剧"))!.callback_data));
  const go = edited[1].buttons!.flat().find((b) => b.text.includes("就存这里"))!;
  calls.length = 0;
  await handleUpdate(bot, cb(go.callback_data));
  assert.equal(calls[0].fn, "receiveShare");
  // deepEqual 的断言签名把 calls 收窄成了 args: string，这里要先绕回 unknown
  const args = calls[0].args as unknown as { task: TaskDefinition; link: string; items: Array<{ id: string; token?: string }>; subPath: string };
  assert.equal(args.task.id, "t1");
  assert.equal(args.link, "https://115cdn.com/s/swhk9bx3wwq?password=sff1");
  assert.deepEqual(args.items.map((i) => i.id), ["1", "2"]);
  assert.equal(args.items[0].token, "t1", "夸克转存要的 token 跟着条目一起带过去");
  assert.equal(args.subPath, "某剧");
  assert.match(edited[2].text, /✅ <b>剧集合集<\/b>\n目录：tv\/某剧\n已转存，后台同步已启动/);
});

test("其它文本：不认识的链接和闲聊各有提示；/help 说明当前开关状态；/id 回 chat id", async () => {
  await handleUpdate(bot, msg("thunder://abc"));
  assert.match(sent[0].text, /不认识这种链接/);
  await handleUpdate(bot, msg("你好"));
  assert.match(sent[1].text, /直接把 115 \/ 夸克分享链接/);
  await handleUpdate(bot, msg("/help"));
  assert.match(sent[2].text, /未开启，到 Telegram 页打开/);
  await handleUpdate(bot, msg("/id"));
  assert.match(sent[3].text, /<code>42<\/code>/);
});

test("/s：没带关键词给用法；没配资源搜索说去设置，不发请求", async () => {
  await handleUpdate(bot, msg("/s"));
  assert.match(sent[0].text, /用法/);
  await handleUpdate(bot, msg("/s 沙丘2"));
  assert.match(sent[1].text, /还没配置资源搜索/);
  assert.equal(calls.length, 0);
});

test("/s：没配资源搜索、收藏夹里有：只列收藏夹的，说网上要先配；疑似失效的标出来", async () => {
  libraryResult = { hits: [libHit("阿甘正传 4K原盘REMUX"), libHit("阿甘正传 1080P", { nodeId: "n2", health: { status: "suspect", reason: "", checkedAt: null, expiredAt: null } })], total: 5, expired: 0, indexing: 0 };
  await handleUpdate(bot, msg("/s 阿甘正传"));
  const text = sent[0].text;
  assert.match(text, /🔖 <b>收藏夹里有 5 条<\/b>（列前 2 条）/);
  assert.match(text, /• 阿甘正传 4K原盘REMUX · 51\.0G\n {2}<i>老K \/ 1\. 电影<\/i>/, "分享标题和第一层同名不重复");
  assert.match(text, /阿甘正传 1080P · 51\.0G · <i>可能已失效<\/i>/);
  assert.match(text, /只搜了收藏夹/);
  assert.equal(calls.length, 0, "没配 PanSou 不去问它");
});

test("/s：收藏夹里认出来的作品带上 TMDB 的名字和年份，把握低的说「可能是」", async () => {
  libraryResult = {
    hits: [
      libHit("Forrest.Gump.1994.2160p", { work: { tmdbId: 13, mediaType: "movie", title: "阿甘正传", year: "1994", posterUrl: "", confidence: "high" } }),
      libHit("第1部 4K原盘REMUX", { nodeId: "n2", work: { tmdbId: 102899, mediaType: "movie", title: "蚁人", year: "2015", posterUrl: "", confidence: "low" } }),
    ],
    total: 2,
    expired: 0,
    indexing: 0,
  };
  await handleUpdate(bot, msg("/s 阿甘正传"));
  const text = sent[0].text;
  assert.match(text, /• Forrest\.Gump\.1994\.2160p · 《阿甘正传》1994 · 51\.0G/);
  assert.match(text, /• 第1部 4K原盘REMUX · 可能是《蚁人》2015/);
});

test("/s：配了资源搜索，收藏夹一段在列表最上面，翻页也还在；网上一条都列不出来时先给收藏夹的", async () => {
  searchConfigured = true;
  libraryResult = { hits: [libHit("沙丘2 4K原盘REMUX")], total: 1, expired: 0, indexing: 0 };
  searchResult = { keyword: "沙丘2", complete: true, counts: {}, items: Array.from({ length: 12 }, (_, i) => hit("115", i)) };
  await searchVia(msg("/s 沙丘2"));
  const list = edited[0];
  assert.match(list.text, /^🔖 <b>收藏夹里有 1 条<\/b>[\s\S]*沙丘2 4K原盘REMUX[\s\S]*\n\n🔍 <b>沙丘2<\/b>/);
  await handleUpdate(bot, cb(list.buttons!.flat().find((b) => b.text === "➡️ 下一页")!.callback_data));
  assert.match(edited.at(-1)!.text, /^🔖 <b>收藏夹里有 1 条/);

  searchResult = { keyword: "沙丘2", complete: true, counts: {}, items: [] };
  await searchVia(msg("/s 沙丘2"));
  assert.match(edited.at(-1)!.text, /^🔖 <b>收藏夹里有 1 条[\s\S]*网上：没搜到「沙丘2」/);
});

test("私聊直接发片名：没配资源搜索、但收藏夹里有收藏也照样搜", async () => {
  libraryHas = true;
  libraryResult = { hits: [libHit("繁花")], total: 1, expired: 0, indexing: 0 };
  await handleUpdate(bot, msg("繁花", { type: "private" }));
  assert.match(sent[0].text, /收藏夹里有 1 条/);
});

/** 发一条消息 / 点一个按钮，再等后台的搜索跑完 */
async function searchVia(update: TelegramUpdate): Promise<void> {
  await handleUpdate(bot, update);
  await __test_waitSearches();
}

test("/s：先回「在搜」，结果出来改成列表；只列接得住的几类；序号、下一页、只看某类", async () => {
  searchConfigured = true;
  searchResult = {
    keyword: "沙丘2",
    complete: true,
    counts: {},
    items: [...Array.from({ length: 6 }, (_, i) => hit("115", i)), ...Array.from({ length: 4 }, (_, i) => hit("magnet", i + 10)), hit("other", 99)],
  };
  await searchVia(msg("/s 沙丘2"));
  assert.match(sent[0].text, /在搜「沙丘2」/);
  assert.deepEqual(calls, [{ fn: "searchResources", args: "沙丘2" }]);
  const list = edited[0];
  assert.match(list.text, /🔍 <b>沙丘2<\/b> · 115 6 · 磁力 4\n\n/);
  assert.match(list.text, /1\. \[115\] 片 0 · 2025-01-0\d/);
  assert.doesNotMatch(list.text, /片 99/, "别家网盘在 Telegram 里什么也做不了，不列");
  assert.doesNotMatch(list.text, /每类只列前/);
  assert.match(list.text, /第 1\/2 页/);
  const texts = list.buttons!.flat().map((b) => b.text);
  assert.deepEqual(texts.slice(0, 8), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.ok(texts.includes("只看115") && texts.includes("只看磁力") && texts.includes("➡️ 下一页") && texts.includes("取消"));

  await handleUpdate(bot, cb(list.buttons!.flat().find((b) => b.text === "➡️ 下一页")!.callback_data));
  assert.match(edited[1].text, /9\. \[磁力\] 片 12/);
  assert.match(edited[1].text, /第 2\/2 页/);
  await handleUpdate(bot, cb(list.buttons!.flat().find((b) => b.text === "只看磁力")!.callback_data));
  assert.match(edited[2].text, /1\. \[磁力\] 片 10/);
  assert.doesNotMatch(edited[2].text, /\[115\]/);
  assert.ok(edited[2].buttons!.flat().some((b) => b.text === "全部"));
});

test("/s：每类只留前 15 条、表头是搜到的总数，一类多了不把后面几类挤没；没账号接得住的那几类不列", async () => {
  searchConfigured = true;
  const many = (kind: ResourceKind, n: number, from: number, usable = true) =>
    Array.from({ length: n }, (_, i) => ({ ...hit(kind, from + i), ...(usable ? {} : { action: null }) }));
  searchResult = { keyword: "三体", complete: true, counts: {}, items: [...many("115", 70, 0), ...many("quark", 30, 100), ...many("magnet", 20, 200)] };
  await searchVia(msg("/s 三体"));
  const all = edited.at(-1)!;
  assert.match(all.text, /🔍 <b>三体<\/b> · 115 70 · 夸克 30 · 磁力 20\n每类只列前 15 条/);
  assert.match(all.text, /第 1\/6 页/, "三类各 15 条，一页 8 条");
  assert.deepEqual(
    all.buttons!.flat().filter((b) => b.text.startsWith("只看")).map((b) => b.text),
    ["只看115", "只看夸克", "只看磁力"],
  );
  await handleUpdate(bot, cb(all.buttons!.flat().find((b) => b.text === "只看磁力")!.callback_data));
  assert.match(edited.at(-1)!.text, /1\. \[磁力\] 片 200/);
  assert.match(edited.at(-1)!.text, /第 1\/2 页/);

  // 只有夸克账号：115 分享和磁力点了只会报「先加账号」，不列
  searchResult = { ...searchResult, items: [...many("115", 70, 0, false), ...many("quark", 3, 100), ...many("magnet", 20, 200, false)] };
  await searchVia(msg("/s 三体"));
  assert.match(edited.at(-1)!.text, /🔍 <b>三体<\/b> · 夸克 3\n\n1\. \[夸克\]/);
  assert.doesNotMatch(edited.at(-1)!.text, /\[115\]|\[磁力\]/);
  assert.ok(!edited.at(-1)!.buttons!.flat().some((b) => b.text.startsWith("只看")));

  searchResult = { ...searchResult, items: [...many("115", 70, 0, false), ...many("magnet", 2, 200, false)] };
  await searchVia(msg("/s 三体"));
  assert.match(edited.at(-1)!.text, /搜到 115 70 条、磁力 2 条，但还没有接得住的账号/);
});

test("/s 结果里点序号：分享走转存那条路、磁力走云下载那条路，各自的开关照查；同一个列表能点好几次；别人点不了；订过追更的标出来", async () => {
  searchConfigured = true;
  searchResult = {
    keyword: "k",
    complete: true,
    counts: {},
    items: [{ ...hit("115", 1), followed: "active" }, { ...hit("quark", 3), followed: "stopped" }, hit("magnet", 2)],
  };
  settings.telegram!.allowedUsers = [42, 43];
  await searchVia(msg("/s k"));
  assert.match(edited[0].text, /1\. \[115\] 片 1 · 2025-01-0\d · <i>已在追更<\/i>/);
  assert.match(edited[0].text, /2\. \[夸克\] 片 3 · 2025-01-0\d · <i>追更已停<\/i>/);
  assert.doesNotMatch(edited[0].text, /3\. .*追更/);
  const buttons = edited[0].buttons!.flat();
  const one = buttons.find((b) => b.text === "1")!;
  const three = buttons.find((b) => b.text === "3")!;

  await handleUpdate(bot, cb(one.callback_data, { user: 43 }));
  assert.equal(answered.at(-1), "这不是你发起的搜索");
  await handleUpdate(bot, cb(one.callback_data));
  assert.match(sent.at(-1)!.text, /分享转存功能未开启/);
  settings.telegram!.allowShareReceive = true;
  calls.length = 0;
  await handleUpdate(bot, cb(one.callback_data));
  assert.deepEqual(calls, [{ fn: "shareInfo", args: hit("115", 1).url }]);
  assert.match(sent.at(-1)!.text, /📦 <b>剧集合集<\/b>/);

  await handleUpdate(bot, cb(three.callback_data));
  assert.match(sent.at(-1)!.text, /云下载功能未开启/);
  settings.telegram!.allowOfflineAdd = true;
  await handleUpdate(bot, cb(three.callback_data));
  assert.match(sent.at(-1)!.text, /收到 1 条链接/);
});

test("私聊里直接发片名就搜；群里只认 /s；像配对码的片名照样搜，写成 XXXX-XXXX 的、数字字母混着的、或者真有待批准请求的才当配对码", async () => {
  searchConfigured = true;
  searchResult = { keyword: "繁花", complete: true, counts: {}, items: [hit("quark", 1)] };
  await searchVia(msg("繁花"));
  assert.deepEqual(calls, [{ fn: "searchResources", args: "繁花" }]);
  calls.length = 0;
  await searchVia(msg("繁花", { chat: -100, type: "supergroup" }));
  assert.equal(calls.length, 0);
  assert.match(sent.at(-1)!.text, /搜资源用 \/s 片名/);
  await searchVia(msg("/s@openstrm_bot 繁花", { chat: -100, type: "supergroup" }));
  assert.deepEqual(calls, [{ fn: "searchResources", args: "繁花" }]);

  // Superman、The Flash 都凑得上配对码的字母表
  calls.length = 0;
  await searchVia(msg("Superman"));
  await searchVia(msg("The Flash"));
  assert.deepEqual(
    calls.map((c) => c.args),
    ["Superman", "The Flash"],
  );
  await searchVia(msg("ABCD-2345"));
  assert.match(sent.at(-1)!.text, /Telegram 里批准网页客户端没开/);
  await searchVia(msg("wxyz 2345"));
  assert.match(sent.at(-1)!.text, /Telegram 里批准网页客户端没开/, "不带连字符，但真有这么一个请求");
  assert.equal(calls.length, 2);
});

test("/s：搜索放在后台，不挡住别的消息；同一个聊天上一个没出结果不开新的，别的聊天不受影响", async () => {
  searchConfigured = true;
  let release!: () => void;
  searchGate = new Promise((r) => (release = r));
  searchResult = { keyword: "沙丘2", complete: true, counts: {}, items: [hit("quark", 1)] };
  await handleUpdate(bot, msg("/s 沙丘2"));
  assert.match(sent.at(-1)!.text, /在搜「沙丘2」/);
  assert.equal(edited.length, 0, "还没出结果");
  await handleUpdate(bot, msg("/ping"));
  assert.match(sent.at(-1)!.text, /Pong/);
  await handleUpdate(bot, msg("/s 别的"));
  assert.match(sent.at(-1)!.text, /上一个搜索还没出结果/);
  settings.telegram!.allowedUsers = [42, 43];
  await handleUpdate(bot, msg("/s 另一个", { user: 43 }));
  assert.match(sent.at(-1)!.text, /在搜「另一个」/);

  release();
  await __test_waitSearches();
  assert.equal(edited.length, 2);
  assert.match(edited[0].text, /片 1/);
  assert.deepEqual(
    calls.filter((c) => c.fn === "searchResources").map((c) => c.args),
    ["沙丘2", "另一个"],
  );
  searchGate = null;
  await searchVia(msg("/s 别的"));
  assert.equal(calls.filter((c) => c.fn === "searchResources").length, 3, "出了结果就能再搜");
});

test("/s：搜索出错、只有别家网盘、没搜到各有说法；追更通知里的「搜替代资源」按订阅名搜", async () => {
  searchConfigured = true;
  searchError = new Error("连不上 PanSou：连接被拒绝");
  await searchVia(msg("/s 沙丘2"));
  assert.match(edited[0].text, /❌ 搜索失败：连不上 PanSou/);
  searchError = null;
  searchResult = { keyword: "x", complete: true, counts: {}, items: [hit("other", 1)] };
  await searchVia(msg("/s x"));
  assert.match(edited[1].text, /只搜到百度、阿里这类网盘的链接/);
  searchResult = { keyword: "y", complete: true, counts: {}, items: [] };
  await searchVia(msg("/s y"));
  assert.match(edited[2].text, /^没搜到「y」/);
  // 插件还没跑完的 0 条：不说「没搜到」，叫人过半分钟再发
  searchResult = { keyword: "z", complete: false, counts: {}, items: [] };
  await searchVia(msg("/s z"));
  assert.match(edited[3].text, /^还没搜到「z」.*过半分钟再发一次/);
  // PanSou 回的原话很长：截短，整条消息不会超过 Telegram 的上限
  searchError = new Error(`PanSou：${"很长的报错".repeat(2000)}`);
  await searchVia(msg("/s w"));
  assert.match(edited[4].text, /^❌ 搜索失败：PanSou：很长的报错/);
  assert.ok(edited[4].text.length < 400, String(edited[4].text.length));
  searchError = null;

  calls.length = 0;
  await searchVia(cb("fsr:f1"));
  assert.deepEqual(calls, [{ fn: "searchResources", args: "繁花" }], "订阅名「标题 / 子目录」只拿标题搜，标签和年份去掉");
  await searchVia(cb("fsr:nosuch"));
  assert.equal(answered.at(-1), "这个追更已经不在了");
});

test("搜索列表的按钮：翻页、筛选的值不对就不理；取消只有发起人能点；连点两下不重发一份；选目录那几个按钮不认搜索的 token", async () => {
  searchConfigured = true;
  settings.telegram!.allowedUsers = [42, 43];
  searchResult = { keyword: "k", complete: true, counts: {}, items: Array.from({ length: 10 }, (_, i) => hit("115", i)) };
  await searchVia(msg("/s k"));
  const token = edited[0].buttons!.flat().find((b) => b.text === "取消")!.callback_data.split(":")[1];

  const edits = edited.length;
  for (const data of [`srp:${token}:x`, `srp:${token}:-1`, `srp:${token}:1.5`, `srf:${token}:baidu`, `srf:${token}:`]) {
    await handleUpdate(bot, cb(data));
  }
  assert.equal(edited.length, edits, "不认的值不改列表");
  await handleUpdate(bot, cb(`srp:${token}:99`));
  assert.match(edited.at(-1)!.text, /第 2\/2 页/, "页码超了画最后一页");

  for (const data of [`ofl:${token}:t1`, `shr:${token}:t1`, `nav:${token}:up`, `go:${token}:x`]) {
    await handleUpdate(bot, cb(data));
    assert.equal(answered.at(-1), "已过期，请重新发一次链接", data);
  }

  // 同一个按钮连点两下：第二次 Telegram 回 not modified，当成改好了；别的编辑失败照旧补发一条
  const sends = sent.length;
  editFailure = NOT_MODIFIED;
  await handleUpdate(bot, cb(`srp:${token}:1`));
  assert.equal(sent.length, sends);
  editFailure = "Bad Request: message to edit not found";
  await handleUpdate(bot, cb(`srp:${token}:0`));
  assert.equal(sent.length, sends + 1);
  editFailure = null;

  await handleUpdate(bot, cb(`drop:${token}`, { user: 43 }));
  assert.equal(answered.at(-1), "这不是你发起的操作");
  await handleUpdate(bot, cb(`srp:${token}:1`));
  assert.match(edited.at(-1)!.text, /第 2\/2 页/, "别人点取消，列表还在");
  await handleUpdate(bot, cb(`drop:${token}`));
  assert.equal(edited.at(-1)!.text, "已取消。");
  await handleUpdate(bot, cb(`srp:${token}:0`));
  assert.equal(answered.at(-1), "已过期，请重新搜一次");
});

test("/s：屏蔽词藏了几条写在表头下面；全被藏掉时说是屏蔽词藏的，不说没搜到", async () => {
  searchConfigured = true;
  searchResult = { keyword: "k", complete: true, counts: {}, items: [hit("quark", 1)], blocked: 3 };
  await searchVia(msg("/s k"));
  assert.match(edited.at(-1)!.text, /🔍 <b>k<\/b> · 夸克 1\n屏蔽词藏了 3 条。/);
  searchResult = { keyword: "k", complete: true, counts: {}, items: [], blocked: 4 };
  await searchVia(msg("/s k"));
  assert.match(edited.at(-1)!.text, /搜到的 4 条都被屏蔽词藏掉了/);
});

test("/s：剩下的接不住、屏蔽词又藏了几条时，两件事都说", async () => {
  searchConfigured = true;
  searchResult = { keyword: "k", complete: true, counts: {}, items: [hit("other", 1)], blocked: 5 };
  await searchVia(msg("/s k"));
  assert.match(edited.at(-1)!.text, /只搜到百度、阿里这类网盘的链接.*（屏蔽词另外藏了 5 条）/);
});

test("连点两下「只看」「取消」：第二次 Telegram 回 not modified（原话在 error 里，和真客户端一样），不再补发一份", async () => {
  searchConfigured = true;
  searchResult = { keyword: "k", complete: true, counts: {}, items: [hit("115", 1), hit("magnet", 2)] };
  await searchVia(msg("/s k"));
  const buttons = edited[0].buttons!.flat();
  const only = buttons.find((b) => b.text === "只看磁力")!;
  const drop = buttons.find((b) => b.text === "取消")!;
  const sends = sent.length;
  await handleUpdate(bot, cb(only.callback_data));
  assert.match(edited.at(-1)!.text, /1\. \[磁力\]/);
  editFailure = NOT_MODIFIED;
  await handleUpdate(bot, cb(only.callback_data));
  assert.equal(sent.length, sends, "只看：不再发一份带按钮的列表");
  editFailure = null;
  await handleUpdate(bot, cb(drop.callback_data));
  assert.equal(edited.at(-1)!.text, "已取消。");
  editFailure = NOT_MODIFIED;
  await handleUpdate(bot, cb(drop.callback_data));
  assert.equal(sent.length, sends, "取消：不再发一条「已取消。」");
});

test("截短不劈 emoji：切口落在 emoji 中间时整个字符去掉，关键词、「在搜」、列表里都没有半个", async () => {
  searchConfigured = true;
  const half = /\p{Cs}/u;
  // 标题截到 47 个单元再加省略号：第 47 个单元正好是 🎬 的前一半
  searchResult = { keyword: "k", complete: true, counts: {}, items: [{ ...hit("quark", 1), title: `${"甲".repeat(46)}🎬第二季` }] };
  // 关键词最多 100 个单元：第 100 个单元是 🎬 的前一半
  await searchVia(msg(`/s ${"乙".repeat(99)}🎬`));
  assert.deepEqual(calls, [{ fn: "searchResources", args: "乙".repeat(99) }]);
  assert.doesNotMatch(sent[0].text, half);
  assert.match(edited[0].text, new RegExp(`1\\. \\[夸克\\] ${"甲".repeat(46)}… · `));
  assert.doesNotMatch(edited[0].text, half);
});

test("配对码：连着写、空一格的，数字字母混着就当配对码，过期了、打错了回「没找到」不去搜；全是字母的要真有请求才算", async () => {
  searchConfigured = true;
  searchResult = { keyword: "x", complete: true, counts: {}, items: [hit("quark", 1)] };
  settings.telegram!.allowOAuthApproval = true;
  // WXYZ2346 没有待批准的请求：过期了，或者打错了一位
  for (const text of ["WXYZ2346", "wxyz 2346", "WXYZ-2346"]) {
    await searchVia(msg(text));
    assert.match(sent.at(-1)!.text, /没找到这个配对码/, text);
  }
  assert.equal(calls.length, 0, "一个都没拿去搜");
  // 全是字母的配对码：真有这么一个请求，空一格也认
  await searchVia(msg("hjkl mnpq"));
  assert.match(sent.at(-1)!.text, /配对码对上了/);
  assert.equal(calls.length, 0);
  // 全是字母、又没有请求的是片名；数字字母混着但不是 4 + 4 的（Aquaman 2）也是
  for (const text of ["SUPERMAN", "Star Wars", "Jane Eyre", "Aquaman 2"]) await searchVia(msg(text));
  assert.deepEqual(
    calls.map((c) => c.args),
    ["SUPERMAN", "Star Wars", "Jane Eyre", "Aquaman 2"],
  );
});

test("「搜替代资源」：追更名就是分享码、链接，或者拿不出片名的，不去搜，叫人用 /s 片名", async () => {
  searchConfigured = true;
  for (const id of ["f2", "f3", "f4"]) {
    await searchVia(cb(`fsr:${id}`));
    assert.match(sent.at(-1)!.text, /拿不出片名[\s\S]*<code>\/s 片名<\/code>/, id);
  }
  assert.equal(calls.length, 0, "分享码、链接、空的都没拿去搜");
});

test("云下载回话按实际登记上的回执说：只登记了「下完只复制」的（链接都是 115 上已有的）不说生成 strm，任务开着复制的说复制到哪", async () => {
  settings.telegram!.allowOfflineAdd = true;
  setCommandDeps({
    ...deps,
    addOffline: async (input) => {
      calls.push({ fn: "addOffline", args: input });
      return {
        account: "115", dirId: "9", dirPath: "tv", added: 0, failed: 1, invalid: [],
        followup: true, strmFollowup: false, copyDstDir: "/local/tv", copyAfterCopy: "keep", copyEngine: "openlist", copyBlocked: null,
        results: [{ url: "magnet:?xt=urn:btih:aaa", ok: false, infoHash: "h", message: "任务已存在" }],
      };
    },
  });
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa"));
  await handleUpdate(bot, cb(findButton("tv")!.callback_data));
  const go = edited[0].buttons!.flat().find((b) => b.text.includes("就放这里"))!;
  await handleUpdate(bot, cb(go.callback_data));
  const text = edited.at(-1)!.text;
  assert.match(text, /目录：tv，下完让 OpenList 复制到 \/local\/tv/);
  assert.doesNotMatch(text, /生成 strm/);
});

test("云下载回话说的引擎按回包里添加时核对用的那一家，不另读设置（添加和回话之间设置被改了也不说错）", async () => {
  settings.telegram!.allowOfflineAdd = true;
  setCommandDeps({
    ...deps,
    addOffline: async (input) => {
      calls.push({ fn: "addOffline", args: input });
      // 添加时按 CloudDrive2 核对的；回包回来时设置里的引擎已经是 OpenList（默认）了
      return {
        account: "115", dirId: "9", dirPath: "tv", added: 1, failed: 0, invalid: [],
        followup: true, strmFollowup: true, copyDstDir: "/hdd/tv", copyAfterCopy: "keep", copyEngine: "cd2", copyBlocked: null,
        results: [{ url: "magnet:?xt=urn:btih:aaa", ok: true, infoHash: "h" }],
      };
    },
  });
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa"));
  await handleUpdate(bot, cb(findButton("tv")!.callback_data));
  const go = edited[0].buttons!.flat().find((b) => b.text.includes("就放这里"))!;
  await handleUpdate(bot, cb(go.callback_data));
  assert.match(edited.at(-1)!.text, /下完让 CloudDrive2 复制到 \/hdd\/tv/);
});

test("/tasks 太长被截断时，标签照样成对、没有半个实体（路径里带 & 和 <>）", async () => {
  const name = (i: number) => `<第 ${i} 部> 一个很长很长很长很长很长很长很长很长很长很长的剧名 & 特别篇 [4K] {tmdb-${i}}`;
  const many: TaskDefinition[] = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`, account: "115", accountType: "115", strmPrefix: "/mnt", cronExpression: "0 3 * * *",
    originPath: `/媒体 & 资源/电视剧/${name(i + 1)}/Season 1`, targetPath: `/strm/电视剧 & 动漫/${name(i + 1)}/Season 1`,
  }));
  setCommandDeps({ ...deps, listTasks: () => many });
  await handleUpdate(bot, msg("/tasks"));
  const { text } = sent[0];
  assert.match(text, /…（已截断）$/);
  assert.equal(text.match(/<b>/g)?.length, text.match(/<\/b>/g)?.length, "<b> 都闭合了");
  assert.equal(text.match(/<code>/g)?.length, text.match(/<\/code>/g)?.length, "<code> 都闭合了");
  assert.doesNotMatch(text.replace(/<\/?(?:b|code)>/g, ""), /[<>]|&(?!(?:amp|lt|gt);)/, "没有半个标签、半个实体");
});


test("「磁力：magnet:?…」（冒号后面没空格）当云下载链接，不拿去搜；交给 115 的只有链接本身", async () => {
  searchConfigured = true;
  settings.telegram!.allowOfflineAdd = true;
  const magnet = `magnet:?xt=urn:btih:${"c".repeat(40)}`;
  await searchVia(msg(`磁力：${magnet}`));
  assert.equal(calls.length, 0, "没拿去搜");
  assert.match(sent.at(-1)!.text, /收到 1 条链接/);
  await handleUpdate(bot, cb(findButton("115 默认目录")!.callback_data));
  assert.deepEqual(calls, [{ fn: "addOffline", args: { urls: magnet } }]);
});
