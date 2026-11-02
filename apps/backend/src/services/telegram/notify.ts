/**
 * Telegram 通知渠道：services/notify.ts 端口上登记的一个 sink（index.ts 启动时登记）。
 * 业务代码往端口发"发生了什么"（NotifyEvent），这里负责：
 *   - 按设置里的开关过滤（任务开始默认关，其它默认开）
 *   - 同一件事短时间内只说一次（cookie 失效时监控每 30 秒撞一次，不能每次都响）
 *   - 套中文模板、HTML 转义、发到配置的 chatId
 * 发送失败只记日志，绝不抛到调用方。
 * 安全告警、OAuth 授权请求是 Telegram 专属的流程（带按钮、不看开关），直接从这里调，不经端口。
 */
import { classifyAccountIssue } from "../drive/errors.js";
import type { OAuthPendingRequest } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { moduleLogger } from "../../lib/logger.js";
import { notifyPrefs, type AccountIssue, type EmbyNewGroup, type NotifyEvent, type TaskTrigger } from "../notify.js";
import { createTelegramBot, type InlineKeyboard } from "./bot.js";
import { oauthNotifyBucket } from "../agent/rate-limit.js";
import { cutText, esc, fmtDuration, taskLabel } from "./format.js";
import { FAILURE_LABEL } from "../organize/failure-kinds.js";

const log = moduleLogger("telegram");

/** 从错误文案里认出"该换 cookie 了"和"被封控了"：规则在 drive/errors.ts（分类器也用它），这里只是转一手 */
export { classifyAccountIssue };

const TRIGGER_LABEL: Record<TaskTrigger, string> = {
  manual: "手动",
  cron: "定时",
  telegram: "Telegram",
  share: "转存",
  agent: "智能体",
};

/* ------------------------------- 去重 ------------------------------- */

const COOLDOWN_MS = 60 * 60 * 1000;
const recent = new Map<string, number>();

/** 同一个 key 一小时内只放行一次 */
function throttled(key: string, now = Date.now()): boolean {
  const last = recent.get(key);
  if (last !== undefined && now - last < COOLDOWN_MS) return true;
  recent.set(key, now);
  if (recent.size > 500) {
    for (const [k, t] of recent) if (now - t >= COOLDOWN_MS) recent.delete(k);
  }
  return false;
}

/* ------------------------------- 模板 ------------------------------- */

function accountAlertText(account: string, issue: AccountIssue, source: string, reason: string): string {
  const head =
    issue === "cookie"
      ? `⚠️ <b>网盘账号需要处理</b>\n账号 <b>${esc(account)}</b> 的 cookie 已失效，同步和监控都会失败，请到「账户」页更新（115 可以直接重新扫码）。`
      : `⚠️ <b>网盘账号被封控</b>\n账号 <b>${esc(account)}</b> 的访问被阻断，请稍后再试或检查账号状态。`;
  return `${head}\n来源：${esc(source)}\n<code>${esc(cutText(reason, 200))}</code>`;
}

/** 连号折叠：5,6,7,9 → E05-E07、E09 */
function fmtEpisodes(eps: number[]): string {
  const one = (n: number) => `E${String(n).padStart(2, "0")}`;
  const parts: string[] = [];
  for (let i = 0; i < eps.length; ) {
    let j = i;
    while (j + 1 < eps.length && eps[j + 1] === eps[j] + 1) j++;
    parts.push(j > i ? `${one(eps[i])}-${one(eps[j])}` : one(eps[i]));
    i = j + 1;
  }
  return parts.join("、");
}

function embyNewLine(g: EmbyNewGroup): string {
  if (g.kind === "tv") {
    const season = g.season != null ? ` S${String(g.season).padStart(2, "0")}` : "";
    const eps = g.episodes.length > 0 ? `：${fmtEpisodes(g.episodes)}` : "";
    return `《${esc(g.name)}》${season} 新增 ${g.count} 集${eps}`;
  }
  return `《${esc(g.name)}》${g.year != null ? `(${g.year})` : ""}`;
}

function render(event: NotifyEvent): string {
  switch (event.type) {
    case "task-start":
      return `🚀 <b>任务开始</b>${event.trigger ? `（${TRIGGER_LABEL[event.trigger]}）` : ""}\n${esc(taskLabel(event.task))}\n账户 ${esc(event.task.account)} · ${event.total} 个文件待处理`;
    case "task-done": {
      const label = esc(taskLabel(event.task));
      const counts = `${event.finished}/${event.total} 个文件`;
      if (event.status === "completed") return `✅ <b>同步完成</b>\n${label}\n${counts}，用时 ${fmtDuration(event.durationMs)}`;
      if (event.status === "cancelled") return `⏹ <b>任务已取消</b>\n${label}\n完成 ${counts}${event.message ? `\n${esc(event.message)}` : ""}`;
      return `❌ <b>同步失败</b>\n${label}\n完成 ${counts}，失败 ${event.failed}，用时 ${fmtDuration(event.durationMs)}${event.message ? `\n${esc(event.message)}` : ""}${event.advice ? `\n👉 ${esc(event.advice)}` : ""}`;
    }
    case "task-start-failed":
      return `❌ <b>任务启动失败</b>${event.trigger ? `（${TRIGGER_LABEL[event.trigger]}触发）` : ""}\n${esc(taskLabel(event.task))}\n${esc(event.reason)}`;
    case "offline-done":
      return `☁️ <b>云下载完成</b>\n${esc(event.name)}\n${esc(event.detail)}\n→ ${esc(event.target)}`;
    case "offline-failed":
      return `❌ <b>云下载未能生成 strm</b>\n${esc(event.name)}\n${esc(event.detail)}`;
    case "offline-copied":
      return `📦 <b>已复制到 OpenList</b>\n${esc(event.name)}\n→ ${esc(event.target)}`;
    case "offline-copy-failed":
      return `❌ <b>云下载未能复制到 OpenList</b>\n${esc(event.name)}\n${esc(event.detail)}`;
    case "copy-done": {
      const shown = event.names.slice(0, 8).map(esc).join("、");
      const more = event.names.length > 8 ? ` 等 ${event.names.length} 个` : "";
      // 复制成了、源文件却没按设置删 / 归档的：说一声，不然人以为搬运完了
      const kept = event.kept?.length
        ? `\n源文件没按设置处理：${event.kept.slice(0, 5).map(esc).join("；")}${event.kept.length > 5 ? ` 等 ${event.kept.length} 个` : ""}`
        : "";
      const retrying = event.retrying?.length
        ? `\n源文件稍后自动再处理：${event.retrying.slice(0, 5).map(esc).join("；")}${event.retrying.length > 5 ? ` 等 ${event.retrying.length} 个` : ""}`
        : "";
      return `📦 <b>已复制到 OpenList</b>（${esc(event.source)}）\n${shown}${more}\n→ ${esc(event.target)}${kept}${retrying}`;
    }
    case "copy-kept": {
      const shown = event.kept.slice(0, 5).map(esc).join("\n");
      const more = event.kept.length > 5 ? `\n等 ${event.kept.length} 个` : "";
      return `⚠️ <b>复制后源文件没按设置处理</b>（${esc(event.source)}）\n${shown}${more}\n复制已经完成；网盘上那份还在原处，需要的话手动处理`;
    }
    case "copy-failed": {
      const shown = event.names.slice(0, 8).map(esc).join("、");
      const more = event.names.length > 8 ? ` 等 ${event.names.length} 个` : "";
      return `❌ <b>复制到 OpenList 失败</b>（${esc(event.source)}）\n${shown}${more}\n${esc(event.detail)}\n在「云下载」页的复制队列里可以重试`;
    }
    case "follow-added": {
      const shown = event.added.slice(0, 8).map(esc).join("、");
      const more = event.added.length > 8 ? ` 等 ${event.added.length} 个` : "";
      return `📺 <b>追更：新增 ${event.added.length} 个</b>\n${esc(event.name)}\n${shown}${more}\n→ ${esc(event.target)}，已生成 ${event.generated} 个 strm`;
    }
    case "follow-failed":
      return `❌ <b>追更检查失败</b>\n${esc(event.name)}\n${esc(event.detail)}`;
    case "follow-expired":
      return `⚠️ <b>追更已停止</b>\n${esc(event.name)}\n分享已经打不开了：${esc(event.reason)}\n需要的话到「追更」页换个链接再继续。`;
    case "library-expired":
      return `⚠️ <b>收藏夹里的分享失效了</b>\n${esc(event.shareTitle)}${event.sources > 1 ? `（收了 ${event.sources} 处）` : ""}\n里面的资源已经转存不了；到「收藏夹」页可以找替代、更新链接或清理。`;
    case "follow-stale":
      return `💤 <b>追更已暂停</b>\n${esc(event.name)}\n${event.days} 天没有更新，先停下不再检查；要继续到「追更」页点「继续」。`;
    case "update-available":
      return `🆕 <b>OpenStrm 有新版本</b>\n${esc(event.current)} → <b>${esc(event.version)}</b>\n${esc(event.url)}\n升级前记得在「设置」里下载一次备份。`;
    case "emby-new": {
      if (event.groups.length === 0) return `📥 <b>Emby 入库</b>\n新增 ${event.total} 个条目（数量太多，不逐条列了）`;
      const lines = event.groups.slice(0, 12).map(embyNewLine);
      if (event.groups.length > 12) lines.push(`…还有 ${event.groups.length - 12} 部`);
      return `📥 <b>Emby 入库</b>\n${lines.join("\n")}`;
    }
    case "organize-done": {
      const kinds = event.failedByKind ?? {};
      const breakdown = (Object.keys(FAILURE_LABEL) as Array<keyof typeof FAILURE_LABEL>)
        .filter((k) => k !== "mirror" && (kinds[k] ?? 0) > 0)
        .map((k) => `${FAILURE_LABEL[k]} ${kinds[k]}`)
        .join("、");
      const mirror = kinds.mirror ?? 0;
      if (event.reverted) {
        const left = event.notReverted ?? 0;
        const head = left > 0 ? "⚠️ <b>整理已撤销（有没退回的）</b>" : "↩️ <b>整理已撤销</b>";
        const tail = left > 0 ? `，${left} 项没退回${breakdown ? `（${breakdown}）` : ""}` : "";
        const hint = left > 0 || mirror > 0 ? "\n到「整理」页继续撤销或放弃" : "";
        return `${head}\n${esc(taskLabel(event.task))}\n${event.units} 部作品，${event.done} 项已退回${tail}${mirror > 0 ? `，本地未同步 ${mirror}` : ""}${hint}`;
      }
      const head = event.failed > 0 ? "⚠️ <b>整理完成（有失败）</b>" : "🗂 <b>整理完成</b>";
      const parts = [`${event.units} 部作品，${event.done} 项已改名 / 移动`];
      if (event.failed > 0) parts.push(`失败 ${event.failed}${breakdown ? `（${breakdown}）` : ""}`);
      if (mirror > 0) parts.push(`本地未同步 ${mirror}`);
      const hint = event.failed > 0 || mirror > 0 ? "\n到「整理」页重试或放弃" : "";
      return `${head}\n${esc(taskLabel(event.task))}\n${parts.join("，")}${hint}`;
    }
    case "organize-review": {
      const extra = [event.unsure > 0 ? `${event.unsure} 部识别把握不大` : "", event.conflicts > 0 ? `${event.conflicts} 项冲突` : ""].filter(Boolean).join("，");
      return `🗂 <b>整理待确认</b>\n${esc(taskLabel(event.task))}\n${event.units} 部作品、${event.planned} 项待处理${extra ? `（${extra}）` : ""}\n到「整理」页确认后执行。`;
    }
    case "account-alert": {
      const issue = event.issue ?? classifyAccountIssue(event.reason);
      return issue ? accountAlertText(event.account, issue, event.source, event.reason) : "";
    }
  }
}

/* ------------------------------- 发送 ------------------------------- */

type Sender = (chatId: string, text: string) => Promise<void>;

const realSender: Sender = async (chatId, text) => {
  const token = readAppSettings().telegram?.botToken;
  if (!token) return;
  const res = await createTelegramBot(token).sendMessage(chatId, text);
  if (!res.ok) log.warn(`Telegram 通知发送失败：${res.error ?? res.description ?? "unknown"}`);
};

let sender: Sender = realSender;

/** 仅供测试：换掉真正的发送；传 null 恢复 */
export function setNotifySender(fn: Sender | null): void {
  sender = fn ?? realSender;
}

export function __test_resetNotify(): void {
  recent.clear();
}

/** 安全告警（比如管理员密码一小时里错了太多次）：不看通知开关，配了机器人就发 */
export async function notifySecurityAlert(text: string): Promise<boolean> {
  const telegram = readAppSettings().telegram;
  if (!telegram?.botToken || !telegram.chatId) return false;
  await sender(telegram.chatId, text);
  return true;
}

/* ------------------------------- OAuth 授权请求 ------------------------------- */

/** 按钮的回调数据前缀：`oaa:<请求 id>:<read|daily>` 批准、`oad:<请求 id>` 拒绝，commands.ts 认这两个 */
export const OAUTH_APPROVE_ACTION = "oaa";
export const OAUTH_DENY_ACTION = "oad";
/** 追更通知里「搜替代资源」按钮：`fsr:<订阅 id>` */
export const FOLLOW_SEARCH_ACTION = "fsr";

const SCOPE_TEXT: Record<string, string> = { read: "查看", run: "运行", write: "改网盘", danger: "危险操作" };

type ButtonSender = (chatId: string, text: string, buttons: InlineKeyboard) => Promise<void>;

const realButtonSender: ButtonSender = async (chatId, text, buttons) => {
  const token = readAppSettings().telegram?.botToken;
  if (!token) return;
  const res = await createTelegramBot(token).sendMessage(chatId, text, { buttons });
  if (!res.ok) log.warn(`Telegram 带按钮的通知发送失败：${res.error ?? res.description ?? "unknown"}`);
};

let buttonSender: ButtonSender = realButtonSender;

/** 仅供测试：换掉带按钮的发送；传 null 恢复 */
export function setButtonSender(fn: ButtonSender | null): void {
  buttonSender = fn ?? realButtonSender;
}

/** 一条授权请求的说明（通知、配对码对上后回的消息都用）：名字是客户端自己报的，CIMD 的另外给出它地址的域名 */
export function oauthRequestText(req: OAuthPendingRequest): string {
  const lines = [
    "🔐 <b>有客户端请求连接 OpenStrm</b>",
    req.clientHost ? `${esc(req.clientName)}（身份：${esc(req.clientHost)}）` : `${esc(req.clientName)}（名字是它自己报的）`,
    `授权后跳到：${esc(req.redirectHost)}${req.redirectInsecure ? "（公网上的 http，明文）" : req.redirectLoopback ? "（本机）" : ""}`,
  ];
  if (req.requestedScopes.length > 0) lines.push(`它要：${req.requestedScopes.map((s) => SCOPE_TEXT[s] ?? s).join("、")}`);
  if (req.ip) lines.push(`来自：${esc(req.ip)}`);
  return lines.join("\n");
}

/**
 * 有客户端在授权页上等批准：推到通知的那个聊天，只带「拒绝」按钮。批准要证明批的是自己眼前那一条：
 * 开了 Telegram 里批准的，把授权页上的配对码发给机器人才出批准按钮；没开的到设置页里批。
 * 不看通知开关（这是要人去处理的）；一小时最多 10 条，有人刷授权请求时不至于刷屏
 */
export async function notifyOAuthRequest(req: OAuthPendingRequest): Promise<boolean> {
  const telegram = readAppSettings().telegram;
  if (!telegram?.botToken || !telegram.chatId) return false;
  if (!oauthNotifyBucket.take("all").ok) {
    log.warn({ requestId: req.id }, "授权请求通知太多，这一条不发了（设置页里照样看得到）");
    return false;
  }
  const how = [
    req.passwordApproval ? "是你自己在连接的话，直接在授权页上输管理员密码批准就行。" : "",
    telegram.allowOAuthApproval
      ? "是你自己发起的：把授权页上显示的配对码发给我，我回你批准按钮。不是你发起的就点拒绝。"
      : "要批准：到 OpenStrm 的「设置 → 智能体接入 → 待批准」里点「批准」，输入授权页上的配对码。不是你发起的就点拒绝。",
  ].join("");
  await buttonSender(telegram.chatId, `${oauthRequestText(req)}\n\n${how}`, [[{ text: "❌ 拒绝", callback_data: `${OAUTH_DENY_ACTION}:${req.id}` }]]);
  return true;
}

/** 事件是否该发、发什么，都在这里决定。返回是否真的发出去了。作为渠道登记到 services/notify.ts 上 */
export async function telegramNotify(event: NotifyEvent): Promise<boolean> {
  try {
    const settings = readAppSettings();
    const telegram = settings.telegram;
    if (!telegram?.botToken || !telegram.chatId) return false;
    const prefs = notifyPrefs(settings);

    let text: string;
    switch (event.type) {
      case "task-start":
        if (!prefs.taskStart) return false;
        text = render(event);
        break;
      case "task-done":
        if (event.status === "failed" ? !prefs.taskFailed : !prefs.taskDone) return false;
        text = render(event);
        break;
      case "task-start-failed": {
        // 起不来多半是账号的问题：按账号告警去重，别每次定时触发都来一条
        const issue = event.issue ?? classifyAccountIssue(event.reason);
        if (issue) {
          if (!prefs.accountAlert) return false;
          if (throttled(`account:${event.task.account}:${issue}`)) return false;
          text = accountAlertText(event.task.account, issue, `任务 ${taskLabel(event.task)}`, event.reason);
          break;
        }
        if (!prefs.taskFailed) return false;
        if (throttled(`start-failed:${event.task.id}:${event.reason.slice(0, 80)}`)) return false;
        text = render(event);
        break;
      }
      // copy-* 跟着云下载那个开关走：复制本来就是从云下载长出来的，设置不用迁
      case "offline-done":
      case "offline-failed":
      case "offline-copied":
      case "offline-copy-failed":
      case "copy-done":
      case "copy-kept":
      case "copy-failed":
        if (!prefs.offline) return false;
        text = render(event);
        break;
      case "follow-added":
        if (!prefs.follow) return false;
        text = render(event);
        break;
      case "follow-expired":
      case "follow-stale": {
        if (!prefs.follow) return false;
        text = render(event);
        // 配了资源搜索就带个按钮：分享没了、或者这个分享不更了，最要紧的是找一个还在更的（commands.ts 认 fsr）
        if (text && settings.pansou?.baseUrl?.trim()) {
          await buttonSender(telegram.chatId, text, [[{ text: "🔍 搜替代资源", callback_data: `${FOLLOW_SEARCH_ACTION}:${event.id}` }]]);
          return true;
        }
        break;
      }
      case "follow-failed":
        if (!prefs.follow) return false;
        if (throttled(`follow-failed:${event.id}`)) return false;
        text = render(event);
        break;
      case "library-expired":
        if (!prefs.library) return false;
        text = render(event);
        break;
      case "emby-new":
        if (!prefs.embyNew) return false;
        text = render(event);
        break;
      case "update-available":
        if (!prefs.update) return false;
        text = render(event);
        break;
      case "organize-done":
      case "organize-review":
        if (!prefs.organize) return false;
        text = render(event);
        break;
      case "account-alert": {
        const issue = event.issue ?? classifyAccountIssue(event.reason);
        if (!issue || !prefs.accountAlert) return false;
        if (throttled(`account:${event.account}:${issue}`)) return false;
        text = render(event);
        break;
      }
    }
    if (!text) return false;
    await sender(telegram.chatId, text);
    return true;
  } catch (err) {
    log.warn({ err }, "Telegram 通知失败");
    return false;
  }
}
