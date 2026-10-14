/**
 * 整理的编排层，路由只调这里。
 *
 *   createRun   建 run → 后台：列范围 → 分单元 → 识别（TMDB）→ 规划 → 落库，状态 ready
 *   patchUnit   预览里换匹配 / 改季 / 集偏移 / 勾选：重新规划这个单元，冲突检测整体重算
 *   applyRun    后台按顺序执行：补本地镜像 → mkdir → 改名 → 移动 → 本地镜像 → 逐条记账 → 删空目录 → 收尾；
 *               再执行只重试失败 / 没做的（临时失败默认重试，stale / rejected 要点名 ids）
 *   skipItems   把失败项标成「已放弃」让 run 收口（原地改了名的先改回原名）
 *   revertRun   按流水账逆序退回；开始撤销之后 run.stage = revert，只能继续撤销
 *
 * 失败分类见 failures.ts。项的状态只描述文件在哪（pending / failed 在原处或 curPath，done 在整理后的位置或 curPath，
 * reverted 在原处，failed + stale 是找不到了），失败原因和类别在 error / errorKind 里。
 * 进行中的 run 在内存里有一个 job（中止信号 + 进度 + 日志），进程重启后 applying / planning / reverting 的 run 标成 failed，
 * 可以再 apply / revert（做完的项跳过，剩下的接着来）。
 *
 * 代码按阶段拆在几个文件里：run-state（共用状态）、exec-ctx（网盘操作上下文）、preview、apply、revert、query；
 * 这里只做再导出，外面照旧从 run.js 拿。
 */
import type { OrganizeConfidence, OrganizeRun } from "@openstrm/shared";
import { deleteRun as deleteRunRow, getRun, getRunHints, updateRun } from "../../db/repositories/organize.js";
import { HttpError } from "../../lib/http-error.js";
import { jobs, assertNoOps, planStates } from "./run-state.js";
import { createRun } from "./preview.js";

export { ORGANIZE_LIMITS, handPicked, setOrganizeDeps, waitForRun, isRunBusy, runDone, runProgress, relOf, planFingerprint, applicability, revertability, failureGroups } from "./run-state.js";
export { createRun, readyRunsWithin, collapseStaleReadyRuns, patchPlan, patchUnit, patchUnits, patchItems, searchCandidates, lookupWork, lookupCandidate } from "./preview.js";
export type { CreateRunInput, PlanPatch, ItemsPatch } from "./preview.js";
export { applyRun, skipItems } from "./apply.js";
export { revertRun } from "./revert.js";
export { listRuns, getRunSummary, getRunDetail, listRunItems, listAttention, reconcileInterruptedRuns } from "./query.js";

export function cancelRun(runId: string): OrganizeRun {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  const job = jobs.get(runId);
  if (job) {
    job.abort.abort();
    return run;
  }
  if (run.status === "ready") {
    updateRun(runId, { status: "cancelled", finishedAt: Math.floor(Date.now() / 1000) });
    planStates.delete(runId);
  }
  return getRun(runId)!;
}

/**
 * 按原范围、原触发来源重新预览：建一个新的手动预览（不自动执行、不发待确认通知）。新增路径的 run 保留新增路径的语义，
 * 触发来源也照旧（界面上还是「转存 / 监控 …的 N 个新增路径」），追更带的识别提示也带过去
 */
export async function repreviewRun(runId: string): Promise<OrganizeRun> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  return createRun({
    taskId: run.taskId,
    subPath: run.scopePath,
    paths: run.scopePaths.length > 0 ? run.scopePaths : undefined,
    hints: getRunHints(runId),
    mode: "manual",
    trigger: run.trigger,
  });
}

export function deleteRun(runId: string): void {
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中，先取消");
  assertNoOps(runId);
  planStates.delete(runId);
  if (!deleteRunRow(runId)) throw new HttpError(404, "整理记录不存在");
}

/** 进程退出：把在跑的都掐掉 */
export function cancelAllRuns(): void {
  for (const job of jobs.values()) job.abort.abort();
}

/** 仅供测试：丢掉内存里的单元结构，模拟进程重启过 */
export function __test_dropPlanState(runId: string): void {
  planStates.delete(runId);
}

export type { OrganizeConfidence };
