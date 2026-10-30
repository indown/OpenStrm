/**
 * 云下载的编排层，路由只调这里。
 *
 *   - 加任务：目标要么是任意 115 目录 id，要么是「同步任务的 originPath（+ 子目录）」——
 *     后者按路径解析成目录 id，并按需登记一条回执：115 下完之后为产物生成 strm。
 *   - 回执上还能带一个复制目标（copyDstDir）：115 下完之后，把产物的网盘路径交给
 *     复制队列（services/copy），由它让 OpenList 把产物复制到目标目录（如本地磁盘）。
 *     没有同步任务时（下到 115 默认目录或任意目录）回执的 kind 就是 "openlist-copy"，只做这一件事。
 *   - 回执落在 settings 表的 `offline.followups` 键里，进程重启不丢。
 *   - 一个后台循环盯着有回执的账号：每 30 秒翻一遍 115 的任务列表，
 *     完成 → 生成 strm（目录用 115 给的产物 id 直接导出目录树，不按名字猜）
 *            并把要复制的交给复制队列；
 *     失败 → 记下 115 的说法；列表里连续几轮找不到 → 当作被人删了。
 *     没有待办时循环自己停掉，不白打接口。
 */
import type { Account115, AccountInfo as SharedAccountInfo, AppSettings, CopyAfterCopy, TaskDefinition } from "@openstrm/shared";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { getTask } from "../../db/repositories/tasks.js";
import { readAppSettings, updateAppSetting } from "../../db/repositories/settings.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { messageOf } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { createPollingLoop } from "../../lib/polling.js";
import { Cloud115Error, fsDirGetId, type AccountInfo } from "../cloud-115/client.js";
import { joinPanPath, resolveDirPath } from "../cloud-115/path-resolver.js";
import {
  MAX_URLS_PER_ADD,
  normalizeOfflineUrls,
  offlineAddUrls,
  offlineClear,
  offlineDownPaths,
  offlineList,
  offlineRemove,
  offlineRestart,
  type OfflineAddResult,
  type OfflineClearFlag,
  type OfflineDownPath,
  type OfflineListPage,
  type OfflineTask,
} from "../cloud-115/offline.js";
import { enqueueCopy, type CopyEnqueueResult, type CopyRequest } from "../copy/service.js";
import { copyDstProblem, copyOptionsFor, normDir, relativeTo, resolveCopyConfig } from "../copy/paths.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { events } from "../events.js";
import { effectiveAutoMode } from "../organize/auto.js";
import { normalizeSubPath } from "../strm/naming.js";
import { generateStrmForSelected, type GenerateResult, type SelectedItem } from "../strm/share-strm.js";
import { providerFor } from "../drive/registry.js";
import { notify, type NotifyEvent } from "../notify.js";
import { describeFileFailure } from "../download/failure.js";

const log = moduleLogger("offline");

/* ------------------------------- 回执 ------------------------------- */

export type OfflineFollowupStatus = "pending" | "done" | "failed";

/**
 * strm=下载完成后生成 strm；openlist-copy=下载完成后只让 OpenList 复制走（没有同步任务的那种）。
 * 两种都可以带 copyDstDir：115 一下完就把产物交给复制队列（services/copy）
 */
export type OfflineFollowupKind = "strm" | "openlist-copy";

export interface OfflineFollowup {
  /** 存量记录没有这个字段，按 strm 算（见 kindOf） */
  kind?: OfflineFollowupKind;
  infoHash: string;
  account: string;
  /** strm 回执指向的同步任务；openlist-copy 回执是空串 */
  taskId: string;
  /** 相对 task.originPath 的子目录，已 normalize；空串表示就在 originPath 下 */
  subPath: string;
  /** 只用于展示：加任务时 115 回的名字，之后用列表里的名字刷新 */
  name: string;
  /** ms */
  addedAt: number;
  status: OfflineFollowupStatus;
  detail: string;
  doneAt?: number;
  /** 生成 strm 的尝试次数 */
  attempts: number;
  /** 连续几轮没在 115 的任务列表里找到 */
  misses: number;
  /** 下完之后把产物交给复制队列，复制到这个 OpenList 目录；不填就不复制 */
  copyDstDir?: string;
  /**
   * 复制成功后源文件的去向：加任务那一刻按任务设置冻结（同转存 / 追更在登记时冻结），下完之前改设置不影响它。
   * 存量回执没有这个字段（更老的只有 copyDeleteSource），下完时按任务现在的设置算
   */
  copyAfterCopy?: CopyAfterCopy;
  /** 旧字段，等于 copyAfterCopy: "delete" */
  copyDeleteSource?: boolean;
}

const kindOf = (f: OfflineFollowup): OfflineFollowupKind => f.kind ?? "strm";

const FOLLOWUP_KEY = KEY.offlineFollowups;
/** 已完成/失败的回执留 7 天给界面看，之后清掉 */
const KEEP_FINISHED_MS = 7 * 24 * 3600_000;
const MAX_RECORDS = 300;
/** 等了这么久还没下完就不再跟踪：115 自己也会把长期不动的任务判失败 */
const PENDING_MAX_AGE_MS = 7 * 24 * 3600_000;
const POLL_MS = 30_000;
/** 回执只会在最近加的任务里，翻到第 5 页还没有就下轮再说 */
const MAX_PAGES = 5;
const MAX_ATTEMPTS = 3;
const MAX_MISSES = 3;

export function listFollowups(): OfflineFollowup[] {
  const rows = readKv<OfflineFollowup[]>(FOLLOWUP_KEY);
  return Array.isArray(rows) ? rows : [];
}

/**
 * 整份写回。只给读—改—写之间没有 await 的调用方（登记、删除、重试、整理改落点）用：
 * 推进循环中间夹着网络等待，这期间别处随时会改同一个键，循环里一律走 commitFollowups
 */
function saveFollowups(rows: OfflineFollowup[]): void {
  const now = Date.now();
  const kept = rows
    .filter((f) => f.status === "pending" || now - (f.doneAt ?? f.addedAt) < KEEP_FINISHED_MS)
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, MAX_RECORDS);
  writeKv(FOLLOWUP_KEY, kept);
}

/** 回执的身份：同一个账号、同一个 info hash 只有一条（addFollowups 按它去重） */
const keyOf = (f: Pick<OfflineFollowup, "account" | "infoHash">): string => JSON.stringify([f.account, f.infoHash]);

/**
 * 推进循环这一轮手里的待办（按身份）。循环中间夹着网络等待，这期间整理改写落点要同时改到这些对象上：
 * 这一轮收尾是按身份把手里的对象写回去的，只改库里那份会被盖掉（同 copy/queue.ts 的 mirrorLive）。
 * 一轮开始时登记、结束时清空
 */
const liveFollowups = new Map<string, OfflineFollowup>();

/**
 * 把这一轮改过的回执合并回库：重读一份、按身份覆盖。期间别处新登记的照旧留着，删掉的不复活；
 * 同一个磁力被重新登记过的（用户删了任务又加了一遍，addedAt 变了）按新登记的算，这一轮对旧任务的结论不盖上去。
 * 读—改—写之间没有 await，对别的 JS 代码是原子的（同 copy/queue.ts 的 commitCopies）
 */
function commitFollowups(changed: OfflineFollowup[]): void {
  if (changed.length === 0) return;
  const byKey = new Map(listFollowups().map((f) => [keyOf(f), f]));
  let touched = false;
  for (const f of changed) {
    const current = byKey.get(keyOf(f));
    if (!current || current.addedAt !== f.addedAt) continue;
    byKey.set(keyOf(f), f);
    touched = true;
  }
  if (touched) saveFollowups([...byKey.values()]);
}

function addFollowups(items: OfflineFollowup[]): void {
  const rows = listFollowups().filter((f) => !items.some((i) => i.infoHash === f.infoHash && i.account === f.account));
  saveFollowups([...items, ...rows]);
}

/** 撤掉这些任务的回执（不管兑现没兑现），回撤了几条 */
function dropFollowups(account: string, infoHashes: string[]): number {
  const drop = new Set(infoHashes);
  const rows = listFollowups();
  const kept = rows.filter((f) => !(f.account === account && drop.has(f.infoHash)));
  if (kept.length !== rows.length) saveFollowups(kept);
  return rows.length - kept.length;
}

const hasPending = (): boolean => listFollowups().some((f) => f.status === "pending");

/* ------------------------------- 依赖注入 ------------------------------- */

export interface GenerateParams {
  task: TaskDefinition;
  accountInfo: AccountInfo;
  settings: AppSettings;
  subPath: string;
  item: SelectedItem;
}

interface Deps {
  list: (accountInfo: AccountInfo, page: number) => Promise<OfflineListPage>;
  /** 把 115 路径解析成目录 id；找不到抛 HttpError */
  resolveDirId: (accountInfo: AccountInfo, path: string) => Promise<string>;
  generate: (p: GenerateParams) => Promise<GenerateResult>;
  notify: (event: NotifyEvent) => Promise<unknown>;
  /** 115 下完之后把产物交给复制队列；返回真排上了几条 */
  enqueueCopy: (req: CopyRequest) => CopyEnqueueResult;
  /** 目标目录 id → 网盘绝对路径（交给复制队列时要算落点） */
  resolveDirPath: (accountInfo: AccountInfo, cid: string) => Promise<string | null>;
}

async function resolveDirIdReal(accountInfo: AccountInfo, dirPath: string): Promise<string> {
  let res: { id?: number | string } | undefined;
  try {
    res = await fsDirGetId(dirPath, { accountInfo });
  } catch (err) {
    throw upstream(err, `解析目录失败：${dirPath}`);
  }
  // getid 对不存在的路径回 id=0；0 是根目录，不能把东西下到那里去
  if (res?.id == null || String(res.id) === "" || String(res.id) === "0") {
    throw new HttpError(400, `无法在 115 上找到目录：${dirPath}`);
  }
  return String(res.id);
}

const realDeps: Deps = {
  list: (accountInfo, page) => offlineList(accountInfo, page),
  resolveDirId: resolveDirIdReal,
  generate: ({ task, accountInfo, settings, subPath, item }) =>
    generateStrmForSelected({
      task,
      provider: providerFor({ accountType: "115", name: accountInfo.name, cookie: accountInfo.cookie }),
      selectedItems: [item],
      settings,
      subPath,
    }),
  notify,
  enqueueCopy,
  resolveDirPath,
};

let deps: Deps = { ...realDeps };

/** 仅供测试：换掉会碰网络 / 磁盘的几步；传 null 恢复 */
export function setOfflineServiceDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 账号与错误 ------------------------------- */

/** 云下载只能下到 115 账号的任务目录：按 task.account 从已读取的 accounts 里挑对应 115 账号 */
export function resolveTaskAccount115(accounts: SharedAccountInfo[], task: TaskDefinition): Account115 {
  const accountInfo = accounts.find((a) => a.name === task.account);
  if (!accountInfo) throw new HttpError(400, `Task ${task.id} 绑定的账号 ${task.account} 不存在`);
  if (accountInfo.accountType !== "115") throw new HttpError(400, `Task ${task.id} 绑定的账号 ${task.account} 不是 115 账号`);
  return accountInfo;
}

/** 指定了名字就要那一个；没指定取第一个 115 账号 */
export function resolveAccount115(name?: string): Account115 {
  const accounts = listAccounts();
  const acc = name ? accounts.find((a) => a.name === name) : accounts.find((a) => a.accountType === "115");
  if (!acc) throw new HttpError(name ? 404 : 400, name ? `115 account not found: ${name}` : "No 115 account configured");
  if (acc.accountType !== "115") throw new HttpError(400, `${acc.name} 不是 115 账号`);
  if (!acc.cookie) throw new HttpError(400, "115 account cookie is required");
  return acc;
}

/** 115 的失败要原样说出来：cookie 失效、风控 405 和"列表本来就是空的"在界面上不能长一样 */
function upstream(err: unknown, fallback: string): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof Cloud115Error) return upstreamError(err.message, { upstreamStatus: err.status }, err);
  return upstreamError(err instanceof Error && err.message ? err.message : fallback, {}, err);
}


/* ------------------------------- 路由用的动作 ------------------------------- */

export interface AddOfflineOptions {
  account?: string;
  urls: string | string[];
  /** 直接指定 115 目录；不传也不给 taskId 时用 115 自己的默认目录 */
  dirId?: string | number;
  /** 指定同步任务（+ 子目录），目录按 task.originPath 解析；账号跟任务走 */
  taskId?: string;
  subPath?: string;
  /** 任务目录模式下，下载完成后是否自动生成 strm，默认开 */
  generateStrm?: boolean;
  /** 下载完成后让 OpenList 把产物复制到目标目录（下到哪个目录都行，按账号的挂载根换算） */
  copyToOpenlist?: boolean;
  /** 这次复制到哪（OpenList 完整路径）；不给就用设置页的 dstDir。目录在加任务时冻结进回执 */
  copyDstDir?: string;
}

export interface AddOfflineResponse {
  account: string;
  dirId: string | null;
  /** 任务目录模式下解析用的路径，给界面回显 */
  dirPath: string | null;
  added: number;
  failed: number;
  /** 115 不认的链接（thunder:// 之类），没有提交 */
  invalid: string[];
  results: OfflineAddResult[];
  /** 是否登记了回执（完成后生成 strm，或复制到 OpenList） */
  followup: boolean;
  /** 其中有没有「下完生成 strm」的回执（只复制的那种不生成 strm） */
  strmFollowup: boolean;
  /** 下完复制到 OpenList 的哪个目录；这次不复制（或一条回执都没登记上）是 null */
  copyDstDir: string | null;
  /** 复制成功后源文件的去向（冻结在回执上的那个；115 上原本就有、不在任务目录里的一律不动） */
  copyAfterCopy: CopyAfterCopy;
  /** 任务开着复制、这次却复制不了的原因（设置没配好、OpenList 账号不可用）；能复制或本来就不复制是 null */
  copyBlocked: string | null;
}

export async function addOfflineTasks(opts: AddOfflineOptions): Promise<AddOfflineResponse> {
  const { urls, invalid } = normalizeOfflineUrls(opts.urls);
  if (urls.length === 0) {
    throw new HttpError(
      400,
      invalid.length ? `没有可提交的链接：115 只收磁力、ed2k、http(s)、ftp，「${invalid[0]}」不在其中` : "urls is required",
      { invalid },
    );
  }
  if (urls.length > MAX_URLS_PER_ADD) throw new HttpError(400, `一次最多提交 ${MAX_URLS_PER_ADD} 条链接`);

  let account: Account115;
  let task: TaskDefinition | null = null;
  let dirId: string | null = null;
  let dirPath: string | null = null;
  const subPath = normalizeSubPath(opts.subPath);

  if (opts.taskId) {
    task = getTask(opts.taskId);
    if (!task) throw new HttpError(404, `Task not found: ${opts.taskId}`);
    account = resolveTaskAccount115(listAccounts(), task);
    dirPath = subPath ? `${task.originPath}/${subPath}` : task.originPath;
    dirId = await deps.resolveDirId(account, dirPath);
  } else {
    account = resolveAccount115(opts.account);
    // "0" 是根目录，合法；空串才是"没选，用 115 的默认目录"
    if (opts.dirId != null && String(opts.dirId).trim() !== "") dirId = String(opts.dirId).trim();
  }

  /**
   * 要不要复制：弹框里明确勾了就按它；没说就看任务上的开关
   * （「转存 / 追更 / 云下载 / 监控落下新文件就复制」是同一个开关，云下载不能漏）。
   * 用户明确勾了却复制不了，当场说清楚，别等下完了才发现；没明说、只是任务开着的，复制不了就记一笔、照常下载。
   */
  const settings = readAppSettings();
  const forced = opts.copyToOpenlist;
  const pickedDst = normDir(opts.copyDstDir);
  const copyOpts = copyOptionsFor(task, forced, settings, pickedDst);
  let copyDst = "";
  let copyBlocked: string | null = null;
  if (forced && !copyOpts.enabled) {
    const cfg = resolveCopyConfig(settings);
    if (!cfg.mounts[account.name]) {
      throw new HttpError(400, `账号 ${account.name} 还没填「在 OpenList 里的挂载根」，先到设置页的「复制到 OpenList」里填上`);
    }
    // 配置齐了却还是 false：没有任务（copyOptionsFor 认任务），或者任务上、设置页、这次都没给目标目录
    copyDst = pickedDst || cfg.dstDir;
    if (!copyDst) throw new HttpError(400, "没有复制目标目录：任务上和设置页的「复制到 OpenList」都没填");
  } else if (copyOpts.enabled) {
    // copyOptionsFor 只看设置上填没填，OpenList 账号本身（被删了、缺密码）到这里才核对：
    // 不核对的话回执照登、下完才发现排不进复制队列
    try {
      const cfg = resolveCopyConfig(settings);
      copyDst = normDir(copyOpts.dstDir) || cfg.dstDir;
    } catch (err) {
      if (forced) throw err;
      copyDst = "";
      copyBlocked = messageOf(err);
    }
  } else if (copyOpts.blocked) {
    copyBlocked = copyOpts.blocked;
  }
  if (copyBlocked && task) log.info(`任务 ${task.originPath} 开着复制到 OpenList，但${copyBlocked}，这次云下载的不复制`);
  // 这次指定的目标只能在任务上、设置页的目标目录下面：界面和 Telegram 都是从那儿往下选的
  if (copyDst && pickedDst) {
    const why = copyDstProblem(pickedDst, task, settings);
    if (why) throw new HttpError(400, why);
  }
  // 源文件的去向在这一刻按任务的设置冻结（明说要复制、任务却没开的不动）
  const copyAfterCopy: CopyAfterCopy = copyDst ? copyOptionsFor(task, undefined, settings, pickedDst).afterCopy : "keep";

  let results: OfflineAddResult[];
  try {
    results = await offlineAddUrls(account, urls, { dirId: dirId ?? undefined });
  } catch (err) {
    throw upstream(err, "添加云下载任务失败");
  }

  const ok = results.filter((r) => r.ok && r.infoHash);
  /**
   * 「任务已存在」也带 info_hash：任务真实存在，往往正在下甚至已经下完（测试时反复
   * 提交同一个磁力必然踩中）。复制回执照登，让循环把它接管；strm 回执不跟——
   * 已存在的任务可能压根不在这个任务目录里，按任务前缀生成的 strm 会指向不存在的路径。
   */
  const dup = results.filter((r) => !r.ok && r.infoHash && /已存在|errno=10008/.test(r.message ?? ""));
  const now = Date.now();
  const strmFollowup = Boolean(task) && opts.generateStrm !== false && ok.length > 0;
  if (strmFollowup && task) {
    addFollowups(
      ok.map((r) => ({
        infoHash: r.infoHash!,
        account: account.name,
        taskId: task.id,
        subPath,
        name: r.name || r.url,
        addedAt: now,
        status: "pending" as const,
        detail: "等待 115 下载完成",
        attempts: 0,
        misses: 0,
        // 下到任务目录又要复制走：同一条回执兼办，生成 strm 之后再交给复制队列
        ...(copyDst ? { copyDstDir: copyDst, copyAfterCopy } : {}),
      })),
    );
    startOfflineWatcher();
  }
  // 只复制不生成 strm 的（下到默认目录 / 任意目录，或任务目录但关了 strm）单独记一条回执。
  // 有任务就把 taskId / subPath 一起记上：复制的落点要按任务目录的层级摆，整理挪目录时也要认得出来。
  // 115 上原本就有的（「任务已存在」）不跟 strm 回执，但要复制的照样记一条只复制的：同一批里有新有旧时不能漏掉旧的
  const copyTargets = strmFollowup ? dup : [...ok, ...dup];
  const copyFollowup = Boolean(copyDst) && copyTargets.length > 0;
  if (copyFollowup) {
    addFollowups(
      copyTargets.map((r) => ({
        kind: "openlist-copy" as const,
        infoHash: r.infoHash!,
        account: account.name,
        taskId: task?.id ?? "",
        subPath: task ? subPath : "",
        name: r.name || r.url,
        addedAt: now,
        status: "pending" as const,
        detail: "等待 115 下载完成",
        attempts: 0,
        misses: 0,
        copyDstDir: copyDst,
        copyAfterCopy,
      })),
    );
    startOfflineWatcher();
  }
  const followup = strmFollowup || copyFollowup;
  log.info(`账号 ${account.name} 添加云下载 ${ok.length}/${urls.length} 条${dirPath ? `，目录 ${dirPath}` : ""}`);
  return {
    account: account.name,
    dirId,
    dirPath,
    added: ok.length,
    failed: results.length - ok.length,
    invalid,
    results,
    followup,
    strmFollowup,
    // 生成 strm 的回执兼办复制时也带着 copyDstDir，所以两种回执登记上了哪一种都算
    copyDstDir: followup && copyDst ? copyDst : null,
    copyAfterCopy: followup && copyDst ? copyAfterCopy : "keep",
    copyBlocked,
  };
}

export interface OfflineWatcherStatus {
  running: boolean;
  pending: number;
  lastTickAt: number | null;
  lastError: string | null;
}

export type ListOfflineResponse = OfflineListPage & {
  account: string;
  /** 这个账号的回执（含最近完成/失败的） */
  followups: OfflineFollowup[];
  watcher: OfflineWatcherStatus;
};

export async function listOfflineTasks(accountName: string | undefined, page = 1): Promise<ListOfflineResponse> {
  const account = resolveAccount115(accountName);
  let res: OfflineListPage;
  try {
    res = await deps.list(account, page);
  } catch (err) {
    throw upstream(err, "读取云下载列表失败");
  }
  return {
    account: account.name,
    ...res,
    followups: listFollowups().filter((f) => f.account === account.name),
    watcher: getOfflineWatcherStatus(),
  };
}

/**
 * 从 115 的云下载列表里删掉任务（正在下的就停下）；deleteFiles 连下载到网盘里的文件一起删。
 * 这些任务的回执一并撤掉，回撤了几条：智能体要告诉用户「下完生成 strm / 复制」也跟着没了
 */
export async function removeOfflineTasks(
  accountName: string | undefined,
  infoHashes: string[],
  deleteFiles: boolean,
): Promise<{ account: string; removed: number; followupsDropped: number }> {
  const account = resolveAccount115(accountName);
  try {
    await offlineRemove(account, infoHashes, deleteFiles);
  } catch (err) {
    throw upstream(err, "删除云下载任务失败");
  }
  const followupsDropped = dropFollowups(account.name, infoHashes);
  return { account: account.name, removed: infoHashes.length, followupsDropped };
}

export async function clearOfflineTasks(accountName: string | undefined, flag: OfflineClearFlag): Promise<void> {
  const account = resolveAccount115(accountName);
  try {
    await offlineClear(account, flag);
  } catch (err) {
    throw upstream(err, "清空云下载列表失败");
  }
  // 清的是哪些任务 115 不会说；已经兑现的回执留着给界面看，没兑现的由循环按"列表里找不到"收掉
}

export async function restartOfflineTask(accountName: string | undefined, infoHash: string): Promise<void> {
  const account = resolveAccount115(accountName);
  try {
    await offlineRestart(account, infoHash);
  } catch (err) {
    throw upstream(err, "重试云下载任务失败");
  }
  // 之前因为 115 下载失败而作废的回执，重试后重新盯；复制回执连提交记录一起清，从头走
  const rows = listFollowups();
  const hit = rows.find((f) => f.account === account.name && f.infoHash === infoHash && f.status === "failed");
  if (hit) {
    Object.assign(hit, {
      status: "pending",
      detail: "已重试，等待 115 下载完成",
      attempts: 0,
      misses: 0,
      doneAt: undefined,
      copyWaits: undefined,
      copyTaskId: undefined,
      copySubmittedAt: undefined,
    });
    saveFollowups(rows);
    startOfflineWatcher();
  }
}

export async function getOfflineDownPaths(accountName: string | undefined): Promise<OfflineDownPath[]> {
  const account = resolveAccount115(accountName);
  try {
    return await offlineDownPaths(account);
  } catch (err) {
    throw upstream(err, "读取默认下载目录失败");
  }
}

/* ------------------------------- 回执循环 ------------------------------- */

let lastTickAt: number | null = null;

const loop = createPollingLoop({
  name: "云下载回执循环",
  log,
  intervalMs: POLL_MS,
  tick: tickFollowups,
  // 待办全兑现了就收工，不白打 115 的接口；再有新任务时 startOfflineWatcher 会重新起
  shouldContinue: hasPending,
  doneMessage: "云下载回执已全部兑现，循环停止",
});

export function getOfflineWatcherStatus(): OfflineWatcherStatus {
  return {
    running: loop.running,
    pending: listFollowups().filter((f) => f.status === "pending").length,
    lastTickAt,
    lastError: loop.lastError,
  };
}

/** 有待办就起循环；已在跑或没待办都不动 */
export function startOfflineWatcher(): void {
  if (loop.running || !hasPending()) return;
  log.info("云下载回执循环启动");
  loop.start();
}

export async function stopOfflineWatcher(): Promise<void> {
  await loop.stop();
}

function finish(f: OfflineFollowup, status: "done" | "failed", detail: string): void {
  f.status = status;
  f.detail = detail;
  f.doneAt = Date.now();
  if (status === "failed") {
    const event: NotifyEvent =
      kindOf(f) === "openlist-copy"
        ? { type: "offline-copy-failed", name: f.name, detail }
        : { type: "offline-failed", name: f.name, detail };
    void deps.notify(event).catch(() => {});
  }
}

/**
 * 跑一轮：翻每个有待办的账号的任务列表，把待办逐条对上号处理。
 * 导出为函数是为了测试能直接触发，不用等 30 秒。
 */
export async function tickFollowups(): Promise<void> {
  const pending = listFollowups().filter((f) => f.status === "pending");
  if (pending.length === 0) return;
  for (const f of pending) liveFollowups.set(keyOf(f), f);

  const byAccount = new Map<string, OfflineFollowup[]>();
  for (const f of pending) byAccount.set(f.account, [...(byAccount.get(f.account) ?? []), f]);

  try {
    for (const [accountName, items] of byAccount) {
      // 这个账号改过、还没写回库的；写一次清一次，一条只写一次：写回之后别处的重试、改落点才不会被这一轮再盖一遍
      const changed: OfflineFollowup[] = [];
      const flush = () => commitFollowups(changed.splice(0));

      const accountInfo = getAccount(accountName);
      if (!accountInfo || accountInfo.accountType !== "115" || !accountInfo.cookie) {
        for (const f of items) {
          finish(f, "failed", `账号 ${accountName} 不存在、不是 115 账号或没有 cookie`);
          changed.push(f);
        }
        flush();
        continue;
      }

      const want = new Set(items.map((i) => i.infoHash));
      const found = new Map<string, OfflineTask>();
      try {
        for (let page = 1; page <= MAX_PAGES && found.size < want.size; page++) {
          const res = await deps.list(accountInfo, page);
          for (const t of res.tasks) if (want.has(t.infoHash)) found.set(t.infoHash, t);
          if (res.tasks.length === 0 || page >= res.pageCount) break;
        }
      } catch (err) {
        // 这一轮列表拿不到（风控、断网）：什么都不改，下轮再来。
        // 记在循环状态里而不是抛出去：其余账号还要接着对，整轮不算失败
        loop.noteError(messageOf(err));
        log.warn({ err }, `读取账号 ${accountName} 的云下载列表失败，回执下轮再对`);
        continue;
      }

      for (const f of items) {
        // 下面每条路都会改到 f（至少 misses / detail），先记上
        changed.push(f);
        const t = found.get(f.infoHash);
        if (!t) {
          f.misses += 1;
          if (f.misses >= MAX_MISSES) finish(f, "failed", "任务已不在 115 的云下载列表里");
          else f.detail = `列表里暂时没找到这条任务（${f.misses}/${MAX_MISSES}）`;
          continue;
        }
        f.misses = 0;
        if (t.name) f.name = t.name;
        if (t.state === "failed") {
          finish(f, "failed", `115 下载失败：${t.statusText}`);
          continue;
        }
        if (t.state !== "done") {
          f.detail = t.state === "downloading" ? `115 下载中 ${t.percent}%` : t.statusText;
          if (Date.now() - f.addedAt > PENDING_MAX_AGE_MS) finish(f, "failed", "等了 7 天还没下完，不再跟踪");
          continue;
        }
        if (kindOf(f) === "openlist-copy") await handoffCopy(f, t, accountInfo);
        else await completeFollowup(f, t, accountInfo);
        // 生成 strm / 交给复制队列是长活儿：办完一条落一次，进程中途没了也不重做
        flush();
      }
      flush();
    }
    lastTickAt = Date.now();
  } finally {
    liveFollowups.clear();
  }
}

async function completeFollowup(f: OfflineFollowup, t: OfflineTask, accountInfo: AccountInfo): Promise<void> {
  const task = getTask(f.taskId);
  if (!task) {
    finish(f, "failed", `同步任务 ${f.taskId} 已不存在，无法生成 strm`);
    return;
  }
  f.attempts += 1;
  const item: SelectedItem = { name: t.resultName || t.name, isDir: t.isDir, id: t.isDir && t.resultId ? String(t.resultId) : undefined };
  try {
    const r = await deps.generate({ task, accountInfo, settings: readAppSettings(), subPath: f.subPath, item });
    const invalid = r.invalidNames.length > 0 ? `，${r.invalidNames.length} 个名字不合法没生成` : "";
    finish(f, "done", `已生成 ${r.generatedCount} 个 strm（跳过 ${r.skippedCount} 个${invalid}）`);
    log.info(`云下载完成：${t.name} → ${f.detail}`);
    if (r.generatedCount > 0) scheduleEmbyRefresh();
    events.emit("files.landed", { task, paths: [f.subPath ? `${f.subPath}/${item.name}` : item.name], trigger: "offline" });
    if (f.copyDstDir) {
      const dir = `${task.originPath}${f.subPath ? `/${f.subPath}` : ""}`;
      const queued = deps.enqueueCopy({
        account: accountInfo.name,
        sources: [{ path: `${dir}/${item.name}`, isDir: t.isDir, nodeId: t.resultId ? String(t.resultId) : undefined }],
        rootPath: task.originPath,
        taskId: task.id,
        dstDir: f.copyDstDir,
        // 加任务那一刻冻结的；存量回执没有，按任务现在的设置
        afterCopy: followupAfterCopy(f, task),
        trigger: "offline",
        holdForOrganize: effectiveAutoMode(task) === "auto",
      });
      // 没排上（设置被改坏了、OpenList 账号没了）要写进回执和通知：不然回执显示「已生成」，复制悄悄就没了
      if (queued.queued === 0 && !queued.duplicates) f.detail += `；没能交给复制队列：${queued.skipped ?? "没有可排的条目"}`;
    }
    void deps
      .notify({ type: "offline-done", name: t.name, detail: f.detail, target: `${task.originPath}${f.subPath ? `/${f.subPath}` : ""}` })
      .catch(() => {});
  } catch (err) {
    const msg = describeFileFailure(err, { relPath: f.subPath ? `${f.subPath}/${f.name}` : f.name, kind: "strm" });
    if (f.attempts >= MAX_ATTEMPTS) finish(f, "failed", `生成 strm 失败：${msg}`);
    else f.detail = `生成 strm 失败，稍后重试（${f.attempts}/${MAX_ATTEMPTS}）：${msg}`;
    log.warn({ err }, `云下载 ${t.name} 生成 strm 失败（第 ${f.attempts} 次）`);
  }
}

/**
 * 升级：老配置只有 srcDir（「115 默认下载目录在 OpenList 里的完整路径」），没有挂载根。
 * 查一次 115 的默认下载目录、把它的 id 解析成网盘绝对路径，从 srcDir 尾巴上剥掉，剩下的就是挂载根。
 *
 * 幂等：已经有 mounts 了就不动（绝不覆盖用户自己填的）。推不出来也不删 srcDir——
 * 与其让功能静默变哑，不如留着老字段，设置页会提示用户自己填一下。
 */
export async function migrateLegacyCopyMount(): Promise<void> {
  const cfg = readAppSettings().openlistCopy;
  if (!cfg?.srcDir || Object.keys(cfg.mounts ?? {}).length > 0) return;
  const srcDir = normDir(cfg.srcDir);
  // 老功能只认「第一个 115 账号」，但库里可能不止一个；挨个试，谁的默认下载目录对得上就是谁
  const candidates = listAccounts().filter((a): a is Account115 => a.accountType === "115" && Boolean(a.cookie));
  for (const account of candidates) {
    let root: string | null = null;
    try {
      const dirs = await offlineDownPaths(account);
      const picked = dirs.find((d) => d.selected) ?? dirs[0];
      const abs = picked ? await deps.resolveDirPath(account, picked.id) : null;
      if (abs && srcDir.endsWith(abs)) root = srcDir.slice(0, srcDir.length - abs.length) || "/";
    } catch (err) {
      log.warn({ err }, `换算账号 ${account.name} 的挂载根失败，下次启动再试`);
      return; // 接口不通就整件事下次再来，别把别的账号误判成对不上
    }
    if (!root) continue;
    // 读—改—写要在一个事务里：启动时用户可能正好在设置页保存，整份写回会把他刚存的抹掉
    updateAppSetting("openlistCopy", (cur) => ({ ...(cur ?? {}), mounts: { ...(cur?.mounts ?? {}), [account.name]: root }, srcDir: undefined }));
    log.info(`旧配置已换算成挂载根：${account.name} → ${root}`);
    return;
  }
  log.warn(`旧的「复制到 OpenList」源目录 ${srcDir} 推不出挂载根，请到设置页手动填一下；在那之前复制不会发生`);
}

/**
 * 只复制不生成 strm 的那种回执：115 下完了，把产物的网盘绝对路径算出来交给复制队列。
 * 落点是从 115 给的目标目录 id 反解的，所以下到默认目录、下到任意目录都成立。
 */
async function handoffCopy(f: OfflineFollowup, t: OfflineTask, accountInfo: AccountInfo): Promise<void> {
  const name = t.resultName || t.name;
  let dir: string | null;
  try {
    dir = await deps.resolveDirPath(accountInfo, t.dirId);
  } catch (err) {
    f.attempts += 1;
    const msg = messageOf(err);
    if (f.attempts >= MAX_ATTEMPTS) finish(f, "failed", `解析 115 上的落点目录失败：${msg}`);
    else f.detail = `解析 115 上的落点目录失败，稍后重试（${f.attempts}/${MAX_ATTEMPTS}）：${msg}`;
    return;
  }
  if (!dir) {
    finish(f, "failed", `解析不出 115 上的落点目录（id=${t.dirId}），没法交给 OpenList 复制`);
    return;
  }
  const task = f.taskId ? getTask(f.taskId) : null;
  const path = joinPanPath(dir, name);
  // 删源 / 归档只动任务目录里的：115 上原本就有的（「任务已存在」）可能躺在别处、甚至属于别的任务，不能因为这个任务开着就动它
  const inTask = task != null && relativeTo(task.originPath, path) !== null;
  const queued = deps.enqueueCopy({
    account: accountInfo.name,
    sources: [{ path, isDir: t.isDir, nodeId: t.resultId ? String(t.resultId) : undefined }],
    // 有任务就按任务目录的层级摆，没有就平铺到目标目录
    rootPath: task?.originPath,
    taskId: task?.id,
    dstDir: f.copyDstDir,
    trigger: "offline",
    afterCopy: inTask ? followupAfterCopy(f, task) : "keep",
  });
  f.name = name;
  // 队列没收下（配置被删了、挂载根还没换算出来）就如实报失败：
  // 记成「已交给复制队列」的话，这次复制既不在队列里也没人知道它没了。
  // 已经排着一样的（或刚复制过）不算没收下：那一条会照办
  if (queued.queued === 0 && !queued.duplicates) {
    finish(f, "failed", `没能交给复制队列：${queued.skipped ?? "没有可排的条目"}`);
    return;
  }
  finish(f, "done", queued.queued > 0 ? `已交给复制队列：${f.copyDstDir ?? "默认目标目录"}` : "复制队列里已经有这一项（或刚复制过）");
}

/**
 * 整理把任务下的目录挪走后，还没兑现的回执落点跟着改（同 follow/service.ts 的 rewriteFollowSubPaths）。
 * dryRun 只返回会受影响的 subPath
 */
export function rewriteOfflineSubPaths(taskId: string, mappings: Array<{ from: string; to: string }>, dryRun = false): string[] {
  const rows = listFollowups();
  const hit: string[] = [];
  let changed = false;
  for (const f of rows) {
    if (f.taskId !== taskId || !f.subPath || f.status !== "pending") continue;
    if (dryRun) {
      hit.push(f.subPath);
      continue;
    }
    const m = mappings.find((x) => f.subPath === x.from || f.subPath.startsWith(`${x.from}/`));
    if (!m) continue;
    hit.push(f.subPath);
    f.subPath = normalizeSubPath(f.subPath === m.from ? m.to : `${m.to}${f.subPath.slice(m.from.length)}`);
    // 推进循环这一轮手里的同一条也改：它收尾时按自己手里的对象写回，只改库里这份会被盖回去
    const live = liveFollowups.get(keyOf(f));
    if (live) live.subPath = f.subPath;
    changed = true;
  }
  if (changed) saveFollowups(rows);
  return hit;
}

/** 回执上冻结的去向；存量回执按任务现在的设置（更老的只有 copyDeleteSource） */
function followupAfterCopy(f: OfflineFollowup, task: TaskDefinition | null | undefined): CopyAfterCopy {
  if (f.copyAfterCopy) return f.copyAfterCopy;
  if (f.copyDeleteSource !== undefined) return f.copyDeleteSource ? "delete" : "keep";
  return copyOptionsFor(task ?? null, undefined, readAppSettings()).afterCopy;
}

/** 仅供测试：清掉所有回执并停循环 */
export async function __test_resetOffline(): Promise<void> {
  await stopOfflineWatcher();
  writeKv(FOLLOWUP_KEY, []);
  lastTickAt = null;
  loop.noteError(null);
}
