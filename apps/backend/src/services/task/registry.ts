/**
 * 正在执行的全量任务。
 *
 * 只存在于内存：进度流、订阅句柄和最近的日志行。重启后自然清空，
 * 落库的执行历史由 services/task-history.ts 负责。
 */
import type { Subject, Subscription } from "rxjs";
import type { FailedFileBrief, FileFailureAction, FileFailureKind, TaskStopInfo } from "@openstrm/shared";
import { events } from "../events.js";

/**
 * 任务进度事件。SSE 原样推给页面，历史里也按行存同一种 JSON，页面用一套解析。
 *
 *   开始      { start, total, strmTotal, downloadTotal, at }
 *   文件进度  { filePath, kind, percent, overallPercent }      percent 到 100 即完成
 *   文件失败  { filePath, kind, error, reason, message, advice, action?, attempted? }   reason 起的字段是分类（老记录没有）
 *   任务错误  { error }                                          不带 filePath
 *   结束      { done, status, total, finished, failed, overallPercent, message?, stopped?, at }
 *   取消      { done, cancelled, status: "cancelled", message, at }
 */
export interface DownloadProgress {
  start?: boolean;
  total?: number;
  strmTotal?: number;
  downloadTotal?: number;
  filePath?: string;
  kind?: "strm" | "download";
  percent?: number;
  overallPercent?: string;
  error?: string;
  /** 文件失败的分类和建议（services/download/failure.ts）；人话说明放在 message 里。老记录没有这几个字段 */
  reason?: FileFailureKind;
  advice?: string;
  action?: FileFailureAction;
  /** false = 事前预判就知道写不进去（文件名过长），没去碰文件系统 */
  attempted?: boolean;
  /** 结束事件：整轮停的原因（磁盘满 / 没权限 / 登录失效 / 风控） */
  stopped?: TaskStopInfo;
  done?: boolean;
  status?: "completed" | "failed" | "cancelled";
  finished?: number;
  failed?: number;
  cancelled?: boolean;
  message?: string;
  /** 事件时间（ms），开始 / 结束事件带 */
  at?: number;
}

export interface RunningTask {
  subject: Subject<DownloadProgress>;
  subscription: Subscription;
  logs: string[];
  /** 这一次执行在历史表里的 id：智能体拿它当句柄查进度和结果 */
  executionId?: string;
  /** 当前的计数：总数、已完成、失败、总进度（"42.10"）。runner 起跑后挂上 */
  stats?: () => { total: number; finished: number; failed: number; percent: string };
  /** 最后失败的几个文件（runner 边跑边记，旧的挤出去）：看详情不用解析整份日志 */
  recentFailures?: FailedFileBrief[];
  /** 取消时的收尾（把执行历史标成 cancelled 等），由 runner 提供 */
  onCancel?: (reason: string) => void;
}

const running = new Map<string, RunningTask>();
/** 正在准备启动（拉远端目录树等）、还没注册进 running 的任务 */
const starting = new Set<string>();
/** 启动期间就来看日志的 SSE 连接：等启动阶段结束（注册进 running 或起不来）再决定推什么 */
const startWaiters = new Map<string, Set<(outcome?: StartOutcome) => void>>();

/** 启动阶段的结果，就是 startTask 的响应：200 是起来了或无事可做，其余是没起来的原因 */
export interface StartOutcome {
  status: number;
  message: string;
  details?: string;
  /** 200 但无事可做：没起跑、也不留执行记录 */
  idle?: boolean;
  /** 无事可做时的提醒（远端为空、跳过了清理） */
  warning?: string;
}

/** 每个任务最近一次启动的结果：无事可做的那次不进执行历史，查状态时靠它认出「最近一次是空跑」 */
const lastStarts = new Map<string, StartOutcome & { at: number }>();

export function getLastStartOutcome(id: string): (StartOutcome & { at: number }) | undefined {
  return lastStarts.get(id);
}

export function getRunningTask(id: string): RunningTask | undefined {
  return running.get(id);
}

export function isTaskRunning(id: string): boolean {
  return running.has(id) || starting.has(id);
}

export function listRunningTaskIds(): string[] {
  return [...new Set([...starting, ...running.keys()])];
}

/**
 * 占住启动权。startTask 在第一个 await 之前调它：拉远端目录树可能要几分钟，
 * 这期间 cron 和手动点击都会再进来，只查 running 表挡不住第二次——
 * 同一任务跑两遍，下载翻倍，后注册的把先注册的进度流顶掉。
 */
export function reserveTaskStart(id: string): boolean {
  if (running.has(id) || starting.has(id)) return false;
  starting.add(id);
  return true;
}

/**
 * 任务从「在跑」变成「不在跑」的那一刻：起不来 / 无事可做（启动阶段就结束）、跑完、被取消。
 * 只在真的有过占位时发：取消之后 runner 收尾还会再 unregister 一次，不能发两遍
 */
function finished(id: string): void {
  if (running.has(id) || starting.has(id)) return;
  events.emit("task.finished", { taskId: id });
}

/** 启动阶段结束：放掉占位，把结果交给等在 waitForTaskStart 上的人（起来了的话此时 running 里已经有了） */
export function releaseTaskStart(id: string, outcome?: StartOutcome): void {
  const had = starting.delete(id);
  if (outcome) lastStarts.set(id, { ...outcome, at: Date.now() });
  const waiters = startWaiters.get(id);
  if (waiters) {
    startWaiters.delete(id);
    for (const settle of waiters) settle(outcome);
  }
  if (had) finished(id);
}

/**
 * 等一个正在启动的任务把启动阶段走完。不在启动阶段立刻返回 undefined；
 * signal 中止（客户端断开）也返回 undefined 并把自己从等待者里摘掉。
 * 返回后调用方再查 getRunningTask：有就是起来了，没有就按 outcome 说明原因。
 */
export function waitForTaskStart(id: string, signal?: AbortSignal): Promise<StartOutcome | undefined> {
  if (!starting.has(id) || signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const waiters = startWaiters.get(id) ?? new Set();
    startWaiters.set(id, waiters);
    const settle = (outcome?: StartOutcome) => {
      signal?.removeEventListener("abort", onAbort);
      waiters.delete(settle);
      resolve(outcome);
    };
    const onAbort = () => settle(undefined);
    waiters.add(settle);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function registerRunningTask(id: string, task: RunningTask): void {
  running.set(id, task);
}

export function unregisterRunningTask(id: string): void {
  if (running.delete(id)) finished(id);
}

/**
 * 取消：退订下载流（进行中的被中止、排队的不再发出）、收尾执行历史、通知订阅者、从表里摘掉。
 * 以前只退订：历史一直挂着 running 到下次重启，已经交给限流器的下载还在继续写盘。
 * 没在跑返回 false。
 */
export function cancelRunningTask(id: string, reason = "用户取消"): boolean {
  const task = running.get(id);
  if (!task) return false;
  // 先摘掉：退订过程中还会有零星进度事件，runner 的 pushLog 靠这个判断不再往流里写
  running.delete(id);
  task.subscription.unsubscribe();
  try {
    task.onCancel?.(reason);
  } catch {
    /* 收尾失败不影响取消本身 */
  }
  task.subject.next({ done: true, cancelled: true, status: "cancelled", message: `任务已取消：${reason}`, at: Date.now() });
  task.subject.complete();
  finished(id);
  return true;
}

/** 进程退出时把所有订阅者收尾，SSE 连接才会正常关闭 */
export function cancelAllRunningTasks(): void {
  for (const id of [...running.keys()]) cancelRunningTask(id, "进程退出");
}
