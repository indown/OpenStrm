/**
 * 全量同步任务的执行引擎。
 *
 * 路由、cron、Telegram 按钮、影库转存的 async 模式都直接调这里，
 * 不再经由 app.inject 自签 JWT 绕一圈 HTTP 鉴权。返回值就是 HTTP 语义的
 * `{ status, body }`，路由原样透传，其它调用方按 status 判断成败。
 */
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { catchError, defer, EMPTY, finalize, from, merge, mergeMap, retry, Subject, Subscription, takeUntil, tap, throwError, timer } from "rxjs";
import type { FailedFileBrief, FileFailureKind, TaskDefinition, TaskStopInfo } from "@openstrm/shared";
import { listAccounts } from "../../db/repositories/accounts.js";
import { listRunsByStatus } from "../../db/repositories/organize.js";
import { getTask } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { resolveInDataDir } from "../../paths.js";
import { moduleLogger } from "../../lib/logger.js";
import { mapLimit } from "../../lib/async.js";
import { isDirectoryEntry, removeEmptyParents } from "../../lib/fs.js";
import { KIND_LABEL, providerFor } from "../drive/registry.js";
import { RemoteDirNotFoundError, splitPath, type AccountIssue, type DriveProvider } from "../drive/types.js";
import {
  downloadOrCreateStrm,
  downloadOrCreateStrmLimited,
  resolveDownload,
} from "../download/rate-limited.js";
import {
  addLogsToTaskExecution,
  completeTaskExecution,
  createTaskExecution,
  updateTaskExecution,
} from "../task-history.js";
import { classifyFileFailure, summarizeFailures, type FileFailure } from "../download/failure.js";
import { throttleSettings } from "../throttle.js";
import { refreshEmbyNow } from "../media-server.js";
import { extOf, extSet } from "../strm/naming.js";
import { notify, type TaskTrigger, issueFromDrive } from "../notify.js";
import {
  getRunningTask,
  registerRunningTask,
  releaseTaskStart,
  reserveTaskStart,
  unregisterRunningTask,
  type DownloadProgress,
  type RunningTask,
  type StartOutcome,
} from "./registry.js";
import { LogBatcher } from "./log-batch.js";
import { isStagingDir } from "../strm/staging.js";
import { planSync } from "./plan.js";
import { collectFilesAndTopEmptyDirs, type TreeNode } from "./tree.js";

export interface StartTaskResult {
  /** HTTP 语义的状态码：200 已受理（可能是"无事可做"），其余为失败 */
  status: number;
  body: Record<string, unknown>;
}

const log = moduleLogger("task");

/** 最后失败的文件留几个（运行中的状态和执行记录的摘要里） */
const RECENT_FAILURES_KEPT = 20;

const fail = (status: number, message: string, detail?: string, issue?: AccountIssue | null): StartTaskResult => ({
  status,
  body: { message, ...(detail ? { details: detail } : {}), ...(issue ? { issue } : {}) },
});

/* ------------------------------- 本地目录 ------------------------------- */

/**
 * 本地已有的目录树。一个库几万个文件，同步版会把 API 进程的事件循环卡住几秒到几分钟
 * （SSE、健康检查、cron 全停），所以整条链路都走异步 fs。
 */
async function getLocalTree(dirPath: string, parentKey = 0, depth = 0, keySeed = { value: 1 }): Promise<TreeNode[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return []; // 第一次同步，目录还不存在
  }
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    const node: TreeNode = { key: keySeed.value++, name: entry.name, parent_key: parentKey, depth, children: [] };
    if (await isDirectoryEntry(dirPath, entry)) {
      node.children = await getLocalTree(path.join(dirPath, entry.name), node.key, depth + 1, keySeed);
    }
    nodes.push(node);
  }
  return nodes;
}

async function removeExtraFiles(extraLocally: string[], saveDir: string): Promise<void> {
  await mapLimit(extraLocally, 8, async (rel) => {
    const fp = path.join(saveDir, rel);
    try {
      // 文件、目录都行；已经不存在也不报错
      await fsp.rm(fp, { recursive: true, force: true });
      await removeEmptyParents(path.dirname(fp), saveDir);
    } catch { /* 单个失败不影响其余 */ }
  });
}

/* ------------------------------- 远端目录 ------------------------------- */

/**
 * 远端目录的同步视图（文件 + 顶层空目录，相对 originPath）。三家网盘都走 provider.listSubtree，
 * 这里只负责把失败翻译成任务启动结果：被封控 403，源目录不存在 / 其它 500 带原因。
 */
async function loadRemoteEntries(
  task: TaskDefinition,
  provider: DriveProvider,
): Promise<{ entries: string[] } | { fail: StartTaskResult }> {
  const { originPath } = task;
  if (splitPath(originPath).length === 0) return { fail: fail(400, "远程路径不能是根目录，请填一个具体目录") };
  const label = KIND_LABEL[provider.kind];
  try {
    // 整理挪进「重复文件」、复制后归档进「归档」的东西只在网盘上留着，不进媒体库：不给它生成 strm，也别当本地多余的删（本来就没生成过）
    return { entries: (await provider.listSubtree(originPath)).filter((p) => !isStagingDir(p)) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const issue = provider.classifyError(error);
    if (issue === "blocked") {
      return { fail: fail(403, `${label}账号被封控`, "账号访问被阻断，请检查账号状态或稍后重试", issue) };
    }
    // 找不到源目录就中止：接着按"远端为空"跑会把本地库整个当多余删掉
    if (error instanceof RemoteDirNotFoundError) {
      return { fail: fail(500, "远端目录树里找不到源目录", `${originPath} 不存在或已改名，已中止，避免把本地文件当多余删掉`) };
    }
    // ensureOk 的 message 自带"115："前缀，这里外面还有一层"读取目录失败"，别叠成"…失败：115：…"；
    // 网盘自己认出的账号问题（夸克的 require login）一起带给通知，别指望它从文案里猜
    return { fail: fail(500, `读取${label}目录失败`, msg.replace(/^115：/, ""), issue) };
  }
}

/* --------------------------------- 入口 --------------------------------- */

export interface StartTaskOptions {
  /** 谁触发的：只影响通知文案 */
  trigger?: TaskTrigger;
}

export async function startTask(taskId: string, opts: StartTaskOptions = {}): Promise<StartTaskResult> {
  const task = getTask(taskId);
  if (!task) return fail(404, "Task not found");
  // 这个任务上有整理在预览 / 执行 / 撤销：这一轮同步跳过。两边改的是同一棵树——同步会把整理改过名的 strm 当多余删掉、再按旧位置生成一份
  const organizing = listRunsByStatus(["planning", "applying", "reverting"]).find((r) => r.taskId === taskId);
  if (organizing) return fail(409, "任务有整理在进行中，这次同步跳过", `等整理 ${organizing.id} 结束再同步`);
  // 第一个 await 之前就占住：拉远端目录树可能要几分钟，只查 running 表挡不住这期间的第二次启动
  if (!reserveTaskStart(taskId)) return fail(409, "Task is already running");
  let outcome: StartOutcome = { status: 500, message: "启动失败" };
  try {
    const result = await launch(task, opts.trigger);
    if (result.status !== 200) recordFailedStart(task, result.body, opts.trigger);
    const details = typeof result.body.details === "string" ? result.body.details : undefined;
    const warning = typeof result.body.warning === "string" ? result.body.warning : undefined;
    outcome = {
      status: result.status,
      message: typeof result.body.message === "string" ? result.body.message : outcome.message,
      ...(details ? { details } : {}),
      ...(result.status === 200 && !result.body.executionId ? { idle: true } : {}),
      ...(warning ? { warning } : {}),
    };
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordFailedStart(task, { message }, opts.trigger);
    outcome = { status: 500, message };
    throw err;
  } finally {
    // 到这里要么已经注册进 running，要么是提前失败返回；占位都可以放掉了。
    // 结果一并交给 registry：启动期间就连上日志流的人靠它知道任务是起来了还是没起来
    releaseTaskStart(taskId, outcome);
  }
}

/**
 * 起不来也要进历史。cookie 失效、封控、目录不存在这些最常见的失败都发生在拉目录树阶段，
 * 以前只在响应里说一句，历史页看不到"为什么没跑"——定时触发的更是无人知晓。
 * "无事可做"的 200 不算失败，照旧不留记录，不然每 30 分钟一条空记录。
 */
function recordFailedStart(task: TaskDefinition, body: Record<string, unknown>, trigger?: TaskTrigger): void {
  const message = typeof body.message === "string" && body.message ? body.message : "启动失败";
  const details = typeof body.details === "string" && body.details ? `：${body.details}` : "";
  const issue = body.issue === "auth" || body.issue === "blocked" || body.issue === "gone" ? body.issue : undefined;
  void notify({ type: "task-start-failed", task, reason: `${message}${details}`, trigger, issue: issueFromDrive(issue) });
  try {
    const execution = createTaskExecution(task.id, {
      account: task.account,
      originPath: task.originPath,
      targetPath: task.targetPath,
      removeExtraFiles: task.removeExtraFiles,
    });
    completeTaskExecution(execution.id, "failed", { errorMessage: `${message}${details}` });
  } catch (err) {
    log.warn({ err, taskId: task.id }, "写入失败的执行记录失败");
  }
}

async function launch(task: TaskDefinition, trigger?: TaskTrigger): Promise<StartTaskResult> {
  const { id, account, originPath, targetPath, strmPrefix } = task;
  const accounts = listAccounts();
  const accountInfo = accounts.find((a) => a.name === account);
  if (!accountInfo) return fail(500, `账号不存在：${account}`);
  const provider = providerFor(accountInfo);

  const saveDir = resolveInDataDir(targetPath);
  if (!saveDir) return fail(400, `targetPath 越出了数据目录: ${targetPath}`);

  const loaded = await loadRemoteEntries(task, provider);
  if ("fail" in loaded) return loaded.fail;

  await fsp.mkdir(saveDir, { recursive: true });

  const settings = readAppSettings();
  const strmExts = extSet(settings.strmExtensions);
  const dlExts = extSet(settings.downloadExtensions);

  // 对照规则在 plan.ts，有单测钉着；这里只负责把两边的清单喂进去
  const remoteEntries = loaded.entries;
  // 本地这边同样跳过暂存区：升级前就叫「归档」的目录里可能早有 strm，远端那边不列了，不能因此把它们当多余删掉
  const localEntries = collectFilesAndTopEmptyDirs(await getLocalTree(saveDir)).filter((p) => !isStagingDir(p));
  const { missing: missingLocally, extra: extraLocally } = planSync(remoteEntries, localEntries, strmExts, dlExts);

  let warning: string | undefined;
  let deleted = 0;
  if (task.removeExtraFiles && extraLocally.length > 0) {
    if (remoteEntries.length === 0) {
      // 远端一个文件都没有而本地有一堆，十有八九是导出出了问题（空导出、解析没对上），
      // 不是用户真把网盘清空了。删错的代价是整个库，宁可跳过；真要清空有"清空目录"
      warning = `远端目录为空而本地有 ${localEntries.length} 个条目，像是目录导出失败，已跳过清理本地多余文件`;
      log.warn({ taskId: id, local: localEntries.length }, warning);
    } else {
      await removeExtraFiles(extraLocally, saveDir);
      deleted = extraLocally.length;
    }
  }
  if (missingLocally.length === 0) {
    // 只清了本地多余的文件也要让媒体库知道
    if (deleted > 0) refreshEmbyNow("清理了本地多余文件");
    return { status: 200, body: { message: "no files to download", warning } };
  }

  const total = missingLocally.length;
  const subject = new Subject<DownloadProgress>();
  const perFile = new Map<string, number>(missingLocally.map((fp) => [fp, 0]));
  const execution = createTaskExecution(id, { account, originPath, targetPath, removeExtraFiles: task.removeExtraFiles });
  updateTaskExecution(execution.id, {
    summary: { totalFiles: total, downloadedFiles: 0, deletedFiles: deleted },
  });

  const running: RunningTask = { subject, subscription: new Subscription(), logs: [], executionId: execution.id };
  registerRunningTask(id, running);
  void notify({ type: "task-start", task, total, trigger });

  // 落库的日志攒批写；取消时随订阅一起 flush（见下面的 subscription.add）
  const history = new LogBatcher((lines) => addLogsToTaskExecution(execution.id, lines));
  const pushLog = (log: DownloadProgress) => {
    // 被取消之后不再往流里写：订阅者早就收到 done 了
    if (getRunningTask(id) !== running) return;
    const line = JSON.stringify(log);
    running.logs.push(line);
    if (running.logs.length > 20000) running.logs.shift();
    subject.next(log);
    // 历史只留有价值的行：开始、单个文件完成/失败、任务级错误、结束；每一步进度不落库
    if (log.start || (log.filePath && (log.percent === 100 || log.error)) || log.done || log.error) history.push(line);
  };

  const strmFiles = missingLocally.filter((fp) => strmExts.has(extOf(fp)));
  const downloadFiles = missingLocally.filter((fp) => dlExts.has(extOf(fp)));
  // 第一条事件：总数和两类各多少。晚打开日志页的人从回放里也能拿到
  pushLog({ start: true, total, strmTotal: strmFiles.length, downloadTotal: downloadFiles.length, at: Date.now() });

  // 总进度用累计值：每来一个事件就把 perFile 全部加一遍是 O(n)，几万个文件就是 O(n²)
  let sumPercent = 0;
  const finished = new Set<string>();
  const failedFiles: string[] = [];
  const overall = () => (total > 0 ? (sumPercent / total).toFixed(2) : "100.00");
  running.stats = () => ({ total, finished: finished.size, failed: failedFiles.length, percent: overall() });
  const recentFailures: FailedFileBrief[] = [];
  running.recentFailures = recentFailures;
  const report = (p: { filePath?: string; percent?: number }, kind: "strm" | "download") => {
    const fp = p.filePath!;
    const pct = Math.min(100, Math.max(0, p.percent ?? 0));
    sumPercent += pct - (perFile.get(fp) ?? 0);
    perFile.set(fp, pct);
    pushLog({ filePath: fp, kind, percent: pct, overallPercent: overall() });
  };
  /**
   * 完成以流 complete 为准，不看 percent 到没到 100：下载流在最后一个 chunk 到手时就发 100，
   * 那时 .part 还没改名；改名失败会再走 failOne，按 percent 算的话同一个文件既算完成又算失败
   */
  const finishOne = (filePath: string) => finished.add(filePath);
  /** 失败按类别计数，以及每一类的建议（摘要里给数量最多那一类的） */
  const failures: Partial<Record<FileFailureKind, number>> = {};
  const adviceByKind: Partial<Record<FileFailureKind, string>> = {};
  /** 整轮停：第一个整轮级的失败记在这里，stop$ 让 merge 走正常的 complete 收尾（进行中的下载随之中止） */
  let stopping: FileFailure | null = null;
  const stop$ = new Subject<void>();
  let finishedRun = false;
  /**
   * 单个文件失败：分类、记一行（带人话说明和建议）、计数，任务继续。
   * 以前下载那条流没有接住，一个文件 404 会把整条 merge 炸掉：剩下的下载全部中止，
   * 历史里 downloadedFiles 记 0，错误信息里连是哪个文件都没有。
   * 磁盘满 / 没权限 / 只读 / 登录失效 / 风控是整轮的事，第一次出现就停，不再逐个文件失败
   */
  const failOne = (filePath: string, kind: "strm" | "download", err: unknown) => {
    const f = classifyFileFailure(err, { relPath: filePath, kind, provider });
    // 写文件前就判定写不进去的（文件名过长）带 attempted=false：日志页标「没去碰文件系统」
    const attempted = (err as { attempted?: boolean } | null)?.attempted !== false;
    failedFiles.push(filePath);
    recentFailures.push({ file: filePath, message: f.message, ...(f.advice ? { advice: f.advice } : {}) });
    if (recentFailures.length > RECENT_FAILURES_KEPT) recentFailures.shift();
    failures[f.kind] = (failures[f.kind] ?? 0) + 1;
    adviceByKind[f.kind] ??= f.advice;
    pushLog({ filePath, kind, error: f.detail, reason: f.kind, message: f.message, advice: f.advice, ...(f.action ? { action: f.action } : {}), ...(attempted ? {} : { attempted: false }) });
    if (f.scope === "task" && !stopping) {
      stopping = f;
      log.warn({ taskId: id, reason: f.kind }, `同步中止：${f.message}`);
      stop$.next();
    }
    return EMPTY;
  };
  const topAdvice = (): string | undefined => {
    const top = (Object.entries(failures) as Array<[FileFailureKind, number]>).filter(([k]) => adviceByKind[k]).sort((a, b) => b[1] - a[1])[0];
    return top ? adviceByKind[top[0]] : undefined;
  };
  const finish = (status: "completed" | "failed", fatal?: string) => {
    if (finishedRun) return;
    finishedRun = true;
    // 整轮停：没轮到的文件不算失败，结论是原因 + 建议 + 未尝试数
    const stopped: TaskStopInfo | undefined = stopping && status === "failed"
      ? { reason: stopping.kind, message: stopping.message, advice: stopping.advice, remaining: Math.max(0, total - finished.size - failedFiles.length) }
      : undefined;
    const summary = failedFiles.length > 0 ? summarizeFailures(failures, failedFiles) : undefined;
    const message = stopped ? `${stopped.message}；${stopped.advice}${stopped.remaining > 0 ? `（未尝试 ${stopped.remaining} 个）` : ""}` : (fatal ?? summary);
    // 流本身炸了（fatal）时别把之前个别文件的建议挂上去，那和死因无关
    const advice = stopped ? stopped.advice : fatal ? undefined : topAdvice();
    void notify({
      type: "task-done", task, status, total, finished: finished.size, failed: failedFiles.length,
      durationMs: Date.now() - execution.startTime, message, advice: stopped ? undefined : advice,
    });
    pushLog({
      done: true, status, total, finished: finished.size, failed: failedFiles.length,
      overallPercent: overall(), message, ...(stopped ? { stopped } : {}), at: Date.now(),
    });
    // 落库的日志写不进去（磁盘满、库锁着）不能把收尾掐断，不然任务永远挂在 running
    try {
      history.flush();
    } catch (err) {
      log.warn({ err, taskId: id }, "执行日志落库失败");
    }
    subject.complete();
    completeTaskExecution(execution.id, status, {
      totalFiles: total, downloadedFiles: finished.size, failedFiles: failedFiles.length, errorMessage: message,
      ...(failedFiles.length > 0 ? { failures, recentFailures } : {}), ...(advice ? { advice } : {}), ...(stopped ? { stopped } : {}),
    });
    unregisterRunningTask(id);
  };
  // 取消（界面按钮、进程退出）时由 registry 调：退订已经中止了下载，这里只管把账记平
  running.onCancel = (reason) => {
    history.flush();
    completeTaskExecution(execution.id, "cancelled", {
      totalFiles: total, downloadedFiles: finished.size, failedFiles: failedFiles.length, errorMessage: reason,
      ...(recentFailures.length > 0 ? { recentFailures } : {}),
    });
    void notify({
      type: "task-done", task, status: "cancelled", total, finished: finished.size, failed: failedFiles.length,
      durationMs: Date.now() - execution.startTime, message: reason,
    });
  };

  // strm 只是写一个小文本文件，不限流；但几万个也别一口气全扔出去
  const strm$ = from(strmFiles).pipe(
    mergeMap(
      (filePath) =>
        downloadOrCreateStrm(`${originPath}/${filePath}`, path.join(saveDir, filePath), {
          asStrm: true,
          displayPath: filePath,
          strmPrefix,
          enablePathEncoding: task.enablePathEncoding,
        }).pipe(
          // 本地临时错误（打开文件数超限、NFS 抖一下）隔一秒再写一次；其余不重试
          retry({ count: 1, delay: (err: unknown) => (classifyFileFailure(err, { relPath: filePath, kind: "strm", provider }).retryable ? timer(1000) : throwError(() => err)) }),
          tap({ next: (p) => report(p, "strm"), complete: () => finishOne(filePath) }),
          catchError((err: unknown) => failOne(filePath, "strm", err)),
        ),
      32,
    ),
  );

  // 真正要下载的文件走账号级限流；取直链失败和下载失败都算这一个文件的失败。
  // 同时在管线里的文件数跟着设置走：下载并发那么多个在下，另有接口并发那么多个在取直链——
  // 再多只是让取好的直链干等下载槽位（以前写死 10，下载并发设得比它大也没用）
  const { requestConcurrency, downloadConcurrency } = throttleSettings();
  const download$ = from(downloadFiles).pipe(
    mergeMap(
      (filePath) =>
        defer(() => {
          // 取直链是 Promise，本身不认退订；挂上 signal，取消时进行中的接口请求掐断、排在限流器里的不再发
          const abort = new AbortController();
          return from(
            resolveDownload(`${originPath}/${filePath}`, account, accounts, { signal: abort.signal }),
          ).pipe(finalize(() => abort.abort()));
        }).pipe(
          // 夸克的直链要带 cookie 等头才取得到，其它类型 headers 为空
          mergeMap(({ url, headers }) =>
            downloadOrCreateStrmLimited(url, path.join(saveDir, filePath), account, {
              asStrm: false,
              displayPath: filePath,
              headers,
              provider,
            }),
          ),
          tap({ next: (p) => report(p, "download"), complete: () => finishOne(filePath) }),
          catchError((err: unknown) => failOne(filePath, "download", err)),
        ),
      downloadConcurrency + requestConcurrency,
    ),
  );

  // 两条一起跑完才算完成：以前 strm 那条不在订阅里，纯 strm 的任务会在文件还没写完时就报"完成"。
  // 整轮停（stop$）让 merge 直接 complete：进行中的下载随之退订，收尾和正常结束走同一处
  running.subscription = merge(strm$, download$).pipe(takeUntil(stop$)).subscribe({
    complete: () => {
      finish(failedFiles.length > 0 ? "failed" : "completed");
      // 失败的只是个别文件（或者整轮停在半路），写好的那些一样要让媒体库看到；开头清掉的本地多余文件也是
      if (finished.size > 0 || deleted > 0 || failedFiles.length === 0) refreshEmbyNow(stopping ? "同步中止" : "全量任务完成");
    },
    error: (err: Error) => {
      // 单个文件的失败都在上面接住了，走到这里是流本身出了意外
      pushLog({ error: err.message });
      finish("failed", err.message);
    },
  });
  // 退订（取消、进程退出）时把还没落库的行写掉；正常结束时上面已经 flush 过，这里是空操作
  running.subscription.add(() => history.flush());

  return {
    status: 200,
    body: {
      message: `${total} files to download`,
      taskId: id,
      executionId: execution.id,
      // 结构化的个数：别从上面那句英文里抠
      total,
      extraFilesCount: extraLocally.length,
      willDeleteExtraFiles: task.removeExtraFiles || false,
      warning,
    },
  };
}

