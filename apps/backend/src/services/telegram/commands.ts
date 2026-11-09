/**
 * 机器人的"大脑"：一条 update 进来，先查权限，再分发到命令 / 链接 / 按钮回调。
 *
 * 所有会碰数据库、115、任务引擎的动作都收在 CommandDeps 里，测试用桩整体换掉；
 * 处理器本身只依赖 BotLike（发消息、改消息、应答按钮）。
 *
 * 权限模型：
 *   - 只回应白名单里的用户；私聊里未授权的人会收到自己的 id（方便管理员加白名单），群里一律不理
 *   - 群聊只认设置里的 chatId 那一个群
 *   - 按钮回调同样过白名单（以前只查文字命令，群里谁都能点"启动"）
 *   - 会产生副作用的动作各有一个开关：allowTaskStart / allowOfflineAdd / allowShareReceive，默认全关
 *   - 网页客户端的 OAuth 授权请求（批准 / 拒绝按钮）不另设开关：通知本身只发给管理员配的那个聊天，点的人还要过白名单
 */
import type { AppSettings, LibrarySearchResult, OAuthPendingRequest, TaskDefinition, TaskExecutionSummary } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { listAccounts } from "../../db/repositories/accounts.js";
import { getShareFollow } from "../../db/repositories/share-follows.js";
import { getAllTaskHistory, getLatestExecutions, getTaskHistory } from "../task-history.js";
import { cancelRunningTask, getRunningTask, listRunningTaskIds } from "../task/registry.js";
import { startTask } from "../task/runner.js";
import {
  addOfflineTasks,
  getOfflineWatcherStatus,
  listOfflineTasks,
  type AddOfflineResponse,
} from "../offline/service.js";
import { copyConfigured, resolveCopyConfig } from "../copy/paths.js";
import { listOpenlistEntries } from "../copy/service.js";
import { getLifeMonitorStatus } from "../life/monitor.js";
import { normalizeOfflineUrls } from "../cloud-115/offline.js";
import { KIND_LABEL, findShareLink, providerFor, providerForTask, shareForLink } from "../drive/registry.js";
import { AGENT_TOOLSETS } from "../../db/repositories/api-tokens.js";
import { findPendingOAuthRequestByCode, getOAuthRequest, normalizePairingCode } from "../../db/repositories/oauth.js";
import { approveOAuthRequest, denyOAuthRequest, pendingRequestInfo, presetScopes, type ApproveResult } from "../oauth/authorize.js";
import { FOLLOW_SEARCH_ACTION, OAUTH_APPROVE_ACTION, OAUTH_DENY_ACTION, oauthRequestText } from "./notify.js";
import type { DriveKind } from "../drive/types.js";
import { listWholeShareDir } from "../drive/share-walk.js";
import { saveSelectionToTask } from "../share/receive.js";
import { keywordFromName } from "../pansou/normalize.js";
import { PANSOU_NOT_CONFIGURED, pansouConn, searchSettled, type SettledResult } from "../pansou/search.js";
import { searchLibrary } from "../library/search.js";
import { getAll } from "../../db/repositories/media-library.js";
import { moduleLogger } from "../../lib/logger.js";
import {
  createPending,
  peekPending,
  takePending,
  updatePending,
  type BrowseState,
  type PendingAction,
  type SearchHit,
  type SearchHitKind,
} from "./session.js";
import { clamp, cutText, describeRun, esc, fmtTime, shortName, taskLabel } from "./format.js";
import type { BotCommand, BotLike, InlineKeyboard, TelegramCallbackQuery, TelegramChat, TelegramMessage, TelegramUpdate, TelegramUser } from "./bot.js";

const log = moduleLogger("telegram");

/** 注册到 Telegram 菜单里的命令（/start /ping 不放菜单） */
export const BOT_COMMANDS: BotCommand[] = [
  { command: "tasks", description: "任务列表，可直接运行" },
  { command: "status", description: "正在运行的任务与监控状态" },
  { command: "history", description: "最近的执行记录" },
  { command: "offline", description: "最近的云下载" },
  { command: "s", description: "搜资源：/s 片名" },
  { command: "cancel", description: "取消正在运行的任务" },
  { command: "id", description: "查看自己的用户 id" },
  { command: "help", description: "使用说明" },
];

/* ------------------------------- 依赖 ------------------------------- */

export interface OfflineRow {
  name: string;
  state: string;
  statusText: string;
  percent: number;
}

export interface ShareSummary {
  /** 规范化后的分享链接，转存时再解析一次 */
  link: string;
  kind: DriveKind;
  name: string;
  count: number;
  items: Array<{ id: string; name: string; isDir: boolean; token?: string }>;
}

export interface AccountBrief {
  name: string;
  kind: DriveKind;
  /** 能不能转存分享 */
  share: boolean;
}

export interface CommandDeps {
  settings(): AppSettings;
  listTasks(): TaskDefinition[];
  /** 账号和它们的网盘类型：云下载只认 115 账号的任务，转存只认和分享同类且能转存的账号的任务 */
  accounts(): AccountBrief[];
  latestExecutions(): Map<string, TaskExecutionSummary>;
  recentExecutions(limit: number): TaskExecutionSummary[];
  taskExecutions(taskId: string, limit: number): TaskExecutionSummary[];
  runningTaskIds(): string[];
  /** 正在跑的任务的总进度（"42.10"），拿不到就 null */
  runningPercent(taskId: string): string | null;
  startTask(taskId: string): Promise<{ ok: boolean; message: string }>;
  cancelTask(taskId: string): boolean;
  addOffline(input: {
    urls: string;
    taskId?: string;
    subPath?: string;
    copyToOpenlist?: boolean;
    copyDstDir?: string;
  }): Promise<AddOfflineResponse>;
  /** OpenList 目的地浏览：path 下的子目录名（用「复制到 OpenList」配置的账号） */
  listOpenlistDirs(path: string): Promise<string[]>;
  listOffline(): Promise<{ tasks: OfflineRow[]; count: number; quota: number | null; total: number | null }>;
  offlinePending(): number;
  lifeStatus(): { running: boolean; accounts: Array<{ name: string; running: boolean; lastError: string | null }> };
  shareInfo(link: string): Promise<ShareSummary>;
  receiveShare(input: {
    task: TaskDefinition;
    link: string;
    items: Array<{ id: string; name: string; isDir: boolean; token?: string }>;
    /** 相对 task.originPath 的子目录，空串是任务根目录 */
    subPath: string;
  }): Promise<{ ok: boolean; message: string }>;
  /** 任务的网盘目录（originPath/segments…）下的子目录名，目的地浏览用 */
  listSubdirs(task: TaskDefinition, segments: string[]): Promise<string[]>;
  /** OAuth 授权请求：按配对码找还在等批准的（有人把授权页上的配对码发过来时） */
  findOAuthByCode(code: string): OAuthPendingRequest | null;
  /** 批准：pairingCode 是用户发来、对上了的那个；preset 是 read / daily */
  approveOAuth(requestId: string, pairingCode: string, preset: string): ApproveResult;
  /** 拒绝，返回是否改成了（已处理过或过期了就是 false） */
  denyOAuth(requestId: string): boolean;
  /** 批准通知的原文（改消息时保留），请求没了就是 null */
  oauthRequestText(requestId: string): string | null;
  /** 资源搜索（PanSou）配没配 */
  resourceSearchConfigured(): boolean;
  /** 资源搜索：服务端多问几轮，拿一次性的结果（没配置、PanSou 出错都抛） */
  searchResources(keyword: string): Promise<SettledResult>;
  /** 影库里搜（本地，瞬间）：前几条；影库是空的 / 没命中返回空 */
  searchLibrary(keyword: string): LibrarySearchResult;
  /** 影库里有没有收藏（没配 PanSou 时，有收藏也照样能搜） */
  libraryHasSources(): boolean;
  /** 追更订阅的名字和分享码（通知里「搜替代资源」按钮用）；订阅没了是 null */
  shareFollow(id: string): { name: string; shareCode: string } | null;
}

/** 后端 startTask 的 message 是固定的英文句式，这里说成人话（和任务页保持一致）；个数用结构化的 total */
function describeStart(body: Record<string, unknown>): string {
  const message = typeof body.message === "string" ? body.message : "";
  if (typeof body.total === "number") return `开始处理 ${body.total} 个文件`;
  if (message === "no files to download") return "本地已是最新，没有需要处理的文件";
  const details = typeof body.details === "string" && body.details ? `：${body.details}` : "";
  return `${message || "启动失败"}${details}`;
}

const realDeps: CommandDeps = {
  settings: readAppSettings,
  listTasks,
  accounts: () =>
    listAccounts().map((a) => {
      const p = providerFor(a);
      return { name: a.name, kind: p.kind, share: p.capabilities.share };
    }),
  latestExecutions: getLatestExecutions,
  recentExecutions: (limit) => getAllTaskHistory().slice(0, limit),
  taskExecutions: (taskId, limit) => getTaskHistory(taskId).slice(0, limit),
  runningTaskIds: listRunningTaskIds,
  runningPercent: (taskId) => {
    const logs = getRunningTask(taskId)?.logs;
    if (!logs?.length) return null;
    for (let i = logs.length - 1; i >= Math.max(0, logs.length - 50); i--) {
      try {
        const line = JSON.parse(logs[i]) as { overallPercent?: string };
        if (line.overallPercent) return line.overallPercent;
      } catch {
        /* 跳过 */
      }
    }
    return null;
  },
  startTask: async (taskId) => {
    const r = await startTask(taskId, { trigger: "telegram" });
    return { ok: r.status === 200, message: describeStart(r.body) };
  },
  cancelTask: (taskId) => cancelRunningTask(taskId, "Telegram 取消"),
  addOffline: (input) => addOfflineTasks(input),
  listOpenlistDirs: async (path) => {
    // 走复制引擎：选了 CD2 就是 CD2 里的目录。浏览用缓存就行，不刷新（和以前直接调 openlistListDir 一样）
    const cfg = resolveCopyConfig();
    return (await listOpenlistEntries(cfg, path, { refresh: false })).filter((e) => e.isDir).map((e) => e.name);
  },
  listOffline: async () => {
    const page = await listOfflineTasks(undefined, 1);
    return {
      tasks: page.tasks.map((t) => ({ name: t.name, state: t.state, statusText: t.statusText, percent: t.percent })),
      count: page.count,
      quota: page.quota,
      total: page.total,
    };
  },
  offlinePending: () => getOfflineWatcherStatus().pending,
  lifeStatus: () => {
    const s = getLifeMonitorStatus();
    return {
      running: s.running,
      accounts: s.accounts.map((a) => ({ name: a.name, running: a.running, lastError: a.lastError })),
    };
  },
  shareInfo: async (link) => {
    const { provider, ref } = shareForLink(link);
    const share = provider.share!;
    const session = await share.open(ref);
    const info = await share.info(session);
    // 整个分享一起转存：根目录下的条目全部要（翻完页）
    const list = await listWholeShareDir(share, session, "0");
    return {
      link: ref.url,
      kind: ref.kind,
      name: info.title || "分享",
      count: list.length,
      items: list.map((it) => ({ id: it.id, name: it.name, isDir: it.isDir, token: it.token })),
    };
  },
  receiveShare: async ({ task, link, items, subPath }) => {
    try {
      const { ref } = shareForLink(link);
      const r = await saveSelectionToTask({
        task,
        ref,
        items,
        subPath,
        mode: "async",
        settings: readAppSettings(),
      });
      if ("error" in r) {
        const body = r.error as Record<string, unknown>;
        return { ok: true, message: `已转存，但后台同步没能启动：${describeStart(body)}` };
      }
      const started = "message" in r && r.message ? describeStart({ message: r.message }) : "";
      return { ok: true, message: `已转存，后台同步已启动${started ? `：${started}` : ""}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
  listSubdirs: async (task, segments) => {
    const provider = providerForTask(task);
    const path = [task.originPath, ...segments].join("/");
    const node = await provider.resolvePath(path);
    if (!node || !node.isDir) throw new Error(`目录不存在：${path}`);
    // 文件不进列表
    return (await provider.listDir(node.id)).filter((e) => e.isDir).map((e) => e.name);
  },
  findOAuthByCode: (code) => {
    const r = findPendingOAuthRequestByCode(code);
    return r ? pendingRequestInfo(r) : null;
  },
  approveOAuth: (requestId, pairingCode, preset) => {
    const scopes = presetScopes(preset);
    return scopes ? approveOAuthRequest(requestId, pairingCode, { scopes, toolsets: AGENT_TOOLSETS }, "telegram") : "gone";
  },
  denyOAuth: (requestId) => denyOAuthRequest(requestId, "telegram"),
  oauthRequestText: (requestId) => {
    const r = getOAuthRequest(requestId);
    return r ? oauthRequestText(pendingRequestInfo(r)) : null;
  },
  resourceSearchConfigured: () => pansouConn() !== null,
  searchResources: (keyword) => searchSettled(keyword),
  searchLibrary: (keyword) => searchLibrary({ q: keyword, limit: LIBRARY_LINES }),
  libraryHasSources: () => getAll().length > 0,
  shareFollow: (id) => {
    const f = getShareFollow(id);
    return f ? { name: f.name, shareCode: f.shareCode } : null;
  },
};

let deps: CommandDeps = { ...realDeps };

/** 仅供测试：换掉会碰库、网盘、任务引擎的部分；传 null 恢复 */
export function setCommandDeps(partial: Partial<CommandDeps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 权限 ------------------------------- */

type Access = "ok" | "deny-private" | "deny-silent";

function checkAccess(settings: AppSettings, from: TelegramUser | undefined, chat: TelegramChat): Access {
  if (!from || from.is_bot) return "deny-silent";
  const allowed = settings.telegram?.allowedUsers ?? [];
  const isPrivate = chat.type === "private";
  if (!allowed.includes(from.id)) return isPrivate ? "deny-private" : "deny-silent";
  const home = settings.telegram?.chatId;
  if (!isPrivate && (!home || String(chat.id) !== String(home))) return "deny-silent";
  return "ok";
}

function perms(settings: AppSettings) {
  return {
    taskStart: settings.telegram?.allowTaskStart === true,
    offlineAdd: settings.telegram?.allowOfflineAdd === true,
    shareReceive: settings.telegram?.allowShareReceive === true,
    oauthApproval: settings.telegram?.allowOAuthApproval === true,
  };
}

/* ------------------------------- 入口 ------------------------------- */

export async function handleUpdate(bot: BotLike, update: TelegramUpdate): Promise<void> {
  if (update.message) return handleMessage(bot, update.message);
  if (update.callback_query) return handleCallback(bot, update.callback_query);
}

async function handleMessage(bot: BotLike, msg: TelegramMessage): Promise<void> {
  const settings = deps.settings();
  const chatId = String(msg.chat.id);
  const access = checkAccess(settings, msg.from, msg.chat);
  if (access === "deny-silent") return;
  if (access === "deny-private") {
    await bot.sendMessage(
      chatId,
      `你还没有使用权限。\n你的用户 id 是 <code>${msg.from?.id}</code>，请管理员到 OpenStrm 的 Telegram 页把它加进白名单。`,
    );
    return;
  }
  const text = (msg.text ?? "").trim();
  if (!text) return;

  if (text.startsWith("/")) {
    // 群里的命令带 @botname；命令后面的是参数（/s 片名）
    const head = text.split(/\s+/)[0];
    const cmd = head.replace(/@\S+$/, "").toLowerCase();
    await handleCommand(bot, chatId, cmd, text.slice(head.length).trim(), msg.from!.id);
    return;
  }

  if (isPairingAttempt(text)) {
    await handlePairingCode(bot, chatId, text, settings);
    return;
  }

  const share = findShareLink(text);
  if (share) {
    await beginShare(bot, chatId, msg.from!.id, share.url, settings);
    return;
  }
  const { urls } = normalizeOfflineUrls(text);
  if (urls.length > 0) {
    await beginOffline(bot, chatId, msg.from!.id, urls, settings);
    return;
  }
  // 长得像链接（thunder:// 之类）但一条都不认：说清楚收什么；纯聊天就给个提示
  if (/(?:^|\s)(?:[a-z][\w+.-]*:\/\/|magnet:\?|[0-9a-f]{40}\b)/i.test(text)) {
    await bot.sendMessage(chatId, "不认识这种链接。能收的有：115 / 夸克分享链接、磁力、ed2k、http(s)、ftp。");
    return;
  }
  // 私聊里直接发片名就是搜：配了资源搜索、或者影库里有收藏才这样。群里只认 /s，免得群里每句话都去搜一次
  if (msg.chat.type === "private" && (deps.resourceSearchConfigured() || deps.libraryHasSources()) && text.length <= SEARCH_KEYWORD_MAX) {
    await startSearch(bot, chatId, msg.from!.id, text);
    return;
  }
  await bot.sendMessage(chatId, "直接把 115 / 夸克分享链接或磁力/ed2k 链接发给我，搜资源用 /s 片名，或者用 /help 看看能做什么。");
}

/* ------------------------------- 网页客户端的配对码 ------------------------------- */

/**
 * 发来的这句是不是配对码。认成配对码的，过期了、打错了回「没找到这个配对码」，不拿去搜：
 *   - 写成 XXXX-XXXX（授权页上的样子）：一看就是
 *   - 连着写（WXYZ2345）或中间空一格（wxyz 2345）：数字字母混着才算，片名不会长这样；
 *     Superman、Star Wars 这种全是字母的也凑得上配对码的字母表，照样拿去搜
 *   - 别的写法、全是字母的：真有这么一个待批准的请求才算
 */
function isPairingAttempt(text: string): boolean {
  const code = normalizePairingCode(text);
  if (!code) return false;
  if (/^[a-z0-9]{4}-[a-z0-9]{4}$/i.test(text)) return true;
  if (/^[a-z0-9]{4}\s?[a-z0-9]{4}$/i.test(text) && /\d/.test(code) && /[A-Z]/.test(code)) return true;
  return deps.findOAuthByCode(text) != null;
}

/** 配对码对上之后记一笔：请求 id → 用户发来的配对码、在哪个聊天、什么时候。批准按钮按下时要有这一笔 */
const oauthUnlocks = new Map<string, { code: string; chatId: string; at: number }>();
const UNLOCK_TTL_MS = 10 * 60_000;

/**
 * 有人把授权页上的配对码发过来：对上了就回这一条的说明和批准按钮。
 * 通知里不放批准按钮，就是为了让批准证明「批的是自己眼前授权页上的那一条」，见 services/oauth/authorize.ts 文件头
 */
async function handlePairingCode(bot: BotLike, chatId: string, text: string, settings: AppSettings): Promise<void> {
  if (!perms(settings).oauthApproval) {
    await bot.sendMessage(chatId, "Telegram 里批准网页客户端没开：到 OpenStrm 的 Telegram 页打开「允许批准网页客户端的连接」，或者直接到设置页里批准。");
    return;
  }
  const req = deps.findOAuthByCode(text);
  if (!req) {
    await bot.sendMessage(chatId, "没找到这个配对码对应的授权请求：可能已经批过、拒过或过期了，回到客户端重新连接一次。");
    return;
  }
  const now = Date.now();
  for (const [id, u] of oauthUnlocks) if (now - u.at > UNLOCK_TTL_MS) oauthUnlocks.delete(id);
  oauthUnlocks.set(req.id, { code: text, chatId, at: now });
  const buttons: InlineKeyboard = [
    [
      { text: "✅ 批准（日常）", callback_data: `${OAUTH_APPROVE_ACTION}:${req.id}:daily` },
      { text: "👁 只读", callback_data: `${OAUTH_APPROVE_ACTION}:${req.id}:read` },
    ],
    [{ text: "❌ 拒绝", callback_data: `${OAUTH_DENY_ACTION}:${req.id}` }],
  ];
  await bot.sendMessage(chatId, `${oauthRequestText(req)}\n\n配对码对上了，选个档位批准：`, { buttons });
}

/** 测试用 */
export function __test_resetOAuthUnlocks(): void {
  oauthUnlocks.clear();
}

/* ------------------------------- 命令 ------------------------------- */

async function handleCommand(bot: BotLike, chatId: string, cmd: string, args: string, userId: number): Promise<void> {
  switch (cmd) {
    case "/start":
    case "/help":
      return void (await bot.sendMessage(chatId, helpText(deps.settings())));
    case "/ping":
      return void (await bot.sendMessage(chatId, "🏓 Pong，机器人在线。"));
    case "/id":
      return void (await bot.sendMessage(chatId, `这个会话的 chat id 是 <code>${esc(chatId)}</code>`));
    case "/tasks":
      return sendTaskList(bot, chatId);
    case "/status":
      return sendStatus(bot, chatId);
    case "/history":
      return sendHistory(bot, chatId);
    case "/offline":
      return sendOffline(bot, chatId);
    case "/cancel":
      return sendCancelMenu(bot, chatId);
    case "/s":
    case "/search":
      return startSearch(bot, chatId, userId, args);
    default:
      await bot.sendMessage(chatId, `不认识的命令 ${esc(cmd)}，用 /help 看看有哪些。`);
  }
}

function helpText(settings: AppSettings): string {
  const p = perms(settings);
  const onOff = (v: boolean) => (v ? "已开启" : "未开启，到 Telegram 页打开");
  return [
    "<b>OpenStrm 机器人</b>",
    "",
    "<b>直接发链接：</b>",
    `• 磁力 / ed2k / http 链接 → 交给 115 云下载，可选下到某个任务目录（能进子文件夹），下完自动生成 strm（${onOff(p.offlineAdd)}）`,
    `• 115 / 夸克分享链接 → 转存到同类账号的某个任务目录（能进子文件夹）并同步（${onOff(p.shareReceive)}）`,
    `• 授权页上的配对码 → 批准 claude.ai、ChatGPT 这类网页客户端的连接（${onOff(p.oauthApproval)}）`,
    "",
    "<b>命令：</b>",
    `/tasks 任务列表，带「运行」按钮（${onOff(p.taskStart)}）`,
    "/status 正在跑的任务、云下载回执、网盘监控",
    "/history 最近的执行记录",
    "/offline 最近的云下载",
    `/s 片名 先搜收藏夹，再搜网盘分享和磁力（${deps.resourceSearchConfigured() ? "私聊里直接发片名也行" : "网上搜要先在设置页配置资源搜索，现在只搜收藏夹"}）`,
    "/cancel 取消正在运行的任务",
    "/id 查看 chat id",
  ].join("\n");
}

function taskButtons(task: TaskDefinition, running: boolean, canStart: boolean): InlineKeyboard[number] {
  const row: InlineKeyboard[number] = [];
  if (running) row.push({ text: "⏹ 取消", callback_data: `cancel:${task.id}` });
  else if (canStart) row.push({ text: "▶ 运行", callback_data: `run:${task.id}` });
  row.push({ text: "📜 记录", callback_data: `hist:${task.id}` });
  return row;
}

async function sendTaskList(bot: BotLike, chatId: string): Promise<void> {
  const settings = deps.settings();
  const tasks = deps.listTasks();
  if (tasks.length === 0) {
    await bot.sendMessage(chatId, "还没有任务，先到 OpenStrm 首页建一个。");
    return;
  }
  const latest = deps.latestExecutions();
  const running = new Set(deps.runningTaskIds());
  const canStart = perms(settings).taskStart;
  const lines: string[] = [`<b>任务（${tasks.length}）</b>`];
  const buttons: InlineKeyboard = [];
  tasks.slice(0, 20).forEach((t, i) => {
    const last = latest.get(t.id);
    const state = running.has(t.id) ? `🔄 运行中 ${deps.runningPercent(t.id) ?? ""}%`.replace(" %", "") : last ? describeRun(last) : "还没跑过";
    const cron = t.cronExpression ? ` · ⏰ <code>${esc(t.cronExpression)}</code>` : "";
    lines.push(`\n<b>${i + 1}. ${esc(taskLabel(t))}</b>\n账户 ${esc(t.account)}${cron}\n${state}`);
    buttons.push([{ text: `${i + 1}`, callback_data: "noop" }, ...taskButtons(t, running.has(t.id), canStart)]);
  });
  if (tasks.length > 20) lines.push(`\n…还有 ${tasks.length - 20} 个任务，请到网页查看`);
  if (!canStart) lines.push("\n「运行」按钮未开启：到 Telegram 页打开「允许从 Telegram 启动任务」");
  await bot.sendMessage(chatId, clamp(lines.join("\n")), { buttons });
}

async function sendStatus(bot: BotLike, chatId: string): Promise<void> {
  const tasks = new Map(deps.listTasks().map((t) => [t.id, t]));
  const running = deps.runningTaskIds();
  const lines: string[] = ["<b>运行状态</b>", ""];
  if (running.length === 0) lines.push("没有正在运行的任务");
  else {
    lines.push(`<b>正在运行（${running.length}）</b>`);
    for (const id of running) {
      const t = tasks.get(id);
      const pct = deps.runningPercent(id);
      lines.push(`🔄 ${esc(t ? taskLabel(t) : id)}${pct ? ` · ${pct}%` : ""}`);
    }
  }
  const pending = deps.offlinePending();
  lines.push("", `云下载：${pending > 0 ? `${pending} 个下载完成后待生成 strm` : "没有待处理的回执"}`);
  const life = deps.lifeStatus();
  const on = life.accounts.filter((a) => a.running).map((a) => esc(a.name));
  const off = life.accounts.filter((a) => !a.running).map((a) => esc(a.name));
  lines.push(`网盘监控：${life.running ? `运行中（账号 ${on.join("、")}）` : "未运行"}`);
  if (life.running && off.length > 0) lines.push(`未运行：${off.join("、")}`);
  for (const a of life.accounts) {
    if (a.lastError) lines.push(`⚠️ ${esc(a.name)}：${esc(a.lastError)}`);
  }
  await bot.sendMessage(chatId, clamp(lines.join("\n")));
}

function historyLines(runs: TaskExecutionSummary[], tasks: Map<string, TaskDefinition>): string[] {
  return runs.map((r) => {
    const t = tasks.get(r.taskId);
    const label = t ? taskLabel(t) : r.taskInfo.originPath || r.taskId;
    return `<b>${esc(label)}</b>\n${describeRun(r)} · ${fmtTime(r.startTime)}`;
  });
}

async function sendHistory(bot: BotLike, chatId: string): Promise<void> {
  const runs = deps.recentExecutions(8);
  if (runs.length === 0) {
    await bot.sendMessage(chatId, "还没有执行记录。");
    return;
  }
  const tasks = new Map(deps.listTasks().map((t) => [t.id, t]));
  await bot.sendMessage(chatId, clamp(["<b>最近的执行</b>", "", ...historyLines(runs, tasks).join("\n\n").split("\n")].join("\n")));
}

async function sendOffline(bot: BotLike, chatId: string): Promise<void> {
  let page: Awaited<ReturnType<CommandDeps["listOffline"]>>;
  try {
    page = await deps.listOffline();
  } catch (err) {
    await bot.sendMessage(chatId, `读取云下载列表失败：${esc(err instanceof Error ? err.message : String(err))}`);
    return;
  }
  const icon: Record<string, string> = { done: "✅", failed: "❌", downloading: "⬇️", pending: "⏳" };
  const lines = [`<b>云下载</b>（共 ${page.count}${page.quota != null ? `，配额剩余 ${page.quota}${page.total != null ? `/${page.total}` : ""}` : ""}）`, ""];
  if (page.tasks.length === 0) lines.push("列表是空的");
  for (const t of page.tasks.slice(0, 10)) {
    const pct = t.state === "downloading" ? ` ${Math.floor(t.percent)}%` : "";
    lines.push(`${icon[t.state] ?? "•"} ${esc(shortName(t.name))} · ${esc(t.statusText)}${pct}`);
  }
  await bot.sendMessage(chatId, clamp(lines.join("\n")));
}

async function sendCancelMenu(bot: BotLike, chatId: string): Promise<void> {
  const running = deps.runningTaskIds();
  if (running.length === 0) {
    await bot.sendMessage(chatId, "没有正在运行的任务。");
    return;
  }
  const tasks = new Map(deps.listTasks().map((t) => [t.id, t]));
  const buttons: InlineKeyboard = running.map((id) => [
    { text: `⏹ ${shortName(tasks.get(id)?.originPath ?? id, 30)}`, callback_data: `cancel:${id}` },
  ]);
  await bot.sendMessage(chatId, "要取消哪个任务？", { buttons });
}

/* ------------------------------- 链接：云下载 ------------------------------- */

/** 能当目的地的任务：云下载只有 115 账号的；转存要和分享同类、且账号能转存 */
function destinationTasks(kind: DriveKind, needShare = false): TaskDefinition[] {
  const names = new Set(deps.accounts().filter((a) => a.kind === kind && (!needShare || a.share)).map((a) => a.name));
  return deps.listTasks().filter((t) => names.has(t.account));
}

async function beginOffline(bot: BotLike, chatId: string, userId: number, urls: string[], settings: AppSettings): Promise<void> {
  if (!perms(settings).offlineAdd) {
    await bot.sendMessage(chatId, "云下载功能未开启：到 OpenStrm 的 Telegram 页打开「允许添加云下载」。");
    return;
  }
  if (!deps.accounts().some((a) => a.kind === "115")) {
    await bot.sendMessage(chatId, "还没有配置 115 账号，无法云下载。");
    return;
  }
  const token = createPending(chatId, userId, { kind: "offline", urls });
  const buttons: InlineKeyboard = destinationTasks("115")
    .slice(0, 15)
    .map((t) => [{ text: `📁 ${shortName(t.originPath, 40)}`, callback_data: `ofl:${token}:${t.id}` }]);
  buttons.push([{ text: "☁️ 115 默认目录（不生成 strm）", callback_data: `ofl:${token}:default` }]);
  if (openlistCopyReady(settings)) {
    buttons.push([{ text: "☁️ 115 默认目录，下完让 OpenList 复制走", callback_data: `ofl:${token}:defcopy` }]);
  }
  buttons.push([{ text: "取消", callback_data: `drop:${token}` }]);
  const preview = urls.slice(0, 5).map((u) => `• ${esc(shortName(u, 60))}`);
  if (urls.length > 5) preview.push(`…共 ${urls.length} 条`);
  await bot.sendMessage(chatId, clamp([`收到 ${urls.length} 条链接，下载到哪里？`, ...preview, "", "选任务目录后还能进它的子文件夹；下完会自动生成 strm。"].join("\n")), { buttons });
}

/**
 * 「复制到 OpenList」配好了、而且这个 115 账号填了挂载根，才给这个目的地按钮；
 * 账号本身好不好使留到提交时报错
 */
function openlistCopyReady(settings: AppSettings): boolean {
  // 「115 默认目录」这条路走的就是第一个 115 账号（同 offline/service 的 resolveAccount115）
  const account = deps.accounts().find((a) => a.kind === "115");
  return Boolean(account && copyConfigured(account.name, settings));
}

/** 去尾斜杠、补头斜杠（和 offline/service 的 normDir 同规则，输入已保证非空） */
function normDirInput(input: string): string {
  const t = input.trim().replace(/\/+$/, "");
  if (!t) return "/";
  return t.startsWith("/") ? t : `/${t}`;
}

async function finishOffline(
  bot: BotLike,
  chatId: string,
  messageId: number | undefined,
  urls: string[],
  task: TaskDefinition | undefined,
  subPath: string,
  copyToOpenlist = false,
  copyDstDir?: string,
): Promise<void> {
  let text: string;
  try {
    const r = await deps.addOffline({
      urls: urls.join("\n"),
      ...(task ? { taskId: task.id } : {}),
      ...(task && subPath ? { subPath } : {}),
      ...(copyToOpenlist ? { copyToOpenlist: true } : {}),
      ...(copyToOpenlist && copyDstDir ? { copyDstDir } : {}),
    });
    const target = task ? `${task.originPath}${subPath ? `/${subPath}` : ""}` : "";
    // 按实际登记上的回执说：followup 把「下完只复制」的也算在里面，不能拿它说会生成 strm；任务开着复制的也说一声复制到哪
    const strmNote = r.strmFollowup ? "，下完自动生成 strm" : "";
    const copyNote = r.copyDstDir ? `，下完让 OpenList 复制到 ${esc(r.copyDstDir)}` : "";
    const lines = [`☁️ 已添加 ${r.added} 个云下载\n目录：${task ? `${esc(target)}${strmNote}` : "115 默认目录"}${copyNote}`];
    const failed = r.results.filter((x) => !x.ok);
    if (failed.length) lines.push("", `未接受 ${failed.length} 条：`, ...failed.slice(0, 5).map((x) => `• ${esc(shortName(x.url, 40))} — ${esc(x.message ?? "115 未接受")}`));
    if (r.invalid.length) lines.push(`不支持的链接 ${r.invalid.length} 条`);
    text = lines.join("\n");
  } catch (err) {
    text = `❌ 添加云下载失败：${esc(err instanceof Error ? err.message : String(err))}`;
  }
  await edit(bot, chatId, messageId, clamp(text));
}

/* ------------------------------- 链接：分享转存 ------------------------------- */

async function beginShare(bot: BotLike, chatId: string, userId: number, link: string, settings: AppSettings): Promise<void> {
  if (!perms(settings).shareReceive) {
    await bot.sendMessage(chatId, "分享转存功能未开启：到 OpenStrm 的 Telegram 页打开「允许转存分享」。");
    return;
  }
  let info: ShareSummary;
  try {
    info = await deps.shareInfo(link);
  } catch (err) {
    await bot.sendMessage(chatId, `读取分享失败：${esc(err instanceof Error ? err.message : String(err))}`);
    return;
  }
  if (info.items.length === 0) {
    await bot.sendMessage(chatId, "这个分享是空的，或者提取码不对。");
    return;
  }
  const targets = destinationTasks(info.kind, true);
  if (targets.length === 0) {
    await bot.sendMessage(chatId, `没有${KIND_LABEL[info.kind]}账号的同步任务，先到首页建一个再来转存。`);
    return;
  }
  const token = createPending(chatId, userId, { kind: "share", link: info.link, name: info.name, items: info.items });
  const listing = info.items.slice(0, 10).map((i) => `${i.isDir ? "📁" : "📄"} ${esc(shortName(i.name))}`);
  if (info.count > 10) listing.push(`…共 ${info.count} 项`);
  const buttons: InlineKeyboard = targets.slice(0, 15).map((t) => [{ text: `📁 转存到 ${shortName(t.originPath, 36)}`, callback_data: `shr:${token}:${t.id}` }]);
  buttons.push([{ text: "取消", callback_data: `drop:${token}` }]);
  await bot.sendMessage(
    chatId,
    clamp([`📦 <b>${esc(info.name)}</b>`, ...listing, "", "整个分享转存到哪个任务的目录？选完还能进子文件夹；转存后会触发该任务的后台同步。"].join("\n")),
    { buttons },
  );
}

async function finishShare(
  bot: BotLike,
  chatId: string,
  messageId: number | undefined,
  pending: Extract<PendingAction, { kind: "share" }>,
  task: TaskDefinition,
  subPath: string,
): Promise<void> {
  const r = await deps.receiveShare({ task, link: pending.link, items: pending.items, subPath });
  const target = `${task.originPath}${subPath ? `/${subPath}` : ""}`;
  const head = r.ok ? `✅ <b>${esc(pending.name)}</b>` : `❌ <b>${esc(pending.name)}</b> 转存失败`;
  await edit(bot, chatId, messageId, clamp(`${head}\n目录：${esc(target)}\n${esc(r.message)}`));
}

/* ------------------------------- 目的地浏览（云下载 / 转存共用） ------------------------------- */

/** 会浏览目的地的两种动作；搜索结果列表不浏览目录 */
type BrowsableAction = Exclude<PendingAction, { kind: "search" }>;

const BROWSE_PAGE_SIZE = 10;

function browsePerm(settings: AppSettings, kind: "offline" | "share"): string | null {
  const p = perms(settings);
  if (kind === "offline" && !p.offlineAdd) return "云下载功能已关闭";
  if (kind === "share" && !p.shareReceive) return "分享转存功能已关闭";
  return null;
}

/** 浏览界面：往哪放 + 子目录按钮（分页，按序号回调）+ 就放这里 / 返回 / 取消 */
function renderBrowse(
  token: string,
  action: BrowsableAction,
  /** 浏览的根：任务的 originPath，或 OpenList 目的地浏览的 dstDir */
  root: string,
  browse: BrowseState,
): { text: string; buttons: InlineKeyboard } {
  const copy = browse.openlistBase != null;
  const offline = action.kind === "offline";
  const target = [root, ...browse.segments].join("/");
  const pages = Math.max(1, Math.ceil(browse.dirs.length / BROWSE_PAGE_SIZE));
  const page = Math.min(browse.page, pages - 1);
  const lines = [
    offline ? `☁️ ${action.urls.length} 条链接` : `📦 <b>${esc(action.name)}</b>`,
    `${copy ? "115 下完后，OpenList 复制到" : offline ? "下载到" : "转存到"}：<b>${esc(target)}</b>`,
    browse.dirs.length === 0
      ? "这一层没有子文件夹。"
      : `子文件夹 ${browse.dirs.length} 个${pages > 1 ? `（第 ${page + 1}/${pages} 页）` : ""}，点进去，或者就放这一层：`,
  ];
  const buttons: InlineKeyboard = [
    [{ text: copy ? "⬇️ 就复制到这里" : offline ? "⬇️ 就放这里" : "⬇️ 就存这里", callback_data: `go:${token}` }],
  ];
  const start = page * BROWSE_PAGE_SIZE;
  for (let i = start; i < Math.min(start + BROWSE_PAGE_SIZE, browse.dirs.length); i++) {
    buttons.push([{ text: `📁 ${shortName(browse.dirs[i], 40)}`, callback_data: `nav:${token}:${i}` }]);
  }
  const pager: InlineKeyboard[number] = [];
  if (page > 0) pager.push({ text: "⬅️ 上一页", callback_data: `nav:${token}:p${page - 1}` });
  if (page < pages - 1) pager.push({ text: "➡️ 下一页", callback_data: `nav:${token}:p${page + 1}` });
  if (pager.length > 0) buttons.push(pager);
  const tail: InlineKeyboard[number] = [];
  if (browse.segments.length > 0) tail.push({ text: "↩️ 返回上一级", callback_data: `nav:${token}:up` });
  tail.push({ text: "取消", callback_data: `drop:${token}` });
  buttons.push(tail);
  return { text: clamp(lines.join("\n")), buttons };
}

/** 列出这一层、把状态写回 pending、改写消息。列目录失败会抛出去：pending 没动，重点一次就是重试 */
async function showBrowse(
  bot: BotLike,
  chatId: string,
  messageId: number | undefined,
  token: string,
  action: BrowsableAction,
  task: TaskDefinition,
  segments: string[],
): Promise<void> {
  const dirs = await deps.listSubdirs(task, segments);
  const browse: BrowseState = { taskId: task.id, segments, dirs, page: 0 };
  updatePending(token, { ...action, browse });
  const { text, buttons } = renderBrowse(token, action, task.originPath, browse);
  await edit(bot, chatId, messageId, text, buttons);
}

/** OpenList 目的地浏览的对应物：根是进入浏览那一刻设置页的 dstDir，冻结在 browse 状态里 */
async function showCopyBrowse(
  bot: BotLike,
  chatId: string,
  messageId: number | undefined,
  token: string,
  action: BrowsableAction,
  base: string,
  segments: string[],
): Promise<void> {
  const dirs = await deps.listOpenlistDirs([base, ...segments].join("/"));
  const browse: BrowseState = { taskId: "", openlistBase: base, segments, dirs, page: 0 };
  updatePending(token, { ...action, browse });
  const { text, buttons } = renderBrowse(token, action, base, browse);
  await edit(bot, chatId, messageId, text, buttons);
}

/* ------------------------------- 资源搜索 ------------------------------- */

/** 关键词最多多长：和网页、接口同一个上限 */
const SEARCH_KEYWORD_MAX = 100;
/** 结果列表一页几条；每类最多留几条（按钮的回调里只放序号，列表存在 pending 里） */
const SEARCH_PAGE_SIZE = 8;
const SEARCH_PER_KIND = 15;
const SEARCH_KINDS: SearchHitKind[] = ["115", "quark", "magnet", "ed2k"];
const SEARCH_KIND_LABEL: Record<SearchHitKind, string> = { "115": "115", quark: "夸克", magnet: "磁力", ed2k: "电驴" };
const FOLLOWED_LABEL = { active: "已在追更", stopped: "追更已停" } as const;

type SearchAction = Extract<PendingAction, { kind: "search" }>;

const isSearchKind = (k: string): k is SearchHitKind => (SEARCH_KINDS as string[]).includes(k);

/** 本机时区的年-月-日 */
function ymd(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 结果列表：序号 + 类型 + 标题 + 日期，下面是序号按钮、只看某类、翻页、取消 */
function renderSearch(token: string, s: SearchAction): { text: string; buttons: InlineKeyboard } {
  const kinds = SEARCH_KINDS.filter((k) => s.hits.some((h) => h.kind === k));
  const list = s.hits.map((hit, index) => ({ hit, index })).filter(({ hit }) => !s.filter || hit.kind === s.filter);
  const pages = Math.max(1, Math.ceil(list.length / SEARCH_PAGE_SIZE));
  const page = Math.min(Math.max(0, s.page), pages - 1);
  const start = page * SEARCH_PAGE_SIZE;
  const shown = list.slice(start, start + SEARCH_PAGE_SIZE);
  // 表头是搜到的总数；每类只留了前 SEARCH_PER_KIND 条，留少了就说一声
  const clipped = kinds.some((k) => (s.totals[k] ?? 0) > SEARCH_PER_KIND);
  const lines = [
    ...(s.library?.length ? [...s.library, ""] : []),
    `🔍 <b>${esc(s.keyword)}</b> · ${kinds.map((k) => `${SEARCH_KIND_LABEL[k]} ${s.totals[k] ?? 0}`).join(" · ")}`,
    ...(clipped ? [`每类只列前 ${SEARCH_PER_KIND} 条，全部的到网页「资源搜索」页看。`] : []),
    ...(s.blocked ? [`屏蔽词藏了 ${s.blocked} 条。`] : []),
    "",
    ...shown.map(
      ({ hit }, i) =>
        `${start + i + 1}. [${SEARCH_KIND_LABEL[hit.kind]}] ${esc(shortName(hit.title || hit.url, 48))}${hit.date ? ` · ${hit.date}` : ""}${hit.followed ? ` · <i>${FOLLOWED_LABEL[hit.followed]}</i>` : ""}`,
    ),
  ];
  if (pages > 1) lines.push("", `第 ${page + 1}/${pages} 页`);
  lines.push("", "点序号：分享会先列出内容、再选转存到哪；磁力、电驴交给 115 云下载。");
  const buttons: InlineKeyboard = [];
  for (let i = 0; i < shown.length; i += 4) {
    buttons.push(shown.slice(i, i + 4).map(({ index }, j) => ({ text: `${start + i + j + 1}`, callback_data: `srh:${token}:${index}` })));
  }
  if (kinds.length > 1 || s.filter) {
    const row: InlineKeyboard[number] = kinds
      .filter((k) => k !== s.filter)
      .map((k) => ({ text: `只看${SEARCH_KIND_LABEL[k]}`, callback_data: `srf:${token}:${k}` }));
    if (s.filter) row.unshift({ text: "全部", callback_data: `srf:${token}:all` });
    buttons.push(row);
  }
  const pager: InlineKeyboard[number] = [];
  if (page > 0) pager.push({ text: "⬅️ 上一页", callback_data: `srp:${token}:${page - 1}` });
  if (page < pages - 1) pager.push({ text: "➡️ 下一页", callback_data: `srp:${token}:${page + 1}` });
  if (pager.length > 0) buttons.push(pager);
  buttons.push([{ text: "取消", callback_data: `drop:${token}` }]);
  return { text: clamp(lines.join("\n")), buttons };
}

/** 影库在 /s 里列几条 */
const LIBRARY_LINES = 3;

/**
 * 影库那一段：前几条的目录名、来自哪个分享的哪一层、大小；转存到网页「影库」页做（这里只报有，免得机器人里再长一套按钮）。
 * 已失效分享里的不列；疑似失效的标出来
 */
function libraryLines(keyword: string): string[] {
  let r: LibrarySearchResult;
  try {
    r = deps.searchLibrary(keyword);
  } catch {
    return [];
  }
  if (r.hits.length === 0) return [];
  const size = (b: number | null) =>
    b && b > 0 ? ` · ${b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)}T` : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}G` : `${Math.max(1, Math.round(b / 1024 ** 2))}M`}` : "";
  return [
    `🔖 <b>收藏夹里有 ${r.total} 条</b>${r.total > r.hits.length ? `（列前 ${r.hits.length} 条）` : ""}`,
    ...r.hits.map((h) => {
      // 分享标题常和第一层目录同名（「老K / 老K / 1. 电影」）：相邻重复的只留一个
      const where = [h.shareTitle, ...h.crumbs.slice(0, -1).map((c) => c.name)].filter((seg, i, all) => seg && seg !== all[i - 1]).join(" / ");
      const flag = h.health.status === "suspect" ? " · <i>可能已失效</i>" : h.health.status === "locked" ? " · <i>提取码不对</i>" : "";
      // 认出来的作品：TMDB 上的名字和年份（和目录名不一样才写，low 的说「可能是」）
      const w = h.work;
      const work = w && (w.title !== h.name || w.year) ? ` · ${w.confidence === "low" ? "可能是" : ""}《${esc(shortName(w.title, 30))}》${w.year ? w.year : ""}` : "";
      return `• ${esc(shortName(h.name, 40))}${work}${size(h.size)}${flag}\n  <i>${esc(shortName(where, 40))}</i>`;
    }),
    "到网页「收藏夹」页打开、转存。",
  ];
}

/** 各聊天正在跑的搜索：同一个聊天一次只搜一个，免得连发几条就同时压给 PanSou 好几轮 */
const runningSearches = new Map<string, Promise<void>>();

/**
 * 搜一次：先回「在搜」，服务端多问几轮拿到结果后改成列表。点序号再走转存 / 云下载那两条现成的路，权限开关由它们各自查。
 * 整个过程放到后台：一次要十几秒，而轮询是一条消息处理完才取下一条，等在这里的话整个机器人都不理人（别人的命令、按钮都卡住）
 */
async function startSearch(bot: BotLike, chatId: string, userId: number, keyword: string): Promise<void> {
  const kw = cutText(keyword.trim(), SEARCH_KEYWORD_MAX);
  if (!kw) {
    await bot.sendMessage(chatId, "用法：<code>/s 片名</code>，比如 <code>/s 沙丘2</code>");
    return;
  }
  if (!deps.resourceSearchConfigured()) {
    const library = libraryLines(kw);
    await bot.sendMessage(
      chatId,
      library.length
        ? [...library, "", "网上搜要先在设置页配置资源搜索，这次只搜了收藏夹。"].join("\n")
        : `收藏夹里没有「${esc(kw)}」；${esc(PANSOU_NOT_CONFIGURED)}，网上搜不了。`,
    );
    return;
  }
  if (runningSearches.has(chatId)) {
    await bot.sendMessage(chatId, "上一个搜索还没出结果，等它出来再搜下一个。");
    return;
  }
  const job = (async () => {
    const first = await bot.sendMessage(chatId, `🔍 在搜「${esc(kw)}」…PanSou 边搜边补，要十来秒。`);
    await finishSearch(bot, chatId, userId, kw, first.result?.message_id);
  })()
    .catch((err: unknown) => log.error({ err, chatId }, "资源搜索的结果没发出去"))
    .finally(() => runningSearches.delete(chatId));
  runningSearches.set(chatId, job);
}

/** 测试用：等后台的搜索都跑完 */
export async function __test_waitSearches(): Promise<void> {
  await Promise.all([...runningSearches.values()]);
}

/**
 * 结果 → 列表。只列这里接得住的：四类里有账号的那几类（没 115 账号的，115 分享和磁力点了也只会报「先加账号」）；
 * 每类留前 SEARCH_PER_KIND 条，一类多了不把后面几类挤没
 */
async function finishSearch(bot: BotLike, chatId: string, userId: number, kw: string, messageId: number | undefined): Promise<void> {
  let result: SettledResult;
  try {
    result = await deps.searchResources(kw);
  } catch (err) {
    // 报错里可能带着 PanSou 回的原话：截短，别让一条消息超过 Telegram 的长度上限
    await edit(bot, chatId, messageId, `❌ 搜索失败：${esc(shortName(err instanceof Error ? err.message : String(err), 300))}`);
    return;
  }
  const { items } = result;
  const blocked = result.blocked ?? 0;
  const hits: SearchHit[] = [];
  const totals: SearchAction["totals"] = {};
  const unusable: string[] = [];
  for (const kind of SEARCH_KINDS) {
    const ofKind = items.filter((h) => h.kind === kind);
    if (ofKind.length === 0) continue;
    if (ofKind[0].action === null) {
      unusable.push(`${SEARCH_KIND_LABEL[kind]} ${ofKind.length} 条`);
      continue;
    }
    totals[kind] = ofKind.length;
    for (const h of ofKind.slice(0, SEARCH_PER_KIND)) {
      const date = ymd(h.publishedAt);
      hits.push({ kind, url: h.url, title: h.title, ...(date ? { date } : {}), ...(h.followed ? { followed: h.followed } : {}) });
    }
  }
  const library = libraryLines(kw);
  if (hits.length === 0) {
    // 屏蔽词另外藏掉的也说一声：不然人以为能用的就只有这些
    const alsoBlocked = blocked > 0 ? `（屏蔽词另外藏了 ${blocked} 条）` : "";
    let text: string;
    if (unusable.length > 0) {
      text = `「${esc(kw)}」搜到 ${unusable.join("、")}，但还没有接得住的账号：115 分享和磁力、电驴要 115 账号，夸克分享要夸克账号。先到 OpenStrm 的「账户」页加一个，或者到网页的「资源搜索」页复制链接。${alsoBlocked}`;
    } else if (items.length > 0) {
      text = `「${esc(kw)}」只搜到百度、阿里这类网盘的链接，这里接不住；到网页的「资源搜索」页能看到、复制。${alsoBlocked}`;
    } else if (blocked > 0) {
      text = `「${esc(kw)}」搜到的 ${blocked} 条都被屏蔽词藏掉了：到 OpenStrm 设置页「资源搜索」看看屏蔽词。`;
    } else if (!result.complete) {
      // 国内连不上 TG、插件又慢的时候，前几轮一直是 0 条：插件跑完以后再问才算数
      text = `还没搜到「${esc(kw)}」：PanSou 的插件可能还没搜完，过半分钟再发一次同一个词；还是没有再换个说法（去掉年份、用别名或英文名）。`;
    } else {
      text = `没搜到「${esc(kw)}」：换个说法（去掉年份、用别名或英文名）再试。`;
    }
    await edit(bot, chatId, messageId, library.length ? [...library, "", `网上：${text}`].join("\n") : text);
    return;
  }
  const action: SearchAction = { kind: "search", keyword: kw, hits, totals, ...(blocked ? { blocked } : {}), ...(library.length ? { library } : {}), filter: null, page: 0 };
  const token = createPending(chatId, userId, action);
  const { text, buttons } = renderSearch(token, action);
  await edit(bot, chatId, messageId, text, buttons);
}

/**
 * 追更名 → 搜索关键词；拿不出片名是空串。没起名的追更，名字就是分享码（也有人把链接填成名字），拿它去搜什么也搜不到。
 * keywordFromName 自己也会把分享码、链接滤掉，这里再按这个订阅自己的分享码核一遍，不全指望它认得出
 */
function followKeyword(follow: { name: string; shareCode: string }): string {
  const kw = keywordFromName(follow.name).trim();
  if (!kw || kw.toLowerCase() === follow.shareCode.trim().toLowerCase() || /[a-z][\w+.-]*:\/\//i.test(kw)) return "";
  return kw;
}

/* ------------------------------- 按钮回调 ------------------------------- */

async function edit(bot: BotLike, chatId: string, messageId: number | undefined, text: string, buttons?: InlineKeyboard): Promise<void> {
  if (messageId != null) {
    const r = await bot.editMessage(chatId, messageId, text, buttons);
    // 同一个按钮连点两下，第二次内容没变，Telegram 回「message is not modified」：当成改好了，别再发一条一样的。
    // 这是个 400，TelegramBot 把原话放在 error 里，description 是空的
    if (r.ok || /message is not modified/i.test(r.error ?? r.description ?? "")) return;
  }
  await bot.sendMessage(chatId, text, buttons ? { buttons } : undefined);
}

async function handleCallback(bot: BotLike, q: TelegramCallbackQuery): Promise<void> {
  const settings = deps.settings();
  const chat = q.message?.chat;
  if (!chat) {
    await bot.answerCallback(q.id);
    return;
  }
  if (checkAccess(settings, q.from, chat) !== "ok") {
    await bot.answerCallback(q.id, "没有权限", { alert: true });
    return;
  }
  const chatId = String(chat.id);
  const messageId = q.message?.message_id;
  const data = q.data ?? "";
  const [action, ...rest] = data.split(":");
  const arg = rest.join(":");

  try {
    switch (action) {
      case "noop":
        await bot.answerCallback(q.id);
        return;
      case "run": {
        if (!perms(settings).taskStart) {
          await bot.answerCallback(q.id, "未开启从 Telegram 启动任务");
          await bot.sendMessage(chatId, "「运行」未开启：到 OpenStrm 的 Telegram 页打开「允许从 Telegram 启动任务」。");
          return;
        }
        const task = deps.listTasks().find((t) => t.id === arg);
        if (!task) {
          await bot.answerCallback(q.id, "任务不存在");
          return;
        }
        await bot.answerCallback(q.id, "启动中…");
        const r = await deps.startTask(task.id);
        await bot.sendMessage(chatId, `${r.ok ? "🚀" : "❌"} <b>${esc(taskLabel(task))}</b>\n${esc(r.message)}`);
        return;
      }
      case "cancel": {
        const task = deps.listTasks().find((t) => t.id === arg);
        const ok = deps.cancelTask(arg);
        await bot.answerCallback(q.id, ok ? "已取消" : "任务没在运行");
        await bot.sendMessage(chatId, ok ? `⏹ 已取消 ${esc(task ? taskLabel(task) : arg)}` : "这个任务没在运行。");
        return;
      }
      case "hist": {
        const task = deps.listTasks().find((t) => t.id === arg);
        const runs = deps.taskExecutions(arg, 3);
        await bot.answerCallback(q.id);
        if (runs.length === 0) {
          await bot.sendMessage(chatId, `${esc(task ? taskLabel(task) : arg)} 还没有执行记录。`);
          return;
        }
        const label = task ? taskLabel(task) : runs[0].taskInfo.originPath || arg;
        await bot.sendMessage(chatId, clamp([`<b>${esc(label)}</b>`, "", ...runs.map((r) => `${describeRun(r)} · ${fmtTime(r.startTime)}`)].join("\n")));
        return;
      }
      case "drop": {
        // 群里别人点「取消」不能把你的操作弄没（和选目录、搜索结果的按钮一样）
        const pending = peekPending(arg);
        if (pending && pending.userId !== q.from.id) {
          await bot.answerCallback(q.id, "这不是你发起的操作", { alert: true });
          return;
        }
        takePending(arg);
        await bot.answerCallback(q.id);
        await edit(bot, chatId, messageId, "已取消。");
        return;
      }
      case OAUTH_APPROVE_ACTION:
      case OAUTH_DENY_ACTION: {
        const [requestId, preset = "daily"] = arg.split(":");
        const approve = action === OAUTH_APPROVE_ACTION;
        let ok: boolean;
        if (approve) {
          // 批准按钮只在配对码对上之后才发出来；这里再核一遍：开关开着、这个请求刚在这个聊天里用配对码解锁过
          if (!perms(settings).oauthApproval) {
            await bot.answerCallback(q.id, "Telegram 里批准网页客户端没开", { alert: true });
            return;
          }
          const unlock = oauthUnlocks.get(requestId);
          if (!unlock || unlock.chatId !== chatId || Date.now() - unlock.at > UNLOCK_TTL_MS) {
            await bot.answerCallback(q.id, "先把授权页上的配对码发给我", { alert: true });
            return;
          }
          oauthUnlocks.delete(requestId);
          ok = deps.approveOAuth(requestId, unlock.code, preset) === "ok";
        } else {
          oauthUnlocks.delete(requestId);
          ok = deps.denyOAuth(requestId);
        }
        const original = deps.oauthRequestText(requestId);
        if (!ok) {
          await bot.answerCallback(q.id, "这个授权请求已经处理过或过期了", { alert: true });
          if (original) await edit(bot, chatId, messageId, `${original}\n\n（已处理或已过期）`);
          return;
        }
        const result = approve ? `✅ 已批准（${preset === "read" ? "只读" : "日常"}），授权页会自动跳回客户端` : "❌ 已拒绝";
        await bot.answerCallback(q.id, approve ? "已批准" : "已拒绝");
        await edit(bot, chatId, messageId, original ? `${original}\n\n${result}` : result);
        return;
      }
      case "ofl":
      case "shr": {
        const [token, dest] = arg.split(":");
        const kind = action === "ofl" ? "offline" : "share";
        // 只看不取：选完任务还要逐层进目录，token 要一直用到「就放这里」。
        // 顺带修掉一个老毛病：以前先 take 再验用户，白名单里别人一点就把你的操作弄没了
        const pending = peekPending(token);
        if (!pending || pending.action.kind === "search" || pending.action.kind !== kind) {
          await bot.answerCallback(q.id, "已过期，请重新发一次链接", { alert: true });
          return;
        }
        if (pending.userId !== q.from.id) {
          await bot.answerCallback(q.id, "这不是你发起的操作", { alert: true });
          return;
        }
        // 权限可能在贴链接和点按钮之间被关掉了，点的时候再查一次
        const denied = browsePerm(settings, kind);
        if (denied) {
          await bot.answerCallback(q.id, denied, { alert: true });
          return;
        }
        if (kind === "offline" && dest === "default") {
          takePending(token);
          await bot.answerCallback(q.id, "提交中…");
          await finishOffline(bot, chatId, messageId, (pending.action as { urls: string[] }).urls, undefined, "");
          return;
        }
        if (kind === "offline" && dest === "defcopy") {
          // 先从设置页的 dstDir 出发选「这次复制到哪」，选完（就复制到这里）才提交
          if (!openlistCopyReady(settings)) {
            await bot.answerCallback(q.id, "「复制到 OpenList」的配置不完整，去设置页看看", { alert: true });
            return;
          }
          await bot.answerCallback(q.id, "读取目录…");
          await showCopyBrowse(bot, chatId, messageId, token, pending.action, normDirInput(settings.openlistCopy!.dstDir!), []);
          return;
        }
        const task = deps.listTasks().find((t) => t.id === dest);
        if (!task) {
          takePending(token);
          await bot.answerCallback(q.id, "任务不存在");
          await edit(bot, chatId, messageId, "这个任务已经不存在了，请重新发一次链接。");
          return;
        }
        await bot.answerCallback(q.id, "读取目录…");
        await showBrowse(bot, chatId, messageId, token, pending.action, task, []);
        return;
      }
      case "nav":
      case "go": {
        const [token, move] = arg.split(":");
        const pending = peekPending(token);
        const browse = pending?.action.browse;
        if (!pending || !browse) {
          await bot.answerCallback(q.id, "已过期，请重新发一次链接", { alert: true });
          return;
        }
        if (pending.userId !== q.from.id) {
          await bot.answerCallback(q.id, "这不是你发起的操作", { alert: true });
          return;
        }
        const denied = browsePerm(settings, pending.action.kind);
        if (denied) {
          await bot.answerCallback(q.id, denied, { alert: true });
          return;
        }
        // OpenList 目的地浏览没有任务；任务目录浏览才查任务还在不在
        const copyBase = browse.openlistBase ?? null;
        const task = copyBase != null ? undefined : deps.listTasks().find((t) => t.id === browse.taskId);
        if (copyBase == null && !task) {
          takePending(token);
          await bot.answerCallback(q.id, "任务不存在");
          await edit(bot, chatId, messageId, "这个任务已经不存在了，请重新发一次链接。");
          return;
        }
        const root = copyBase ?? task!.originPath;
        if (action === "go") {
          // 提交才取走：连点两下不会重复提交
          takePending(token);
          const subPath = browse.segments.join("/");
          if (pending.action.kind === "offline") {
            await bot.answerCallback(q.id, "提交中…");
            if (copyBase != null) {
              await finishOffline(bot, chatId, messageId, pending.action.urls, undefined, "", true, [root, ...browse.segments].join("/"));
            } else {
              await finishOffline(bot, chatId, messageId, pending.action.urls, task, subPath);
            }
          } else {
            await bot.answerCallback(q.id, "转存中…");
            await finishShare(bot, chatId, messageId, pending.action, task!, subPath);
          }
          return;
        }
        // 翻页只是换一页按钮，不重新列目录
        if (move.startsWith("p")) {
          const page = Number(move.slice(1));
          if (!Number.isInteger(page) || page < 0) {
            await bot.answerCallback(q.id);
            return;
          }
          const next: BrowseState = { ...browse, page };
          updatePending(token, { ...pending.action, browse: next });
          const { text, buttons } = renderBrowse(token, pending.action, root, next);
          await bot.answerCallback(q.id);
          await edit(bot, chatId, messageId, text, buttons);
          return;
        }
        // 返回上一级 / 进入某个子目录：重新列那一层
        let segments: string[];
        if (move === "up") {
          segments = browse.segments.slice(0, -1);
        } else {
          const name = browse.dirs[Number(move)];
          if (!name) {
            await bot.answerCallback(q.id, "列表变了，重新点一下");
            return;
          }
          segments = [...browse.segments, name];
        }
        await bot.answerCallback(q.id, "读取目录…");
        if (copyBase != null) await showCopyBrowse(bot, chatId, messageId, token, pending.action, copyBase, segments);
        else await showBrowse(bot, chatId, messageId, token, pending.action, task!, segments);
        return;
      }
      case "srh":
      case "srp":
      case "srf": {
        const [token, value = ""] = arg.split(":");
        // 只看不取：一个结果列表可以点好几条
        const pending = peekPending(token);
        if (!pending || pending.action.kind !== "search") {
          await bot.answerCallback(q.id, "已过期，请重新搜一次", { alert: true });
          return;
        }
        if (pending.userId !== q.from.id) {
          await bot.answerCallback(q.id, "这不是你发起的搜索", { alert: true });
          return;
        }
        const search = pending.action;
        if (action === "srh") {
          const hit = search.hits[Number(value)];
          if (!hit) {
            await bot.answerCallback(q.id, "列表变了，重新搜一次");
            return;
          }
          await bot.answerCallback(q.id);
          // 转存 / 云下载各走各的路：权限开关、选目录都在那边
          if (hit.kind === "115" || hit.kind === "quark") await beginShare(bot, chatId, q.from.id, hit.url, settings);
          else await beginOffline(bot, chatId, q.from.id, [hit.url], settings);
          return;
        }
        let next: SearchAction;
        if (action === "srf") {
          if (value !== "all" && !isSearchKind(value)) {
            await bot.answerCallback(q.id);
            return;
          }
          next = { ...search, filter: value === "all" ? null : value, page: 0 };
        } else {
          const page = Number(value);
          if (!Number.isInteger(page) || page < 0) {
            await bot.answerCallback(q.id);
            return;
          }
          next = { ...search, page };
        }
        updatePending(token, next);
        const { text, buttons } = renderSearch(token, next);
        await bot.answerCallback(q.id);
        await edit(bot, chatId, messageId, text, buttons);
        return;
      }
      case FOLLOW_SEARCH_ACTION: {
        // 追更通知（分享失效 / 长期没更新）里的「搜替代资源」：按订阅名搜
        const follow = deps.shareFollow(arg);
        if (!follow) {
          await bot.answerCallback(q.id, "这个追更已经不在了", { alert: true });
          return;
        }
        const keyword = followKeyword(follow);
        if (!keyword) {
          await bot.answerCallback(q.id);
          await bot.sendMessage(chatId, "这个追更的名字里拿不出片名（没起名的追更，名字就是分享码）：用 <code>/s 片名</code> 搜一下，或者到「追更」页给它改个名字。");
          return;
        }
        await bot.answerCallback(q.id, "开始搜…");
        await startSearch(bot, chatId, q.from.id, keyword);
        return;
      }
      default:
        await bot.answerCallback(q.id, "不认识的操作");
    }
  } catch (err) {
    log.error({ err, data }, "处理 Telegram 按钮失败");
    await bot.answerCallback(q.id, "出错了", { alert: true });
    await bot.sendMessage(chatId, `❌ 操作失败：${esc(err instanceof Error ? err.message : String(err))}`);
  }
}

