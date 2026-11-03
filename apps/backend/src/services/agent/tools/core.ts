/**
 * 基础工具：不属于任何工具集，只要有「查看」档就总是在。
 *   overview    一眼看全
 *   tasks_list  同步任务（别的工具都要引用任务）
 *   job_status  后台作业的进度和结果
 */
import { z } from "zod";
import type { TaskDefinition } from "@openstrm/shared";
import { listAccounts } from "../../../db/repositories/accounts.js";
import { listTasks } from "../../../db/repositories/tasks.js";
import { readAppSettings } from "../../../db/repositories/settings.js";
import { APP_VERSION } from "../../../lib/version.js";
import { copyBlockerFor } from "../../copy/paths.js";
import { KIND_LABEL, providerFor } from "../../drive/registry.js";
import { getLifeMonitorStatus } from "../../life/monitor.js";
import { listFollowups } from "../../offline/service.js";
import { listAttention } from "../../organize/run.js";
import { pansouConn } from "../../pansou/search.js";
import { getRunningTask, isTaskRunning, listRunningTaskIds } from "../../task/registry.js";
import { getLatestExecutions, queryTaskHistory } from "../../task-history.js";
import { SCOPE_LABEL } from "../access.js";
import { LOCAL_READ, ToolError, defineTool } from "../define.js";
import { fmtTime, openInUi, page } from "../format.js";
import { JOB_RETENTION_MS, getJob, jobSnapshot, viewJob, waitWithProgress } from "../jobs.js";
import { USAGE_NOTES } from "../instructions.js";
import { taskBrief } from "../resolve.js";
import { organizeUiPath, runBrief } from "./organize-view.js";
import { copyOverview, taskCopyView } from "./copy.js";
import { libraryOverview } from "./library.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** waitSeconds 的上限：客户端普遍 60 秒超时，Cloudflare 对源站 100 秒，留足余量 */
export const MAX_WAIT_SECONDS = 45;

/** 正在跑的任务的进度；还在拉目录树的是 starting */
export function runningState(task: TaskDefinition) {
  const run = getRunningTask(task.id);
  if (!run) return isTaskRunning(task.id) ? { state: "starting" as const } : null;
  const s = run.stats?.();
  return {
    state: "running" as const,
    executionId: run.executionId ?? null,
    ...(s ? { total: s.total, finished: s.finished, failed: s.failed, percent: `${s.percent}%` } : {}),
  };
}

export const overviewTool = defineTool({
  name: "overview",
  title: "总览",
  description:
    "一眼看全 OpenStrm 的现状：版本、网盘账号、正在跑的同步、网盘监控、要人管的整理（待确认的清单、有失败的，最近 5 条）、云下载待回执、「复制到 OpenList」配没配好和队列里在跑的 / 失败的、资源搜索配没配、收藏夹（收藏了几个分享、失效的、在建索引的、认出了几部作品）、最近 24 小时失败的同步，以及当前令牌的权限。开始干活前先调它。",
  scope: "read",
  toolset: null,
  annotations: LOCAL_READ,
  input: z.object({}),
  async run(_args, ctx) {
    const tasks = listTasks();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const life = getLifeMonitorStatus();
    const lifeByAccount = new Map(life.accounts.map((a) => [a.name, a]));

    const accounts = listAccounts().map((a) => {
      const p = providerFor(a);
      const mon = lifeByAccount.get(a.name);
      return {
        name: a.name,
        type: KIND_LABEL[p.kind],
        canShare: p.capabilities.share,
        canOffline: p.kind === "115",
        ...(mon ? { monitor: mon.running ? "运行中" : "未运行", ...(mon.lastError ? { monitorError: mon.lastError } : {}) } : {}),
      };
    });

    const running = listRunningTaskIds()
      .map((id) => byId.get(id))
      .filter((t): t is TaskDefinition => !!t)
      .map((t) => ({ task: taskBrief(t), ...runningState(t) }));

    const recentFailures = queryTaskHistory({ status: "failed", since: Date.now() - DAY_MS, limit: 5 })
      .rows.map((e) => {
        const t = byId.get(e.taskId);
        return {
          executionId: e.id,
          task: t ? taskBrief(t) : { id: e.taskId },
          at: fmtTime(e.startTime),
          error: e.summary.errorMessage ?? "",
          ...(e.summary.advice ? { advice: e.summary.advice } : {}),
        };
      });

    const attention = listAttention();
    return {
      version: APP_VERSION,
      token: { name: ctx.token.name, scopes: ctx.token.scopes.map((s) => SCOPE_LABEL[s]) },
      accounts,
      tasks: tasks.length,
      running,
      monitor: { running: life.running },
      organizePending: attention.length,
      // 要人管的整理（待确认的清单、有失败的……）：最近 5 条，更多用 organize_list
      ...(attention.length
        ? { organize: attention.slice(0, 5).map((a) => ({ ...runBrief(a.run, byId.get(a.run.taskId), { reason: a.reason }), ...openInUi(organizeUiPath(a.run.id)) })) }
        : {}),
      // 只数「下完生成 strm」的回执；「下完只复制到 OpenList」的不生成 strm，算在 openlistCopy.afterDownload 里
      offlinePendingStrm: listFollowups().filter((f) => f.status === "pending" && (f.kind ?? "strm") === "strm").length,
      // 只看设置和队列、不联网：失败的细节用 copy_list 看
      openlistCopy: copyOverview(),
      // 只看设置、不联网：没配置时 resource_search 调了也只会报错
      resourceSearch: { configured: pansouConn() !== null },
      // 收藏夹（收藏的分享）：几个分享、失效的、在抄的，认出了几部；是空的就不给
      ...withLibrary(libraryOverview()),
      recentFailures,
      notes: USAGE_NOTES,
      ...openInUi("/"),
    };
  },
});

const TASKS_LIMIT = 50;

const withCopy = (view: Record<string, unknown> | undefined) => (view ? { copyToOpenlist: view } : {});
const withLibrary = (view: Record<string, unknown> | undefined) => (view ? { library: view } : {});

export const tasksListTool = defineTool({
  name: "tasks_list",
  title: "同步任务列表",
  description:
    "列出同步任务：每个任务把一个网盘目录（drivePath）同步成本地的 strm 目录（localPath）。返回 id、label（界面上的叫法「账号 · 网盘路径」）、定时、是否开了 302、是否在跑、上次结果；开了「复制到 OpenList」或任务上填了复制目标目录的带 copyToOpenlist：enabled 开没开自动复制（开着的话转存、追更、云下载落进来的新文件会自动复制走）、复制到哪（dstDir；关着时 copy_add 和转存 / 云下载一次性要的复制也落在这里）、复制成功后源文件的去向（afterCopy：keep 不动 / delete 删除 / archive 挪进任务目录下的「归档」）、复制不了的原因（blocked：开着的不会自动复制，关着的一次性复制会被拒）。其它工具引用任务时可以传 id、网盘路径、本地路径或它们的最后一段。可用 query 按路径或账号过滤，最多返回 50 个。",
  scope: "read",
  toolset: null,
  annotations: LOCAL_READ,
  input: z.object({
    query: z.string().max(200).optional().describe("按网盘路径、本地路径或账号名过滤（包含即可），不填列出全部"),
  }),
  async run(args) {
    const q = args.query?.trim().toLowerCase() ?? "";
    const latest = getLatestExecutions();
    const settings = readAppSettings();
    const copyBlocker = copyBlockerFor(settings);
    const tasks = listTasks().filter(
      (t) => !q || [t.originPath, t.targetPath, t.account].some((v) => v.toLowerCase().includes(q)),
    );
    const rows = tasks.map((t) => {
      const last = latest.get(t.id);
      const live = runningState(t);
      return {
        ...taskBrief(t),
        accountType: t.accountType ?? null,
        cron: t.cronExpression || null,
        enable302: t.enable302 === true,
        removeExtraFiles: t.removeExtraFiles === true,
        ...withCopy(taskCopyView(t, copyBlocker, settings)),
        state: live?.state ?? "idle",
        lastRun: last
          ? {
              executionId: last.id,
              status: last.status,
              at: fmtTime(last.startTime),
              total: last.summary.totalFiles,
              done: last.summary.downloadedFiles,
              failed: last.summary.failedFiles ?? 0,
              ...(last.summary.errorMessage ? { error: last.summary.errorMessage } : {}),
            }
          : null,
      };
    });
    const { items, total, truncated } = page(rows, TASKS_LIMIT, "用 query 按路径或账号缩小范围。");
    return { tasks: items, total, ...(truncated ? { truncated } : {}) };
  },
});

export const jobStatusTool = defineTool({
  name: "job_status",
  title: "后台作业进度",
  description: `查后台作业（比如 share_save 转存后生成 strm）的进度和结果。waitSeconds 大于 0 时会等作业结束再返回，最多等这么久（上限 ${MAX_WAIT_SECONDS} 秒）；等不到就返回当前进度，可以再调一次接着等。作业结束后结果保留 ${JOB_RETENTION_MS / 60000} 分钟；服务重启后句柄失效，需要重新发起。`,
  scope: "read",
  toolset: null,
  annotations: LOCAL_READ,
  input: z.object({
    jobId: z.string().min(1).max(100).describe("发起作业的工具返回的 jobId"),
    waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe(`最多等几秒，0 到 ${MAX_WAIT_SECONDS}，不填就是 0（立刻返回）`),
  }),
  async run(args, ctx) {
    const job = getJob(args.jobId.trim());
    if (!job) {
      throw new ToolError("JOB_NOT_FOUND", `找不到作业 ${args.jobId}`, "作业结束超过一小时会被清掉，服务重启也会丢；需要的话重新发起。");
    }
    if (job.status === "running") await waitWithProgress(job.settled, (args.waitSeconds ?? 0) * 1000, ctx, () => jobSnapshot(job));
    return viewJob(job);
  },
});
