/**
 * 网盘变更监控：每个被监控的账号各跑一条循环（AccountMonitor）。
 *
 *   门禁（source.prepare）→ 循环 { 先补同步期间记下的 → source.pull 一批 → 落库 → 逐条交给 handlers → 存游标 → 等一轮 }
 *
 * 变更来源按网盘类型来（DriveProvider.changes）：115 是生活事件流（sources/cloud115.ts），
 * 夸克是按目录指纹的快照对比（sources/quark.ts）。这里不认任何一家的接口，只认 ChangeSource 和 ChangeEvent。
 *
 * 全量同步在跑的任务目录，监控不动本地：事件照常落库但先记下（deferred），同步一结束（task.finished 插一轮加急）
 * 按原来的先后补上——同步拿着的远端清单可能比监控旧，两边同时改会把对方刚改好的改回去。判断在 deferral.ts。
 *
 * 启停是整体的：startLifeMonitor 把配置里的账号一起拉起来，stopLifeMonitor 全部停掉。
 * 一次启动共用一个 AbortController（generation）：stop 一掐，正在过门禁的请求被中止、睡着的醒来、
 * 处理中的事件做完这条就退；下一次 start 换一个新的。
 * 某个账号起不来（cookie 失效）不影响其它账号，它会以 running=false + lastError 出现在状态里。
 * 游标按账号各存一份（KEY.lifeCursor(name)）；事件表和 Emby 刷新防抖全局共用。
 */
import type { AccountInfo, LifeEventMode, LifeMonitorSettings, LifePullMode, TaskDefinition } from "@openstrm/shared";
import { KEY } from "../../db/keys.js";
import { isAbortError } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { createPollingLoop, type PollingLoop } from "../../lib/polling.js";
import { issueFromDrive, notify } from "../notify.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { getTask, listTasks } from "../../db/repositories/tasks.js";
import {
  countDeferredLifeEvents,
  countDriveSnapshots,
  countLifeEvents,
  countPathCache,
  isLifeEventHandled,
  LIFE_EVENT_DEFERRED,
  listDeferredLifeEvents,
  markLifeEvent,
  readKv,
  upsertLifeEvents,
  writeKv,
} from "../../db/repositories/life.js";
import type { LifeEventRow } from "../../db/schema.js";
import { bumpOwnHit, findOwnOperation, getRun as getOrganizeRun } from "../../db/repositories/organize.js";
import { enqueueCopy } from "../copy/service.js";
import { copyOptionsFor } from "../copy/paths.js";
import { events } from "../events.js";
import { effectiveAutoMode } from "../organize/auto.js";
import { providerFor } from "../drive/registry.js";
import { normalizePath, type AccountIssue, type ChangeCursor, type ChangeEvent, type ChangeKind, type ChangeLog, type ChangeSource, type DriveProvider, type ProbeResult } from "../drive/types.js";
import { isTaskRunning } from "../task/registry.js";
import { DeferralGate } from "./deferral.js";
import { flushEmbyRefresh, getEmbyRefreshState, scheduleEmbyRefresh } from "../media-server.js";
import {
  handleCreate,
  handleMove,
  handleNewFolder,
  handleRemove,
  handleRename,
  matchTask,
  type HandleResult,
  type LifeContext,
} from "./handlers.js";
import { describeFileFailure } from "../download/failure.js";

const DEFAULT_INTERVAL_SEC = 15;
const ALL_EVENT_MODES: LifeEventMode[] = ["create", "move", "rename", "remove"];
const LOG_LIMIT = 500;
const ZERO_CURSOR: ChangeCursor = { time: 0, id: "0" };
const CANCELLED = "启动已取消";
/** 同步期间记下的事件补处理连着失败这么多次就记失败，不再挡着后面同一处的事件 */
const MAX_REPLAY_ATTEMPTS = 3;
/** 同步任务结束后过这么久插一轮加急，把它跑的时候记下的变化补上 */
const REPLAY_NUDGE_MS = 500;

/** 事件表里 type 列的通用编码：故意用负数，避开 115 的 behavior type（115 的事件保留它自己的） */
export const KIND_CODE: Record<ChangeKind, number> = { create: -1, move: -2, rename: -3, remove: -4, folder: -5 };
export const KIND_NAME: Record<ChangeKind, string> = { create: "新增", move: "移动", rename: "改名", remove: "删除", folder: "新建目录" };

export interface MonitorStats {
  rounds: number;
  events: number;
  handled: number;
  skipped: number;
  failed: number;
  /** 同步任务在跑、先记下等它跑完再补的（补上之后再算进 handled / skipped / failed） */
  deferred: number;
}
const zeroStats = (): MonitorStats => ({ rounds: 0, events: 0, handled: 0, skipped: 0, failed: 0, deferred: 0 });

export interface AccountMonitorStatus {
  name: string;
  running: boolean;
  cursor: ChangeCursor;
  /** 变更来源：proapi / webapi / snapshot */
  source: string;
  startedAt: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  stats: MonitorStats;
  /** 现在记下、还没补上的事件条数 */
  backlog: number;
  /** 这个账号里正在同步的任务目录（网盘绝对路径）：落在这里面的变化先记下，跑完再补 */
  syncing: string[];
}

export interface MonitorStatus {
  /** 至少有一个账号在跑 */
  running: boolean;
  /**
   * 配置里要监控的每个账号的运行态。起不来的也在里面，running=false 且 lastError 说明原因；
   * 监控运行期间才加进配置的账号也是 running=false，但没有 lastError——要重启监控才会带上它。
   */
  accounts: AccountMonitorStatus[];
  interval: number;
  eventModes: LifeEventMode[];
  startedAt: number | null;
  lastPollAt: number | null;
  /** 各账号合计 */
  stats: MonitorStats;
  db: { lifeEvents: number; pathCache: number; snapshots: number };
  embyRefresh: { configured: boolean; pendingCount: number; pendingSince: number | null };
  logs: string[];
}

export interface StartResult {
  /** 至少起来一个账号 */
  ok: boolean;
  message: string;
  started: string[];
  /** 没起来的账号和原因；ok 为 true 时这里非空就是「部分启动」 */
  failed: Array<{ name: string; message: string }>;
}

/* ---------------------------------- 日志 ---------------------------------- */

const lifeLog = moduleLogger("life");
const logs: string[] = [];

/** 既写进程日志，也留一份在内存里给状态页展示。各账号共用一条时间线，行首带账号名 */
function log(level: "info" | "warn" | "error" | "debug", msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs.shift();
  lifeLog[level](msg);
}

const accountLogger = (name: string): ChangeLog => (level, msg) => log(level, `[${name}] ${msg}`);

/* -------------------------------- 账号解析 -------------------------------- */

/** 能做变更监控的账号（115 / 夸克），按账户表顺序 */
function monitorablePool(): Array<{ account: AccountInfo; provider: DriveProvider }> {
  return listAccounts()
    .map((account) => ({ account, provider: providerFor(account) }))
    .filter((x) => x.provider.capabilities.changes && x.provider.changes);
}

function pickProvider(name: string): DriveProvider | null {
  const account = getAccount(name);
  if (!account) return null;
  const provider = providerFor(account);
  return provider.capabilities.changes && provider.changes ? provider : null;
}

/**
 * 配置里要监控哪些账号：accounts 非空就是这些，否则全部能监控的账号。
 * 名字原样比对，不 trim：账号名以账户表里存的为准。保序去重；对不上账号表的照样返回，
 * 启动时会以「找不到账号」出现在状态里而不是被静默丢掉。
 */
export function resolveMonitoredAccountNames(
  cfg: LifeMonitorSettings,
  pool: ReadonlyArray<{ name: string }>,
): string[] {
  const names = [...new Set((cfg.accounts ?? []).filter((s) => s !== ""))];
  return names.length > 0 ? names : pool.map((a) => a.name);
}

function intervalSeconds(cfg: LifeMonitorSettings): number {
  return Math.max(5, Number(cfg.intervalSeconds) || DEFAULT_INTERVAL_SEC);
}

/** 老格式是 {fromTime, fromId}，读的时候一并认 */
function readSavedCursor(name: string): ChangeCursor | null {
  const saved = readKv<Partial<ChangeCursor> & { fromTime?: number; fromId?: string }>(KEY.lifeCursor(name));
  if (!saved) return null;
  const time = Number(saved.time ?? saved.fromTime) || 0;
  const id = String(saved.id ?? saved.fromId ?? "0");
  if (!time && (!id || id === "0")) return null;
  return { time, id };
}

/* -------------------------------- 单账号循环 -------------------------------- */

function dispatch(ctx: LifeContext, ev: ChangeEvent): Promise<HandleResult> {
  switch (ev.kind) {
    case "create":
      return handleCreate(ctx, ev);
    case "move":
      return handleMove(ctx, ev);
    case "rename":
      return handleRename(ctx, ev);
    case "remove":
      return handleRemove(ctx, ev);
    case "folder":
      return handleNewFolder(ctx, ev);
  }
}

function toRow(accountName: string, ev: ChangeEvent) {
  const name = ev.path.slice(ev.path.lastIndexOf("/") + 1);
  return {
    id: ev.id,
    accountName,
    type: ev.rawType ?? KIND_CODE[ev.kind],
    kind: ev.kind,
    path: ev.path,
    oldPath: ev.oldPath ?? "",
    fileId: ev.nodeId,
    parentId: "",
    fileName: name,
    fileCategory: ev.isDir ? 0 : 1,
    fileSize: ev.size ?? 0,
    sha1: ev.hash ?? "",
    pickCode: ev.token ?? "",
    updateTime: ev.at,
    createTime: ev.at,
  };
}

/** 这批任务里正在同步（含启动阶段——拉远端目录树）的任务目录，网盘绝对路径 */
function syncingScopes(tasks: TaskDefinition[]): string[] {
  return [...new Set(tasks.filter((t) => isTaskRunning(t.id)).map((t) => normalizePath(t.originPath)))];
}

/** 事件表的一行还原成处理器要的事件：toRow 反过来，补同步期间记下的事件时用 */
function eventFromRow(row: LifeEventRow): ChangeEvent {
  return {
    id: row.id,
    kind: row.kind as ChangeKind,
    path: row.path,
    oldPath: row.oldPath || null,
    isDir: row.fileCategory === 0,
    nodeId: row.fileId,
    ...(row.fileSize ? { size: row.fileSize } : {}),
    ...(row.sha1 ? { hash: row.sha1 } : {}),
    ...(row.pickCode ? { token: row.pickCode } : {}),
    at: row.updateTime,
    rawType: row.type,
  };
}

class AccountMonitor {
  running = false;
  cursor: ChangeCursor;
  startedAt: number | null = null;
  lastPollAt: number | null = null;
  lastError: string | null = null;
  readonly stats = zeroStats();
  /** 循环退出时落定；没起来过是 null */
  loopDone: Promise<void> | null = null;
  private resolveDone: (() => void) | null = null;
  private loop: PollingLoop | null = null;
  /** 账号被删了、不再支持监控：这条循环自己退出 */
  private retired = false;
  private readonly log: ChangeLog;
  private source: ChangeSource | null = null;
  /** 补同步期间记下的事件失败了几次（按事件 id）：只在内存里，重启从头数，最多多试三次 */
  private readonly replayAttempts = new Map<string, number>();
  /** 注销「同步任务结束了」的监听 */
  private offTaskFinished: (() => void) | null = null;

  constructor(
    readonly name: string,
    /** 整次启动共用的中止信号：门禁、睡眠、事件处理都听它 */
    private readonly signal: AbortSignal,
  ) {
    this.log = accountLogger(name);
    // 还没起来（或起不来）时显示上次停在哪
    this.cursor = readSavedCursor(name) ?? { ...ZERO_CURSOR };
  }

  status(): AccountMonitorStatus {
    return {
      name: this.name,
      running: this.running,
      cursor: { ...this.cursor },
      source: this.source?.label ?? pickProvider(this.name)?.changes?.label ?? "-",
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      stats: { ...this.stats },
      backlog: countDeferredLifeEvents(this.name),
      syncing: syncingScopes(listTasks().filter((t) => t.account === this.name)),
    };
  }

  /** 这个账号本次不启动（比如 cookie 和别的账号重复），原因留在状态里 */
  skip(message: string): { ok: false; message: string } {
    this.lastError = message;
    this.log("warn", message);
    return { ok: false, message };
  }

  /**
   * 启动前先过来源的门禁（能不能读到变更）。
   * 起不来不抛：原因留在 lastError 让状态页能看到，也不拖累别的账号。消息里不带账号名，
   * 状态页是按账号分行的，汇总消息由调用方加前缀。
   */
  async start(cfg: LifeMonitorSettings, intervalMs: number): Promise<{ ok: boolean; message: string }> {
    const fail = (message: string, reason?: string, issue?: AccountIssue | null) => {
      this.lastError = message;
      // cookie 失效 / 被封控才值得打扰人；认不出的不发，同一原因一小时只发一次
      if (reason) void notify({ type: "account-alert", account: this.name, reason, source: "网盘监控", issue: issueFromDrive(issue) });
      return { ok: false, message };
    };
    const provider = pickProvider(this.name);
    if (!provider) return fail("账户页里没有这个账号，或它不支持网盘监控（需要 115 / 夸克账号且带 cookie）");
    const source = provider.changes!;
    try {
      const gate = await source.prepare(this.signal, this.log);
      if (!gate.ok) return fail(gate.message, gate.reason, gate.issue);
    } catch (err) {
      if (this.signal.aborted || isAbortError(err)) return { ok: false, message: CANCELLED };
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`变更来源不可用：${msg}`, msg, provider.classifyError(err));
    }
    if (this.signal.aborted) return { ok: false, message: CANCELLED };

    this.source = source;
    const pullMode = cfg.pullMode ?? "latest";
    this.cursor = source.initialCursor(pullMode, readSavedCursor(this.name));
    writeKv(KEY.lifeCursor(this.name), this.cursor);
    this.running = true;
    this.startedAt = Date.now();
    this.lastPollAt = null;
    this.lastError = null;
    Object.assign(this.stats, zeroStats());
    const effective = Math.max(intervalMs, source.minIntervalSeconds * 1000);
    this.log("info", `启动：来源 ${source.label}，模式 ${pullMode}，间隔 ${effective / 1000}s`);
    this.retired = false;
    this.loopDone = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    // 轮询失败按次数退避（基数就是间隔，封顶十分钟）：cookie 失效、被风控时不再每 30 秒去撞一次
    this.loop = createPollingLoop({
      name: `账号 ${this.name} 的网盘监控`,
      log: lifeLog,
      intervalMs: effective,
      tick: () => this.round(),
      // 账号删了、整体 stop 掐了信号：这条循环自己退出
      shouldContinue: () => !this.retired && !this.signal.aborted,
      onExit: () => this.exited(),
    });
    // 这个账号的同步任务一结束，它跑的时候记下的变化马上补，不用等到下一轮
    this.offTaskFinished = events.on("task.finished", ({ taskId }) => {
      if (getTask(taskId)?.account !== this.name || countDeferredLifeEvents(this.name) === 0) return;
      this.loop?.nudge(REPLAY_NUDGE_MS);
    });
    this.loop.start();
    return { ok: true, message: "已启动" };
  }

  /** 停这条循环：把睡在两轮之间的等待叫醒，等在跑的那一轮收尾（整体的 signal 已经掐了，它会很快退出） */
  async stop(): Promise<void> {
    await this.loop?.stop();
  }

  /**
   * 一轮：每轮现取账号（cookie 在「账户」页改过就直接用新的），拉变更、逐条处理。
   * 失败抛出去由循环退避；被中止的不算
   */
  private async round(): Promise<void> {
    const provider = pickProvider(this.name);
    if (!provider) {
      this.lastError = "账号已删除或不再支持监控，监控已停止";
      this.log("warn", this.lastError);
      this.retired = true;
      return;
    }
    try {
      // 部分根没拉到时 warnings 留在 lastError 让状态页看见；全好才清掉
      this.lastError = (await this.runOnce(provider, this.signal)) ?? null;
    } catch (err) {
      if (this.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.log("error", `轮询失败：${msg}`);
      void notify({ type: "account-alert", account: this.name, reason: msg, source: "网盘监控", issue: issueFromDrive(provider.classifyError(err)) });
      this.log("info", "稍后重试；连续失败会把间隔逐步拉长，最多十分钟");
      throw err;
    }
  }

  /** 循环退出（自己退的、被 stop 的都走这里，只走一次）：游标落库，最后一条退出时把攒着的 Emby 刷新发掉 */
  private exited(): void {
    this.offTaskFinished?.();
    this.offTaskFinished = null;
    writeKv(KEY.lifeCursor(this.name), this.cursor);
    this.running = false;
    // 文件已经落盘了，攒着的 Emby 刷新不能丢；但别的账号还在跑就留给它们继续攒，最后一条退出时才发
    if (![...monitors.values()].some((m) => m.running)) flushEmbyRefresh();
    this.log("info", "已退出网盘监控");
    this.resolveDone?.();
    this.resolveDone = null;
  }

  /** 这一轮的处理上下文：每轮现读设置（事件模式、白名单在设置页改了下一轮就生效） */
  private context(provider: DriveProvider, tasks: TaskDefinition[], signal: AbortSignal): LifeContext {
    const settings = readAppSettings();
    return {
      provider,
      tasks,
      settings,
      eventModes: new Set<LifeEventMode>(settings.lifeMonitor?.eventModes ?? ALL_EVENT_MODES),
      log: this.log,
      signal,
    };
  }

  /** 返回这轮的告警文案（部分根没拉到）；全好返回 null */
  private async runOnce(provider: DriveProvider, signal: AbortSignal): Promise<string | null> {
    const source = provider.changes!;
    this.source = source;
    const tasks = listTasks().filter((t) => t.account === this.name);
    // 一轮一个闸：正在同步的任务目录每次现查。先补同步期间记下的，补不成的挡住后面同一处的新事件，先后不乱
    const gate = new DeferralGate(() => syncingScopes(tasks));
    let ctx: LifeContext | null = null;
    const context = (): LifeContext => (ctx ??= this.context(provider, tasks, signal));
    if (countDeferredLifeEvents(this.name) > 0 && !(await this.replayDeferred(context(), gate))) return null;

    const pulled = await source.pull(this.cursor, { tasks, signal, log: this.log });
    this.lastPollAt = Date.now();
    this.stats.rounds++;
    for (const w of pulled.warnings ?? []) this.log("warn", w);
    const warning = pulled.warnings?.length ? pulled.warnings.join("；") : null;
    const changes = pulled.changes;
    if (changes.length === 0) {
      this.cursor = pulled.cursor;
      writeKv(KEY.lifeCursor(this.name), this.cursor);
      pulled.commit?.([]);
      return warning;
    }

    this.stats.events += changes.length;
    this.log("info", `拉到 ${changes.length} 条新事件`);

    const failedIds: string[] = [];
    let deferred = 0;
    for (const item of changes) {
      // 被中止就不 commit：快照式来源下轮拿旧快照重新对比，事件流来源从游标接着拉
      if (signal.aborted) return warning;
      const id = item.id;
      if (isLifeEventHandled(id)) continue;
      // 交给处理器前一刻才解析（115 在这里查旧路径、改缓存）；解析抛错按整轮失败处理，游标停在上一条，下轮重拉
      const ev = await item.resolve();
      upsertLifeEvents([toRow(this.name, ev)]);

      const name = KIND_NAME[ev.kind];
      const wait = ev.problem ? null : gate.check(ev);
      if (ev.problem) {
        markLifeEvent(id, "skipped", ev.problem);
        this.stats.skipped++;
        this.log("debug", `${name} 跳过：${ev.problem}`);
      } else if (wait) {
        // 同步任务正在跑这个目录：先记下不动本地，它跑完再按先后补（事件已经落库，游标、快照照常往前走）
        markLifeEvent(id, LIFE_EVENT_DEFERRED, wait);
        this.stats.deferred++;
        deferred++;
      } else {
        try {
          await this.apply(context(), id, ev);
        } catch (err) {
          // 处理到一半被中止：这条不算处理过，游标不动、不 commit，下次启动重来
          if (signal.aborted || isAbortError(err)) return warning;
          this.stats.failed++;
          failedIds.push(id);
          // 本地写不进去 / 网盘取不到：给人话和建议（认不出的还是原文）
          const msg = describeFileFailure(err, { relPath: ev.path, kind: "strm", provider });
          markLifeEvent(id, "failed", msg);
          this.log("error", `${name} ${ev.path} 处理失败：${msg}`);
        }
      }

      // 事件流来源逐条给游标：每条处理完都推进，中途崩了也不会重放已完成的事件
      if (item.cursor) {
        this.cursor = item.cursor;
        writeKv(KEY.lifeCursor(this.name), this.cursor);
      }
    }
    if (deferred > 0) this.log("info", `同步任务在跑：先记下 ${deferred} 条变化，等它跑完再补上`);
    this.cursor = pulled.cursor;
    writeKv(KEY.lifeCursor(this.name), this.cursor);
    pulled.commit?.(failedIds);
    return warning;
  }

  /**
   * 处理一条事件并记下结果。实时的和同步结束后补的都走这里：整理自己做的跳过、分派给处理器、攒 Emby 刷新、交给自动整理和复制。
   * 出错原样抛出：实时的记失败，补的下一轮再试
   */
  private async apply(ctx: LifeContext, id: string, ev: ChangeEvent): Promise<void> {
    const name = KIND_NAME[ev.kind];
    // 整理自己做的改名 / 移动 / 建目录 / 删空目录会以事件的形式再回来一遍：本地已经镜像过了，跳过。
    // 两种本地没跟上的不跳，让事件照常处理把本地补回来：本地镜像失败的（errorKind = mirror，放弃了也算）、
    // 撤销时挪回来了但改回原名那步失败的（done 带 curPath：镜像要等改完名才做）。
    // 撤销在网盘那步失败、文件没动过的项（done 带别的类别、没有 curPath）本地和网盘仍一致，照常跳过
    const own = findOwnOperation(ev.nodeId, ev.path, ev.at, ev.kind === "remove" ? "remove" : "other");
    // 挪回来了、还没改回原名（done 带 cur_path）：撤销还在跑就是正常的中间状态（改完名撤销自己镜像本地），跳过；
    // 撤销已经结束还是这样，才是改名那步失败了、本地没跟上，照常处理
    const halfBack = own !== null && own.status === "done" && own.curPath !== "" && getOrganizeRun(own.runId)?.status !== "reverting";
    const ownOk = own !== null && own.errorKind !== "mirror" && !halfBack;
    if (ownOk) bumpOwnHit(own.id);
    const res: HandleResult = ownOk ? { status: "skipped", detail: "整理已处理，本地已镜像", changed: false } : await dispatch(ctx, ev);
    markLifeEvent(id, res.status, res.detail);
    if (res.status !== "done") {
      this.stats.skipped++;
      this.log("debug", `${name} 跳过：${res.detail}`);
      return;
    }
    this.stats.handled++;
    // 防抖攒着：事件一条一条来，逐条触发全库扫描会把 Emby 打瘫
    if (res.changed) scheduleEmbyRefresh();
    this.log("info", `${name} ${res.detail}`);
    // 新落进任务的才交给自动整理：新增，或者从任务外挪进来（从云下载、最近接收挪进剧集目录是常见的来路）；任务里挪来挪去的不算
    if (!res.arrived || !res.changed) return;
    const m = matchTask(ctx, ev.path);
    if (!m?.relPath) return;
    events.emit("files.landed", { task: m.task, paths: [m.relPath], trigger: "monitor", debounce: true });
    // 整理自己造成的事件走的是上面的 ownOk 分支，进不到这里，所以不会把整理搬过的文件再复制一遍
    const copyOpts = copyOptionsFor(m.task, undefined);
    if (copyOpts.blocked) this.log("info", `${name} 没复制到 OpenList：${copyOpts.blocked}`);
    if (copyOpts.enabled) {
      enqueueCopy({
        account: this.name,
        sources: [{ path: ev.path, isDir: ev.isDir, nodeId: ev.nodeId }],
        rootPath: m.task.originPath,
        taskId: m.task.id,
        dstDir: copyOpts.dstDir,
        trigger: "monitor",
        // 监控是一个文件一条事件：删源 / 归档只对「整条目复制」开（转存 / 追更 / 云下载），
        // 不然自动整理还没来得及动那个文件，它就已经被删掉或挪走了
        afterCopy: "keep",
        holdForOrganize: effectiveAutoMode(m.task) === "auto",
      });
    }
  }

  /**
   * 补同步期间记下的事件：按记下的先后，还在忙的范围里（或者和前面没补成的交叠）的接着等，其余和实时事件走同一条处理。
   * 补失败的这一处这一轮先停、下一轮再试，连着三次还失败就记失败（和实时处理失败一样）。被中止返回 false
   */
  private async replayDeferred(ctx: LifeContext, gate: DeferralGate): Promise<boolean> {
    let replayed = 0;
    for (const row of listDeferredLifeEvents(this.name)) {
      if (ctx.signal?.aborted) return false;
      const ev = eventFromRow(row);
      const wait = gate.check(ev);
      if (wait) {
        // 原因变了（换了一个同步、或者被前面补失败的挡住）就更新说明，界面上看到的是现在为什么还在等
        if (wait !== row.detail) markLifeEvent(row.id, LIFE_EVENT_DEFERRED, wait);
        continue;
      }
      try {
        await this.apply(ctx, row.id, ev);
        this.replayAttempts.delete(row.id);
        replayed++;
      } catch (err) {
        if (ctx.signal?.aborted || isAbortError(err)) return false;
        const name = KIND_NAME[ev.kind];
        const msg = describeFileFailure(err, { relPath: ev.path, kind: "strm", provider: ctx.provider });
        const attempts = (this.replayAttempts.get(row.id) ?? 0) + 1;
        if (attempts >= MAX_REPLAY_ATTEMPTS) {
          this.replayAttempts.delete(row.id);
          this.stats.failed++;
          markLifeEvent(row.id, "failed", `同步期间记下的变化补了 ${attempts} 次都没成：${msg}`);
          this.log("error", `${name} ${ev.path} 补处理失败：${msg}`);
        } else {
          this.replayAttempts.set(row.id, attempts);
          gate.hold(ev);
          markLifeEvent(row.id, LIFE_EVENT_DEFERRED, `补处理失败（第 ${attempts} 次），下一轮再试：${msg}`);
          this.log("warn", `${name} ${ev.path} 补处理失败（第 ${attempts} 次），下一轮再试：${msg}`);
        }
      }
    }
    if (replayed > 0) this.log("info", `同步结束了：补上了同步期间记下的 ${replayed} 条变化`);
    return true;
  }
}

/* --------------------------------- 生命周期 --------------------------------- */

/** 最近一次启动涉及的账号，起来没起来都在；下次启动整体换掉 */
const monitors = new Map<string, AccountMonitor>();
/** 本次启动的中止信号；stop 掐它 */
let generation: AbortController | null = null;
let startPromise: Promise<StartResult> | null = null;

function runningMonitors(): AccountMonitor[] {
  return [...monitors.values()].filter((m) => m.running);
}

export function isLifeMonitorRunning(): boolean {
  // 正在停的（signal 已掐）不算在跑：这时再来的 start 要等它退完重新起，不能被「已在运行」打发
  if (!generation || generation.signal.aborted) return false;
  return runningMonitors().length > 0;
}

/**
 * 启动监控。并发的两次调用（双击启动、启动时 index.ts 自动拉起撞上界面操作）共用同一次启动：
 * running 要到门禁的几次 await 之后才置位，不共用的话两次都能过检查，同一账号起出两条循环。
 */
export function startLifeMonitor(): Promise<StartResult> {
  if (isLifeMonitorRunning()) {
    return Promise.resolve({
      ok: true,
      message: "网盘监控已在运行",
      started: runningMonitors().map((m) => m.name),
      failed: [],
    });
  }
  startPromise ??= doStart().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function doStart(): Promise<StartResult> {
  const ctl = new AbortController();
  generation = ctl;
  const none = (message: string): StartResult => ({ ok: false, message, started: [], failed: [] });

  // 上一轮的循环可能还在收尾（stop 之后的最后一轮），等它们退出再起新的：
  // 同一账号两条循环并存会互相覆盖游标
  await Promise.allSettled([...monitors.values()].map((m) => m.loopDone));
  if (ctl.signal.aborted) return none(CANCELLED);

  const cfg = readAppSettings().lifeMonitor ?? {};
  const pool = monitorablePool();
  if (pool.length === 0) return none("没有能监控的账号：需要带 cookie 的 115 或夸克账号");
  const names = resolveMonitoredAccountNames(cfg, pool.map((x) => x.account));

  // 同一个 cookie 挂在两个账号名下会把同一批事件拉两遍、互相抢去重位：只监控先出现的那个
  const firstByCookie = new Map<string, string>();
  const twinOf = new Map<string, string>();
  for (const name of names) {
    const account = pool.find((x) => x.account.name === name)?.account as { cookie?: string } | undefined;
    const cookie = account?.cookie;
    if (!cookie) continue;
    const first = firstByCookie.get(cookie);
    if (first) twinOf.set(name, first);
    else firstByCookie.set(cookie, name);
  }

  monitors.clear();
  const intervalMs = intervalSeconds(cfg) * 1000;
  const results = await Promise.all(
    names.map(async (name) => {
      const m = new AccountMonitor(name, ctl.signal);
      monitors.set(name, m);
      const twin = twinOf.get(name);
      try {
        const r = twin ? m.skip(`cookie 和账号 ${twin} 相同，同一个网盘只监控一次`) : await m.start(cfg, intervalMs);
        return { name, ...r };
      } catch (err) {
        // 门禁之外的同步代码（读账号表、写游标）炸了——磁盘满之类：按该账号启动失败记，别把别的账号一起拖死
        const message = err instanceof Error ? err.message : String(err);
        m.lastError = message;
        return { name, ok: false, message };
      }
    }),
  );
  if (ctl.signal.aborted) return none(CANCELLED);

  const started = results.filter((r) => r.ok).map((r) => r.name);
  const failed = results.filter((r) => !r.ok).map((r) => ({ name: r.name, message: r.message }));
  if (started.length === 0) {
    return { ok: false, message: failed.map((f) => `${f.name}：${f.message}`).join("；"), started, failed };
  }
  let message = `网盘监控已启动（账号 ${started.join("、")}）`;
  if (failed.length > 0) message += `；${failed.map((f) => `${f.name} 未启动：${f.message}`).join("；")}`;
  return { ok: true, message, started, failed };
}

export async function stopLifeMonitor(): Promise<{ ok: boolean; message: string }> {
  const ctl = generation;
  const active = ctl !== null && !ctl.signal.aborted && (startPromise !== null || runningMonitors().length > 0);
  if (!active) return { ok: true, message: "网盘监控未在运行" };
  // 一掐全退：过门禁的请求被中止、睡着的醒来、处理中的事件做完这条就停
  ctl.abort();
  if (startPromise) {
    try {
      await startPromise;
    } catch {
      /* doStart 自己处理 */
    }
  }
  // 循环可能正睡在两轮之间的等待（或退避）里：stop 把它叫醒并等在跑的那一轮收尾
  await Promise.allSettled([...monitors.values()].map((m) => m.stop()));
  await Promise.allSettled([...monitors.values()].map((m) => m.loopDone));
  return { ok: true, message: "网盘监控已停止" };
}

function idleStatus(name: string): AccountMonitorStatus {
  return {
    name,
    running: false,
    cursor: readSavedCursor(name) ?? { ...ZERO_CURSOR },
    source: pickProvider(name)?.changes?.label ?? "-",
    startedAt: null,
    lastPollAt: null,
    lastError: null,
    stats: zeroStats(),
    backlog: countDeferredLifeEvents(name),
    syncing: syncingScopes(listTasks().filter((t) => t.account === name)),
  };
}

export function getLifeMonitorStatus(): MonitorStatus {
  const cfg = readAppSettings().lifeMonitor ?? {};
  const names = resolveMonitoredAccountNames(cfg, monitorablePool().map((x) => x.account));
  // 已从配置里去掉但还在跑的账号照样显示，直到它停下
  for (const m of monitors.values()) if (m.running && !names.includes(m.name)) names.push(m.name);
  const accounts = names.map((name) => monitors.get(name)?.status() ?? idleStatus(name));

  const running = accounts.filter((a) => a.running);
  const startedAts = running.map((a) => a.startedAt).filter((t): t is number => t !== null);
  const pollAts = accounts.map((a) => a.lastPollAt).filter((t): t is number => t !== null);
  const stats = zeroStats();
  for (const a of accounts) {
    for (const k of Object.keys(stats) as Array<keyof MonitorStats>) stats[k] += a.stats[k];
  }
  return {
    running: running.length > 0,
    accounts,
    interval: intervalSeconds(cfg),
    eventModes: cfg.eventModes ?? ALL_EVENT_MODES,
    startedAt: startedAts.length > 0 ? Math.min(...startedAts) : null,
    lastPollAt: pollAts.length > 0 ? Math.max(...pollAts) : null,
    stats,
    db: { lifeEvents: countLifeEvents(), pathCache: countPathCache(), snapshots: countDriveSnapshots() },
    embyRefresh: getEmbyRefreshState(),
    // 界面只显示最近 50 条，这个接口每 5 秒被轮询一次，别每次都搬 500 行
    logs: logs.slice(-100),
  };
}

/* ----------------------------------- 探测 ----------------------------------- */

export interface ProbeAccountResult extends ProbeResult {
  account: string;
}

export interface ProbeSummary {
  /** 每个账号都通了才算通 */
  ok: boolean;
  /** 单账号就是它自己的结果；多账号逐个列出 */
  message: string;
  accounts: ProbeAccountResult[];
}

async function probeAccount(name: string, limit: number): Promise<ProbeAccountResult> {
  const provider = pickProvider(name);
  if (!provider) return { account: name, ok: false, message: "账户页里没有这个账号，或它不支持网盘监控" };
  const source = provider.changes!;
  if (!source.probe) return { account: name, ok: true, message: "这个来源没有探测接口" };
  return { account: name, ...(await source.probe(limit)) };
}

/** 只看不处理，用于在页面上确认「能不能读到变更」；不指定账号就把配置里的都测一遍 */
export async function probeLifeEvents(limit = 20, only?: string): Promise<ProbeSummary> {
  const cfg = readAppSettings().lifeMonitor ?? {};
  const names = only ? [only] : resolveMonitoredAccountNames(cfg, monitorablePool().map((x) => x.account));
  if (names.length === 0) return { ok: false, message: "没有可监控的账号", accounts: [] };
  const accounts = await Promise.all(names.map((name) => probeAccount(name, limit)));
  const message =
    accounts.length === 1 ? accounts[0]!.message : accounts.map((a) => `${a.account}：${a.message}`).join("；");
  return { ok: accounts.every((a) => a.ok), message, accounts };
}

export type { LifePullMode };
