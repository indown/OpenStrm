/**
 * 分享追更的编排层，路由只调这里。
 *
 *   - 建订阅：解析任务和账号，把范围内现有的条目列一遍当快照——当时没勾的东西以后也不会补转存。
 *   - 检查：重新列 → diff（diff.ts）→ 按落点分组转存并生成 strm（复用 share/receive.ts）
 *     → 更新快照、记动态、通知。
 *   - 一条循环每分钟挑到期的订阅顺序跑，条与条之间隔两秒（分享接口打得太密会被封 IP）；
 *     没有开着的订阅时循环自己停，建订阅 / 恢复时再起。
 *   - 状态全在 share_follows 表里，重启接着跑。
 *   - 整理结果（organized）：转存来的文件整理过之后，记下分享里每个目录整理成了什么（作品 / 季 / 集偏移），
 *     以后这个目录来的新文件交给整理时带上提示照着用；整理页又动了这批文件就跟着改，撤销那次整理就退回去。
 *
 * 网盘的差异全在 DriveProvider 里：订阅不存网盘类型，任务的账号是哪家就按哪家列分享和转存（建订阅时校验同类）。
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppSettings, OrganizeHint, ShareFollow, ShareFollowOrganized, ShareFollowRun, ShareFollowSummary, TaskDefinition } from "@openstrm/shared";
import { getTask } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import {
  countEnabledShareFollows,
  deleteShareFollow,
  findShareFollow,
  getShareFollow,
  insertShareFollow,
  listDueShareFollows,
  listShareFollows,
  listShareFollowSummaries,
  replaceShareFollows,
  toSummary,
  updateShareFollow,
} from "../../db/repositories/share-follows.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { createPollingLoop } from "../../lib/polling.js";
import { driveErrorToHttp } from "../drive/errors.js";
import { assertSameKind, KIND_LABEL, parseShareRef, providerForTask } from "../drive/registry.js";
import type { DriveProvider, ShareEntry, ShareProvider, ShareRef, ShareSession, ShareUpdateSignal, DriveKind } from "../drive/types.js";
import { ensureSaveDir, saveSelectionToTask } from "../share/receive.js";
import { withAfterCopy, type CopyOutcome } from "../copy/service.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { normalizeSubPath } from "../strm/naming.js";
import { issueFromDrive, notify, type NotifyEvent } from "../notify.js";
import { baseName, diffShareListing, groupByParent, mergeKnown, parentOf, scopeIsWhole, type ListedEntry } from "./diff.js";
import type { OrganizedVideo } from "../organize/hints.js";
import { describeFileFailure } from "../download/failure.js";

const log = moduleLogger("follow");

export const FOLLOW = {
  MIN_INTERVAL_MIN: 30,
  DEFAULT_INTERVAL_MIN: 360,
  MAX_INTERVAL_MIN: 7 * 24 * 60,
  /** 递归列目录的上限：整站合集级的分享不该拿追更来盯 */
  MAX_DEPTH: 4,
  MAX_ENTRIES: 3000,
  MAX_REQUESTS: 30,
  /** 分享接口连续这么多次说"不行"，就当分享没了 */
  EXPIRE_STREAK: 3,
  STALE_DAYS: 60,
  MAX_BACKOFF_MS: 24 * 3600_000,
  TICK_MS: 60_000,
  RECENT_KEEP: 20,
} as const;

const STALE_MS = FOLLOW.STALE_DAYS * 24 * 3600_000;

/* ------------------------------- 依赖注入 ------------------------------- */

/** 网盘那几步走 DriveProvider（测试用 setDriveProviderFactory 换假网盘）；这里只剩通知和时间 */
interface Deps {
  notify: (event: NotifyEvent) => Promise<unknown>;
  now: () => number;
  /** 下次检查时间的抖动，[0,1)；测试钉成 0.5 就没有抖动 */
  random: () => number;
  /** 一轮里两条订阅之间的间隔 */
  gapMs: number;
}

const realDeps: Deps = { notify, now: () => Date.now(), random: Math.random, gapMs: 2_000 };

let deps: Deps = { ...realDeps };

/** 仅供测试：换掉通知和时间；传 null 恢复 */
export function setFollowServiceDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 小工具 ------------------------------- */

const errMsg = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));

export function clampInterval(minutes: number | undefined): number {
  const n = Number.isFinite(minutes) ? Math.round(minutes as number) : FOLLOW.DEFAULT_INTERVAL_MIN;
  return Math.min(FOLLOW.MAX_INTERVAL_MIN, Math.max(FOLLOW.MIN_INTERVAL_MIN, n));
}

function normalizeCid(cid: string | number | undefined): string {
  const s = cid == null ? "" : String(cid).trim();
  return s === "" ? "0" : s;
}

function normalizeScope(scope: string[] | undefined): string[] {
  if (!scope || scope.length === 0) return [""];
  const names = [...new Set(scope.map((s) => s.trim()))];
  return names.includes("") ? [""] : names.filter(Boolean);
}

/** 下次检查：间隔按连续失败次数翻倍（封顶一天），再加 ±10% 抖动，几条订阅不会总在同一秒挤到网盘 */
function nextCheckAt(f: Pick<ShareFollow, "intervalMinutes">, streak: number, now: number): number {
  const base = f.intervalMinutes * 60_000;
  const delay = streak > 0 ? Math.min(base * 2 ** Math.min(streak, 5), FOLLOW.MAX_BACKOFF_MS) : base;
  const jitter = 1 + (deps.random() - 0.5) * 0.2;
  return now + Math.round(delay * jitter);
}

/** 记一条动态；同一个错误连着来只更新时间，别把 20 条位置全占了 */
function pushRecent(recent: ShareFollowRun[], run: ShareFollowRun): ShareFollowRun[] {
  const head = recent[0];
  const quietError = run.added.length === 0 && run.skipped.length === 0 && Boolean(run.error);
  if (quietError && head && head.added.length === 0 && head.skipped.length === 0 && head.error === run.error) {
    return [run, ...recent.slice(1)];
  }
  return [run, ...recent].slice(0, FOLLOW.RECENT_KEEP);
}

interface Target {
  task: TaskDefinition;
  provider: DriveProvider;
  share: ShareProvider;
}

function resolveTask(taskId: string): Target {
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
  if (!task.targetPath || !task.strmPrefix) throw new HttpError(400, "所选任务缺少 targetPath 或 strmPrefix 配置");
  const provider = providerForTask(task, "share");
  return { task, provider, share: provider.share! };
}

/** 订阅只存分享码和提取码；网盘类型就是任务账号的类型（建订阅时校验过同类） */
function refOf(f: Pick<ShareFollow, "shareUrl" | "shareCode" | "receiveCode">, provider: DriveProvider): ShareRef {
  return { kind: provider.kind, code: f.shareCode, password: f.receiveCode, url: f.shareUrl };
}

/* ------------------------------- 列分享目录 ------------------------------- */

class FollowTooLargeError extends Error {}

interface Budget {
  requests: number;
}

function toEntry(item: ShareEntry, prefix: string): ListedEntry {
  const entry: ListedEntry = {
    path: prefix ? `${prefix}/${item.name}` : item.name,
    isDir: item.isDir,
    id: String(item.id),
  };
  if (item.hash) entry.sha1 = item.hash;
  if (item.size != null) entry.size = item.size;
  if (item.token) entry.token = item.token;
  return entry;
}

async function listAll(share: ShareProvider, session: ShareSession, dirId: string, budget: Budget): Promise<ShareEntry[]> {
  const out: ShareEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    if (++budget.requests > FOLLOW.MAX_REQUESTS) {
      throw new FollowTooLargeError(`分享目录太大（列了 ${FOLLOW.MAX_REQUESTS} 次还没列完），追更只适合剧集级的目录`);
    }
    const page = await share.list(session, dirId, cursor);
    out.push(...page.entries);
    if (!page.next || page.entries.length === 0) return out;
    cursor = page.next;
  }
}

async function walk(
  share: ShareProvider,
  session: ShareSession,
  dirId: string,
  prefix: string,
  depth: number,
  budget: Budget,
  out: ListedEntry[],
): Promise<void> {
  for (const item of await listAll(share, session, dirId, budget)) {
    // 名字带 / 的条目没法用路径表示（会被当成子目录去找落点，每轮都失败），网盘侧的遍历同样跳过它
    if (item.name.includes("/")) {
      log.warn(`追更：分享里「${prefix ? `${prefix}/` : ""}${item.name}」的名字带 /，跳过`);
      continue;
    }
    const entry = toEntry(item, prefix);
    out.push(entry);
    if (out.length > FOLLOW.MAX_ENTRIES) {
      throw new FollowTooLargeError(`分享目录太大（超过 ${FOLLOW.MAX_ENTRIES} 项），追更只适合剧集级的目录`);
    }
    if (item.isDir && depth < FOLLOW.MAX_DEPTH) await walk(share, session, item.id, entry.path, depth + 1, budget, out);
  }
}

export interface ScopeListing {
  entries: ListedEntry[];
  /** 范围里已经不在分享里的目录名 */
  missingScopes: string[];
}

/** 把范围内的东西全列出来。范围是整个目录就从 watchCid 递归；否则先列一层找到范围目录再各自递归 */
async function listScope(
  share: ShareProvider,
  session: ShareSession,
  f: Pick<ShareFollow, "watchCid" | "scope">,
): Promise<ScopeListing> {
  const budget: Budget = { requests: 0 };
  const entries: ListedEntry[] = [];
  if (scopeIsWhole(f.scope)) {
    await walk(share, session, f.watchCid, "", 0, budget, entries);
    return { entries, missingScopes: [] };
  }
  const top = await listAll(share, session, f.watchCid, budget);
  const missingScopes: string[] = [];
  for (const name of f.scope) {
    const hit = top.find((it) => it.isDir && it.name === name);
    if (!hit) {
      missingScopes.push(name);
      continue;
    }
    entries.push(toEntry(hit, ""));
    await walk(share, session, hit.id, name, 1, budget, entries);
  }
  return { entries, missingScopes };
}

/* ------------------------------- 增删改查 ------------------------------- */

export interface CreateFollowInput {
  shareUrl?: string;
  shareCode?: string;
  receiveCode?: string;
  watchCid?: string | number;
  watchPath?: string;
  scope?: string[];
  taskId: string;
  subPath?: string;
  intervalMinutes?: number;
  name?: string;
  libraryId?: string | null;
}

export async function createFollow(input: CreateFollowInput): Promise<ShareFollowSummary> {
  let shareCode = (input.shareCode ?? "").trim();
  let receiveCode = (input.receiveCode ?? "").trim();
  const parsed = input.shareUrl?.trim() ? parseShareRef(input.shareUrl) : null;
  if (!shareCode && input.shareUrl?.trim()) {
    if (!parsed) throw new HttpError(400, "Invalid share url");
    shareCode = parsed.code;
    if (!receiveCode) receiveCode = parsed.password;
  }
  if (!shareCode) throw new HttpError(400, "shareCode is required");

  const { task, provider, share } = resolveTask(input.taskId);
  // 链接认得出是哪家的就必须和任务账号同类：115 的分享追不进夸克
  if (parsed) assertSameKind(parsed, provider);
  const watchCid = normalizeCid(input.watchCid);
  const existing = findShareFollow(shareCode, watchCid);
  if (existing) throw new HttpError(409, "这个分享目录已经在追更", { data: toSummary(existing) });

  const now = deps.now();
  const sec = Math.floor(now / 1000);
  const scope = normalizeScope(input.scope);
  const watchPath = (input.watchPath ?? "").trim();
  const draft: ShareFollow = {
    id: randomUUID(),
    name: (input.name ?? "").trim() || watchPath || shareCode,
    libraryId: input.libraryId ?? null,
    shareUrl: (input.shareUrl ?? "").trim() || parsed?.url || "",
    shareCode,
    receiveCode,
    watchCid,
    watchPath,
    scope,
    taskId: task.id,
    subPath: normalizeSubPath(input.subPath),
    enabled: true,
    intervalMinutes: clampInterval(input.intervalMinutes),
    status: "idle",
    lastError: "",
    errorStreak: 0,
    lastCheckedAt: now,
    lastChangeAt: null,
    nextCheckAt: 0,
    known: [],
    recent: [],
    organized: [],
    createdAt: sec,
    updatedAt: sec,
  };

  let listing: ScopeListing;
  try {
    const session = await share.open(refOf(draft, provider));
    listing = await listScope(share, session, draft);
  } catch (err) {
    throw driveErrorToHttp(err, "列分享目录失败");
  }
  if (!scopeIsWhole(scope) && listing.missingScopes.length === scope.length) {
    throw new HttpError(400, `在分享里没找到目录：${listing.missingScopes.join("、")}`);
  }
  draft.known = mergeKnown([], listing.entries);
  draft.nextCheckAt = nextCheckAt(draft, 0, now);
  insertShareFollow(draft);
  log.info(`新建追更「${draft.name}」：${draft.known.length} 项已记为现有，→ ${task.originPath}${draft.subPath ? `/${draft.subPath}` : ""}`);
  startFollowWatcher();
  return toSummary(draft);
}

/** 两个转存接口用：转存成功后顺手建订阅，建不成只把原因带回去，不影响这次转存 */
export async function createFollowAfterSave(input: CreateFollowInput): Promise<{ follow?: ShareFollowSummary; followError?: string }> {
  try {
    return { follow: await createFollow(input) };
  } catch (err) {
    log.warn({ err }, "转存后建追更订阅失败");
    return { followError: errMsg(err) };
  }
}

export interface UpdateFollowInput {
  name?: string;
  enabled?: boolean;
  intervalMinutes?: number;
  taskId?: string;
  subPath?: string;
  receiveCode?: string;
  /** 不再沿用整理结果：新文件交给整理时重新识别 */
  clearOrganized?: boolean;
}

export function updateFollow(id: string, input: UpdateFollowInput): ShareFollowSummary {
  const f = getShareFollow(id);
  if (!f) throw new HttpError(404, "追更订阅不存在");
  const now = deps.now();
  const patch: Partial<ShareFollow> = {};
  if (input.name !== undefined) patch.name = input.name.trim() || f.name;
  if (input.taskId !== undefined && input.taskId !== f.taskId) {
    const target = resolveTask(input.taskId);
    // 分享的网盘得和新任务的账号同类：115 的分享码在夸克账号上打不开，换过去只会一路失败到 expired。
    // 旧任务可能已经删了（换任务正是为了这个），类型从分享链接或旧任务记录里拿，两样都没有就不拦
    const oldTask = getTask(f.taskId);
    const kind = parseShareRef(f.shareUrl)?.kind ?? (oldTask?.accountType as DriveKind | undefined);
    if (kind && target.provider.kind !== kind) {
      throw new HttpError(400, `这个订阅盯的是 ${KIND_LABEL[kind]} 的分享，不能换到 ${KIND_LABEL[target.provider.kind]} 账号的任务`);
    }
    patch.taskId = target.task.id;
    // 整理结果里的目录是按旧任务记的
    patch.organized = [];
  }
  if (input.clearOrganized) patch.organized = [];
  if (input.subPath !== undefined) patch.subPath = normalizeSubPath(input.subPath);
  if (input.receiveCode !== undefined) patch.receiveCode = input.receiveCode.trim();
  if (input.intervalMinutes !== undefined) {
    patch.intervalMinutes = clampInterval(input.intervalMinutes);
    // 从上次检查算起：把 6 小时改成 1 小时，不该还要等满原来的 6 小时
    patch.nextCheckAt = Math.max(now, (f.lastCheckedAt ?? now) + patch.intervalMinutes * 60_000);
  }
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled;
    // 重新打开：失效 / 停更 / 出错的状态都清掉，尽快检查一次
    if (input.enabled && (!f.enabled || f.status !== "idle")) {
      patch.status = "idle";
      patch.errorStreak = 0;
      patch.lastError = "";
      patch.nextCheckAt = now;
    }
  }
  const updated = updateShareFollow(id, patch);
  if (!updated) throw new HttpError(404, "追更订阅不存在");
  if (updated.enabled) startFollowWatcher();
  return toSummary(updated);
}

export function deleteFollow(id: string): void {
  if (checking.has(id)) throw new HttpError(409, "正在检查中，稍后再删");
  if (!deleteShareFollow(id)) throw new HttpError(404, "追更订阅不存在");
}

export interface FollowWatcherStatus {
  running: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  /** 正在检查的订阅 id */
  checking: string[];
}

export function listFollows(): { follows: ShareFollowSummary[]; watcher: FollowWatcherStatus } {
  return { follows: listShareFollowSummaries(), watcher: getFollowWatcherStatus() };
}

/* ------------------------------- 检查 ------------------------------- */

const checking = new Set<string>();

/**
 * 正在检查的订阅这一轮已经转存、还没写进快照的条目（相对被盯目录）：一轮好几组时，前一组交给整理的那次可能在这一轮写快照之前
 * 就执行完了，记整理结果（learnFollowOrganized）时要认得出它们。检查结束就清掉
 */
const inFlight = new Map<string, Set<string>>();

export interface CheckResult {
  follow: ShareFollowSummary;
  /** 这次有动静才有；什么都没发生是 null */
  run: ShareFollowRun | null;
  /** 这次的新增交没交给复制队列（任务没开复制、没有新增就不带）：智能体的结果里照实说 */
  copy?: CopyOutcome;
}

/** 检查一条。界面的「立即检查」和循环都走这里；同一条不会并发 */
export async function checkFollow(id: string): Promise<CheckResult> {
  const f = getShareFollow(id);
  if (!f) throw new HttpError(404, "追更订阅不存在");
  if (checking.has(id)) throw new HttpError(409, "正在检查中");
  checking.add(id);
  updateShareFollow(id, { status: "checking" });
  try {
    const sink: CheckSink = {};
    const run = await runCheck(f, sink);
    const latest = getShareFollow(id) ?? f;
    return { follow: toSummary(latest), run, ...(sink.copy ? { copy: sink.copy } : {}) };
  } finally {
    checking.delete(id);
    inFlight.delete(id);
  }
}

type FailKind = "error" | "share";

/** 这轮没能走到对照：记错误、退避；分享接口连续说不行就判失效停掉 */
function settleFailure(f: ShareFollow, error: string, kind: FailKind): ShareFollowRun {
  const now = deps.now();
  const streak = f.errorStreak + 1;
  const run: ShareFollowRun = { at: now, added: [], skipped: [], generated: 0, error };
  const recent = pushRecent(f.recent, run);
  if (kind === "share" && streak >= FOLLOW.EXPIRE_STREAK) {
    updateShareFollow(f.id, { status: "expired", enabled: false, lastError: error, errorStreak: streak, lastCheckedAt: now, recent });
    log.warn(`追更「${f.name}」的分享已失效，停止：${error}`);
    void deps.notify({ type: "follow-expired", id: f.id, name: f.name, reason: error }).catch(() => {});
    return run;
  }
  updateShareFollow(f.id, {
    status: "error",
    lastError: error,
    errorStreak: streak,
    lastCheckedAt: now,
    nextCheckAt: nextCheckAt(f, streak, now),
    recent,
  });
  log.warn(`追更「${f.name}」检查失败（第 ${streak} 次）：${error}`);
  if (streak >= FOLLOW.EXPIRE_STREAK) void deps.notify({ type: "follow-failed", id: f.id, name: f.name, detail: error }).catch(() => {});
  return run;
}

/** 服务端「没更新」信号连续信几次；有更新时的返回还没在真机验证过，信过头就照常列一遍兜底，最坏也就晚这几轮发现 */
const UPDATE_SIGNAL_TRUST = 3;
/** 每个订阅连续凭信号跳过了几轮 */
const signalSkips = new Map<string, number>();

/**
 * 有服务端信号的分享（夸克 inc_update_list）先问一句相对上次转存有没有新增：明确说没有就跳过整棵列目录。
 * 上一轮有转存失败的不问（失败的条目要靠列目录再试）；信号打不通就当不知道，让后面的列目录去报错。
 */
async function serverSaysUnchanged(f: ShareFollow, share: ShareProvider, session: ShareSession, account: string): Promise<boolean> {
  const updates = share.updates;
  if (!updates || f.errorStreak > 0) return false;
  // 信号是「这个账号相对上次转存」的：同一分享在这个账号上还有别的订阅时，上次转存可能是它做的，不信
  if (listShareFollowSummaries().some((o) => o.id !== f.id && o.shareCode === f.shareCode && getTask(o.taskId)?.account === account)) return false;
  const skips = signalSkips.get(f.id) ?? 0;
  if (skips >= UPDATE_SIGNAL_TRUST) return false;
  let signal: ShareUpdateSignal;
  try {
    signal = await updates.check(session);
  } catch {
    return false;
  }
  if (signal !== "none") return false;
  signalSkips.set(f.id, skips + 1);
  return true;
}

/** 这轮没列目录也没变化：只推进时间 */
function settleUnchanged(f: ShareFollow): null {
  const now = deps.now();
  updateShareFollow(f.id, { status: "idle", lastError: "", errorStreak: 0, lastCheckedAt: now, nextCheckAt: nextCheckAt(f, 0, now) });
  log.debug(`追更「${f.name}」服务端说分享没有更新，这轮不列目录`);
  return null;
}

/** runCheck 顺带交回的、不进订阅记录的东西 */
interface CheckSink {
  copy?: CopyOutcome;
}

async function runCheck(f: ShareFollow, sink: CheckSink): Promise<ShareFollowRun | null> {
  let target: Target;
  try {
    target = resolveTask(f.taskId);
  } catch (err) {
    return settleFailure(f, err instanceof HttpError && err.status === 404 ? `同步任务 ${f.taskId} 已不存在` : errMsg(err), "error");
  }
  const { task, provider, share } = target;
  const ref = refOf(f, provider);

  let listing: ScopeListing;
  try {
    const session = await share.open(ref);
    if (await serverSaysUnchanged(f, share, session, task.account)) return settleUnchanged(f);
    listing = await listScope(share, session, f);
    signalSkips.delete(f.id);
  } catch (err) {
    const msg = errMsg(err);
    const issue = provider.classifyError(err);
    // cookie 失效 / 被风控是账号的问题，不该把订阅停掉：走账号告警，普通退避
    if (issue === "auth" || issue === "blocked") {
      void deps
        .notify({ type: "account-alert", account: provider.account.name, reason: msg, source: `追更 ${f.name}`, issue: issueFromDrive(issue) })
        .catch(() => {});
      return settleFailure(f, msg, "error");
    }
    if (issue === "gone") return settleFailure(f, `分享不可用：${msg}`, "share");
    return settleFailure(f, msg, "error");
  }

  const now = deps.now();
  const diff = diffShareListing(f.known, listing.entries);
  const settings: AppSettings = readAppSettings();
  const received: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  /** 每组转存完各自登记的复制（在 saveSelectionToTask 里、生成 strm 之前登记，来源写成「追更」） */
  const copies: CopyOutcome[] = [];
  /** 这一轮为转存建出来的目录：后面的组落在它里面的，交给整理时也交它（前面那组的整理可能已经跑完，留下它这个空壳） */
  const createdInRound: string[] = [];
  let generated = 0;
  for (const group of groupByParent(diff.added)) {
    const subPath = normalizeSubPath(group.parent ? `${f.subPath}/${group.parent}` : f.subPath);
    try {
      // 落点不在了（整理把它挪空删了、被人删了）就一级级建出来：建出来的只装这次的条目，整个交给整理，挪空了跟着删
      const made = await ensureSaveDir(provider, task.originPath, subPath);
      if (made) {
        createdInRound.push(made);
        log.info(`追更「${f.name}」的落点不在了，建了 ${task.originPath}/${made}`);
      }
      const createdDir = createdInRound.find((d) => subPath === d || subPath.startsWith(`${d}/`));
      // 这个目录上次整理成了什么：新文件（不含目录）带着交给整理，照着认、季和集偏移照着套
      const done = f.organized.find((o) => o.dir === group.parent);
      const organizeHints = done ? group.items.filter((i) => !i.isDir).map((i) => hintOf(done, subPath ? `${subPath}/${baseName(i.path)}` : baseName(i.path), f.name)) : [];
      const r = await saveSelectionToTask({
        task,
        provider,
        ref,
        items: group.items.map((i) => ({ id: i.id, name: baseName(i.path), isDir: i.isDir, token: i.token })),
        subPath,
        mode: "sync",
        // 复制按任务上的开关，转存完马上登记：网盘监控随后按文件报上来的，被整条目包着就不再单独登记
        copyTrigger: "follow",
        // 交给整理也在这里（每组转存完、strm 生成好就交），整理记录里记成「追更」
        organizeTrigger: "follow",
        ...(createdDir ? { createdDir } : {}),
        ...(organizeHints.length ? { organizeHints } : {}),
        settings,
      });
      if (r.copy) copies.push(r.copy);
      if ("generatedCount" in r) generated += r.generatedCount;
      received.push(...group.items.map((i) => i.path));
      // 交给整理的那次可能比这一轮写快照还早办完：先记下这一组转存了哪些文件（目录连同里面的）
      const flying = inFlight.get(f.id) ?? new Set<string>();
      for (const i of group.items) {
        if (!i.isDir) flying.add(i.path);
        else for (const e of listing.entries) if (!e.isDir && e.path.startsWith(`${i.path}/`)) flying.add(e.path);
      }
      inFlight.set(f.id, flying);
    } catch (err) {
      // 转存成了、strm 没生成好：复制已经登记了，照样算进去
      const copy = err instanceof HttpError ? (err.extra as { copy?: CopyOutcome } | undefined)?.copy : undefined;
      if (copy) copies.push(copy);
      failed.push(...group.items.map((i) => i.path));
      // 转存本身的错误是网盘那边的原文；落盘（写 strm / 下载附件）的错误给人话和建议
      errors.push(`${group.parent || "."}：${describeFileFailure(err, { relPath: group.parent || "", kind: "strm", provider })}`);
    }
  }

  const skipped = [
    ...diff.replaced.map((e) => `${e.path}：分享里的文件被替换了，网盘里的那份没动`),
    ...diff.moved.map((e) => `${e.path}：改名或搬家，同样的文件已经有了，没有重复转存`),
    ...listing.missingScopes.map((n) => `${n}：范围目录已不在分享里`),
  ];
  const streak = errors.length ? f.errorStreak + 1 : 0;
  const patch: Partial<ShareFollow> = {
    known: mergeKnown(f.known, listing.entries, failed),
    status: errors.length ? "error" : "idle",
    lastError: errors.join("；"),
    errorStreak: streak,
    lastCheckedAt: now,
    nextCheckAt: nextCheckAt(f, streak, now),
  };
  const run: ShareFollowRun | null =
    received.length || skipped.length || errors.length
      ? { at: now, added: received, skipped, generated, ...(errors.length ? { error: errors.join("；") } : {}) }
      : null;
  if (run) patch.recent = pushRecent(f.recent, run);
  if (received.length) patch.lastChangeAt = now;

  // 很久没新东西：自动停下，省得一直打接口；通知一次，用户想继续再手动开
  const lastChange = received.length ? now : (f.lastChangeAt ?? f.createdAt * 1000);
  const stale = !received.length && !errors.length && now - lastChange > STALE_MS;
  if (stale) {
    patch.status = "stale";
    patch.enabled = false;
  }
  updateShareFollow(f.id, patch);

  const target2 = `${task.originPath}${f.subPath ? `/${f.subPath}` : ""}`;
  if (received.length) {
    log.info(`追更「${f.name}」新增 ${received.length} 项 → ${target2}，生成 ${generated} 个 strm`);
    if (generated > 0) scheduleEmbyRefresh();
    void deps.notify({ type: "follow-added", name: f.name, added: received.map(baseName), generated, target: target2 }).catch(() => {});
  }
  const copy = mergeCopyOutcomes(copies);
  if (copy) sink.copy = copy;
  if (errors.length) {
    log.warn(`追更「${f.name}」有条目转存失败：${errors.join("；")}`);
    if (streak >= FOLLOW.EXPIRE_STREAK) void deps.notify({ type: "follow-failed", id: f.id, name: f.name, detail: errors.join("；") }).catch(() => {});
  }
  if (stale) {
    log.info(`追更「${f.name}」${FOLLOW.STALE_DAYS} 天没有更新，自动暂停`);
    void deps.notify({ type: "follow-stale", id: f.id, name: f.name, days: FOLLOW.STALE_DAYS }).catch(() => {});
  }
  return run;
}

/** 追更一轮按目录分组转存、各组各自登记复制：合成一份回给调用方（条数相加，去向取第一组不是「不动」的——同一个任务本来就一样） */
function mergeCopyOutcomes(list: CopyOutcome[]): CopyOutcome | undefined {
  if (list.length === 0) return undefined;
  const queued = list.reduce((n, c) => n + c.queued, 0);
  const reason = queued === 0 ? list.find((c) => c.reason)?.reason : undefined;
  return {
    queued,
    dstDir: list.find((c) => c.dstDir)?.dstDir ?? null,
    ...withAfterCopy(list.find((c) => c.afterCopy !== "keep")?.afterCopy ?? "keep"),
    ...(reason ? { reason } : {}),
  };
}

/* ------------------------------- 循环 ------------------------------- */

let lastTickAt: number | null = null;

const loop = createPollingLoop({
  name: "追更循环",
  log,
  intervalMs: FOLLOW.TICK_MS,
  tick: tickFollows,
  // 订阅全关了就收工；再开一条时 startFollowWatcher 会重新起
  shouldContinue: () => countEnabledShareFollows() > 0,
  doneMessage: "没有开着的追更订阅，循环停止",
});

export function getFollowWatcherStatus(): FollowWatcherStatus {
  return { running: loop.running, lastTickAt, lastError: loop.lastError, checking: [...checking] };
}

/** 有开着的订阅就起循环；已在跑或一条都没开都不动 */
export function startFollowWatcher(): void {
  if (loop.running || countEnabledShareFollows() === 0) return;
  log.info("追更循环启动");
  loop.start();
}

export async function stopFollowWatcher(): Promise<void> {
  await loop.stop();
}

/**
 * 跑一轮：到期的订阅顺序检查。导出为函数是为了测试能直接触发，不用等一分钟。
 * 单条失败不影响其余；正在被手动检查的跳过。
 */
export async function tickFollows(): Promise<void> {
  const due = listDueShareFollows(deps.now());
  for (let i = 0; i < due.length; i++) {
    const f = due[i];
    if (checking.has(f.id)) continue;
    try {
      await checkFollow(f.id);
    } catch (err) {
      log.warn({ err, id: f.id }, "追更检查抛错");
    }
    if (i < due.length - 1 && deps.gapMs > 0) await sleep(deps.gapMs);
  }
  lastTickAt = deps.now();
}

type DirMapping = { from: string; to: string };

/** 路径按目录映射改写：等于或位于某个 from 之下的换成 to（映射按 from 从长到短排好），没命中是 null */
function mapPath(p: string, mappings: DirMapping[]): string | null {
  const m = mappings.find((x) => p === x.from || p.startsWith(`${x.from}/`));
  return m ? (p === m.from ? m.to : `${m.to}${p.slice(m.from.length)}`) : null;
}

/**
 * 整理把任务下的目录挪走后，订阅的落点跟着改：sub_path 等于或位于 from 之下的改成 to；整理结果里记的作品目录 / 视频所在目录也一样。
 * dryRun 只返回会受影响的 subPath（预览里显示「被 N 条追更引用」）。返回改过（或会改）的 subPath 列表
 */
export function rewriteFollowSubPaths(taskId: string, mappings: DirMapping[], dryRun = false): string[] {
  const hit: string[] = [];
  for (const f of listShareFollows()) {
    if (f.taskId !== taskId) continue;
    if (dryRun) {
      if (f.subPath) hit.push(f.subPath);
      continue;
    }
    const patch: Partial<ShareFollow> = {};
    const sub = f.subPath ? mapPath(f.subPath, mappings) : null;
    if (sub !== null) {
      patch.subPath = normalizeSubPath(sub);
      hit.push(f.subPath);
    }
    const organized = f.organized.map((o) => mapOrganized(o, mappings));
    if (organized.some((o, i) => o !== f.organized[i])) patch.organized = organized;
    if (Object.keys(patch).length > 0) updateShareFollow(f.id, patch);
  }
  return hit;
}

/* ------------------------------- 整理结果 ------------------------------- */

const ORGANIZED_TITLES_KEEP = 20;
/** 撤销能往回退几版 */
const ORGANIZED_HISTORY_KEEP = 5;

/** 上一版的链只留这么多层 */
function trimHistory(o: ShareFollowOrganized, depth = 1): ShareFollowOrganized {
  if (!o.prev) return o;
  return { ...o, prev: depth >= ORGANIZED_HISTORY_KEEP ? null : trimHistory(o.prev, depth + 1) };
}

/** 一条记录连同上一版们的目录按映射改写；没变就原样返回 */
function mapOrganized(o: ShareFollowOrganized, mappings: DirMapping[]): ShareFollowOrganized {
  const workDir = mapPath(o.workDir, mappings);
  const filesDir = mapPath(o.filesDir, mappings);
  const prev = o.prev ? mapOrganized(o.prev, mappings) : null;
  return workDir === null && filesDir === null && prev === o.prev ? o : { ...o, workDir: workDir ?? o.workDir, filesDir: filesDir ?? o.filesDir, prev };
}

function hintOf(o: ShareFollowOrganized, path: string, label: string): OrganizeHint {
  return { path, mediaType: o.mediaType, tmdbId: o.tmdbId, season: o.season, episodeOffset: o.episodeOffset, seasonFallback: o.seasonFallback, titles: o.titles, label };
}

/** 都一样才算数，有一个不一样或者一个都没有是 null */
function uniform<T>(values: T[]): T | null {
  return values.length > 0 && values.every((v) => v === values[0]) ? values[0] : null;
}

const dirOf = (p: string): string => parentOf(p);

type OrganizedValues = Omit<ShareFollowOrganized, "dir" | "titles" | "runId" | "prev" | "at">;

const sameValues = (a: OrganizedValues, b: OrganizedValues): boolean =>
  a.tmdbId === b.tmdbId &&
  a.season === b.season &&
  a.seasonFallback === b.seasonFallback &&
  a.episodeOffset === b.episodeOffset &&
  a.workDir === b.workDir &&
  a.filesDir === b.filesDir;

/**
 * 记下 / 改一条：值没变只补片名，不动 runId / prev（追更每来一集就整理一次，不能把「最后一次真改了它的整理」刷掉）；
 * 变了记下这次的 runId，原来那条放进 prev，撤销这次整理就退回去
 */
function upsert(list: ShareFollowOrganized[], dir: string, values: OrganizedValues, titles: string[], runId: string, now: number): boolean {
  const idx = list.findIndex((o) => o.dir === dir);
  const cur = idx === -1 ? null : list[idx];
  const mergedTitles = [...new Set([...(cur?.titles ?? []), ...titles])].slice(0, ORGANIZED_TITLES_KEEP);
  if (cur && sameValues(cur, values)) {
    if (mergedTitles.length === cur.titles.length) return false;
    list[idx] = { ...cur, titles: mergedTitles };
    return true;
  }
  const next = trimHistory({ dir, ...values, titles: mergedTitles, runId, prev: cur, at: now });
  if (idx === -1) list.push(next);
  else list[idx] = next;
  return true;
}

/**
 * 整理执行完：这次挪过 / 改过名的视频里，有追更转存来的，就记下分享里那个目录整理成了什么（只记剧集）。
 *   1. 源路径去掉订阅的 subPath 后在快照里：是这条追更转存来的原样文件，按它在分享里的目录记。同一个目录的进了不同作品就不猜。
 *   2. 动了某条记录里那批视频（filesDir：整理页换匹配、改季、改模板重整）：跟着改——人定了季就换季，集偏移累加（新偏移是在上次结果上再偏的）。
 * 要在改写追更落点之前调：按整理前的路径对快照（这一轮刚转存、还没写进快照的也算）。返回改了几条订阅
 */
export function learnFollowOrganized(taskId: string, runId: string, videos: OrganizedVideo[]): number {
  if (videos.length === 0) return 0;
  const now = deps.now();
  let touched = 0;
  for (const f of listShareFollows()) {
    if (f.taskId !== taskId) continue;
    const base = f.subPath ? `${f.subPath}/` : "";
    const known = new Set([...f.known.filter((e) => !e.isDir).map((e) => e.path), ...(inFlight.get(f.id) ?? [])]);
    const byDir = new Map<string, OrganizedVideo[]>();
    const raw = new Set<OrganizedVideo>();
    for (const v of videos) {
      if (!v.src.startsWith(base)) continue;
      const rel = v.src.slice(base.length);
      if (!known.has(rel)) continue;
      const dir = parentOf(rel);
      byDir.set(dir, [...(byDir.get(dir) ?? []), v]);
      raw.add(v);
    }
    const list = [...f.organized];
    let changed = false;
    for (const [dir, vs] of byDir) {
      const u = vs[0].unit;
      if (u.mediaType !== "tv" || vs.some((v) => v.unit.tmdbId !== u.tmdbId || v.unit.mediaType !== u.mediaType)) continue;
      const values: OrganizedValues = {
        mediaType: "tv",
        tmdbId: u.tmdbId,
        title: u.title,
        year: u.year,
        season: u.seasonOverride,
        seasonFallback: u.seasonOverride === null ? uniform(vs.map((v) => v.season)) : null,
        episodeOffset: u.episodeOffset,
        workDir: u.dstRoot,
        filesDir: uniform(vs.map((v) => dirOf(v.dst))) ?? u.dstRoot,
      };
      changed = upsert(list, dir, values, vs.flatMap((v) => v.titles), runId, now) || changed;
    }
    for (const cur of [...list]) {
      if (byDir.has(cur.dir)) continue;
      // 这条追更这次刚送来的原样文件不算（上面按分享里的目录记过了），只看原来就整理好、这次又被挪的
      const vs = videos.filter((v) => !raw.has(v) && dirOf(v.src) === cur.filesDir);
      if (vs.length === 0) continue;
      const u = vs[0].unit;
      if (u.mediaType !== "tv" || vs.some((v) => v.unit.tmdbId !== u.tmdbId || v.unit.mediaType !== u.mediaType)) continue;
      const values: OrganizedValues = {
        mediaType: "tv",
        tmdbId: u.tmdbId,
        title: u.title,
        year: u.year,
        season: u.seasonOverride ?? cur.season,
        seasonFallback: u.seasonOverride !== null ? null : (uniform(vs.map((v) => v.season)) ?? cur.seasonFallback),
        episodeOffset: cur.episodeOffset + u.episodeOffset,
        workDir: u.dstRoot,
        filesDir: uniform(vs.map((v) => dirOf(v.dst))) ?? u.dstRoot,
      };
      changed = upsert(list, cur.dir, values, [], runId, now) || changed;
    }
    if (changed) {
      updateShareFollow(f.id, { organized: list });
      touched++;
    }
  }
  if (touched > 0) log.info({ taskId, runId, follows: touched }, "追更记下了整理结果");
  return touched;
}

/** 撤销一次整理：这次记下 / 改过的整理结果退回上一版（没有上一版就删掉） */
export function revertFollowOrganized(taskId: string, runId: string): number {
  let touched = 0;
  for (const f of listShareFollows()) {
    if (f.taskId !== taskId || !f.organized.some((o) => o.runId === runId)) continue;
    const list = f.organized.flatMap((o) => (o.runId !== runId ? [o] : o.prev ? [o.prev] : []));
    updateShareFollow(f.id, { organized: list });
    touched++;
  }
  return touched;
}

/** 仅供测试：清掉所有订阅并停循环 */
export async function __test_resetFollows(): Promise<void> {
  await stopFollowWatcher();
  replaceShareFollows([]);
  checking.clear();
  inFlight.clear();
  signalSkips.clear();
  lastTickAt = null;
  loop.noteError(null);
}
