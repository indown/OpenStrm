/**
 * 查询：列表、详情、要人管的整理；启动时对账中断的 run。
 */
import type { OrganizeAttention, OrganizeAttentionReason, OrganizeItem, OrganizeRun, OrganizeFailureGroupKey, OrganizeRunDetail, OrganizeRunSummary, OrganizeUnitCounts, OrganizeUnit } from "@openstrm/shared";
import { changedSince, getRun, listItems, listRuns as listRunRows, listRunsByStatus, listSkips, listUnits, updateRun } from "../../db/repositories/organize.js";
import { getTask } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { providerForTask } from "../drive/registry.js";
import type { DriveProvider } from "../drive/types.js";
import { retryableItem, revertWorkItem } from "./failures.js";
import { unitActive, ORGANIZE_LIMITS, handPicked, jobs, computeStats, planStates, WORK_ACTIONS, activeItemFilter, planFingerprint, releaseHeldCopies, applicability, revertability, failureGroups } from "./run-state.js";
import { afterApply } from "./apply.js";
import { afterRevert } from "./revert.js";

/* ------------------------------- 查询 ------------------------------- */

function withProgress(run: OrganizeRun): OrganizeRun {
  const job = jobs.get(run.id);
  return job ? { ...run, progress: job.progress, log: job.logs.slice(-ORGANIZE_LIMITS.LOG_LINES) } : run;
}

export function listRuns(opts: { taskId?: string; limit?: number; offset?: number } = {}): OrganizeRun[] {
  return listRunRows(opts).map(withProgress);
}

function summaryOf(run: OrganizeRun, units: OrganizeUnit[], items: OrganizeItem[]): OrganizeRunSummary {
  return {
    run: withProgress(run),
    // 待执行的清单带上指纹：页面执行时带回来，打开之后别人（智能体）改过就不执行，让人重新看一眼
    ...(run.status === "ready" ? { planVersion: planFingerprint(run.id, { units, items }) } : {}),
    groups: failureGroups(run, items, units),
    revertable: revertability(run, items),
    applicable: applicability(run, undefined, { items, units }),
    editable: run.status === "ready" && planStates.has(run.id),
    executed: items.some((it) => it.attempts > 0),
    outdated: outdatedOf(run),
  };
}

/** 执行 / 撤销进行中页面轮询它：run（含进度 / 日志）+ 分组 + 按钮开关，不带单元和项 */
export function getRunSummary(runId: string): OrganizeRunSummary {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  return summaryOf(run, listUnits(runId), listItems(runId));
}

/**
 * 单元卡上的数字：详情不带全部项（一次整理最多两万个文件），按单元数好。和单元卡、失败面板同一个口径：
 * 要处理 = 没放弃的 failed，或者 done / reverted 但带着类别（本地没跟上 / 撤销在网盘那步失败）；跳过里用户自己的选择（单元没勾选）不算
 */
function unitCounts(units: OrganizeUnit[], items: OrganizeItem[]): Record<string, OrganizeUnitCounts> {
  const selected = new Map(units.map((u) => [u.key, unitActive(u)]));
  const excluded = new Map(units.map((u) => [u.key, new Set(u.excluded)]));
  const out: Record<string, OrganizeUnitCounts> = {};
  for (const u of units) out[u.key] = { total: 0, changing: 0, conflicts: 0, skipped: 0, keep: 0, failed: 0, done: 0, reverted: 0, excluded: 0 };
  for (const it of items) {
    const c = out[it.unitKey];
    if (!c) continue; // 建目录 / 删空目录另算
    c.total++;
    if (excluded.get(it.unitKey)?.has(it.srcPath)) c.excluded++;
    else if (it.action === "rename" || it.action === "move") c.changing++;
    else if (it.action === "conflict") c.conflicts++;
    else if (it.action === "keep") c.keep++;
    else if (it.action === "skip" && selected.get(it.unitKey)) c.skipped++;
    if (it.status === "done") c.done++;
    if (it.status === "reverted") c.reverted++;
    if (!it.givenUp && (it.status === "failed" || ((it.status === "done" || it.status === "reverted") && it.errorKind !== ""))) c.failed++;
  }
  return out;
}

/** 详情里的单元不带候选的简介：页面用不上，几十部作品 × 八个候选的简介能占满一半的体积 */
const lightUnit = (u: OrganizeUnit): OrganizeUnit =>
  u.match?.candidates?.length ? { ...u, match: { ...u.match, candidates: u.match.candidates.map(({ overview: _overview, ...c }) => c) } } : u;

/** 这次 run 的范围里有哪些「不整理的目录」（设置现在的清单，不是预览当时的）：在范围里、或把整个范围罩住的都算 */
function skippedDirsOf(run: OrganizeRun): string[] {
  const task = getTask(run.taskId);
  if (!task) return [];
  const origin = `/${task.originPath.replace(/^\/+|\/+$/g, "")}`.replace(/\/+$/, "") || "";
  const scopes = run.scopePaths.length > 0 ? run.scopePaths : [run.scopePath];
  return listSkips(task.account)
    .map((s) => s.path)
    .filter((abs) => {
      if (!(abs === origin || abs.startsWith(`${origin}/`))) return false;
      const rel = abs.slice(origin.length).replace(/^\/+/, "");
      return scopes.some((sc) => sc === "" || rel === sc || rel.startsWith(`${sc}/`) || sc.startsWith(`${rel}/`) || rel === "");
    });
}

export function getRunDetail(runId: string): OrganizeRunDetail {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  const units = listUnits(runId);
  const items = listItems(runId);
  return {
    ...summaryOf(run, units, items),
    units: units.map(lightUnit),
    counts: unitCounts(units, items),
    dirCount: items.filter((it) => it.unitKey === "").length,
    skippedDirs: skippedDirsOf(run),
  };
}

/** 按需拉项：一个单元的（unitKey 为空是建目录 / 删空目录），或者失败面板的一组 */
export function listRunItems(runId: string, q: { unit?: string; group?: OrganizeFailureGroupKey }): OrganizeItem[] {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (q.group === undefined) return listItems(runId, q.unit ?? "");
  const items = listItems(runId);
  const group = failureGroups(run, items, listUnits(runId)).find((g) => g.key === q.group);
  if (!group) return [];
  const ids = new Set(group.itemIds);
  return items.filter((it) => ids.has(it.id));
}

const OLD_PREVIEW_S = 24 * 3600;

/** 待执行的预览是不是旧了：预览之后同任务又有整理 / 撤销落了盘，或者预览超过一天。执行不拦（执行前本来就逐项核对），页面提示重新预览 */
function outdatedOf(run: OrganizeRun): OrganizeRunDetail["outdated"] {
  if (run.status !== "ready") return undefined;
  const changed = changedSince(run.taskId, run.createdAt, run.id);
  if (changed) return { kind: "changed", at: changed.finishedAt, runId: changed.id };
  if (Math.floor(Date.now() / 1000) - run.createdAt > OLD_PREVIEW_S) return { kind: "old", at: run.createdAt };
  return undefined;
}

/** 待处理列表只看最近这么久建的 run（进行中 / 待执行的不限） */
const ATTENTION_WINDOW_S = 30 * 24 * 3600;

/** 一个 run 要不要人管、为什么 */
function attentionOf(run: OrganizeRun): OrganizeAttentionReason | null {
  if (run.status === "ready") return "ready";
  if (run.status === "planning" || run.status === "applying" || run.status === "reverting") return "busy";
  const k = run.stats.failedByKind;
  if (run.stage === "revert") return run.stats.notReverted > 0 || k.mirror > 0 ? "revert" : null;
  const failures = k.transient + k.blocked + k.stale + k.rejected + k.mirror;
  // 做了一半：做过一些（用户中途取消的另算，没做过就取消是他自己不要了）、或者中途停下的（风控 / 重启）
  if (failures > 0 || (run.stats.pending > 0 && (run.stats.done > 0 || run.status === "failed"))) return "failures";
  // 自动触发的预览失败了用户看不到；手动的当场就看到了
  if (run.status === "failed" && run.stats.items === 0 && !handPicked(run.trigger)) return "preview-failed";
  return null;
}

/** 跨任务列出要人管的 run（整理页的待处理列表、侧栏角标），新的在前；不带日志 */
export function listAttention(limit = 50): OrganizeAttention[] {
  const since = Math.floor(Date.now() / 1000) - ATTENTION_WINDOW_S;
  const seen = new Set<string>();
  const out: OrganizeAttention[] = [];
  const consider = (run: OrganizeRun) => {
    if (seen.has(run.id)) return;
    seen.add(run.id);
    const reason = attentionOf(run);
    if (reason) out.push({ run: { ...withProgress(run), log: [] }, reason });
  };
  for (const r of listRunsByStatus(["planning", "applying", "reverting", "ready"])) consider(r);
  for (const r of listRunRows({ limit: 200 })) if (r.createdAt >= since) consider(r);
  return out.sort((a, b) => b.run.createdAt - a.run.createdAt).slice(0, limit);
}

/** 进程重启：上次没跑完的 run 标失败，用户可以再执行 / 继续撤销（做完的项不会重做）；清单上已经没事可做的直接收口 */
export function reconcileInterruptedRuns(): number {
  const rows = listRunsByStatus(["planning", "applying", "reverting"]);
  for (const r of rows) {
    if (finalizeIfNothingLeft(r)) continue;
    updateRun(r.id, {
      status: "failed",
      error: r.status === "reverting" ? "进程重启，撤销中断了；可以继续撤销（已退回的项不会重做）" : "进程重启，中断了；可以重新执行（已完成的项不会重做）",
      // 统计按清单重算：中断前做完的项要算进去，不然页面和待处理列表还是上一次落库时的数
      stats: computeStats(listUnits(r.id), listItems(r.id), r.stage),
      finishedAt: Math.floor(Date.now() / 1000),
    });
  }
  return rows.length;
}

/**
 * 进程在最后一项做完、还没写 run 状态时重启：标成 failed 的话「没有要重试的项」，再也执行不了，收尾（追更目录改写、识别记忆）
 * 也永远不跑，还挡着前一次整理的撤销。所以清单上没事可做的按正常结束收口
 */
function finalizeIfNothingLeft(run: OrganizeRun): boolean {
  if (run.status !== "applying" && run.status !== "reverting") return false;
  const task = getTask(run.taskId);
  if (!task) return false;
  const items = listItems(run.id);
  const units = listUnits(run.id);
  let provider: DriveProvider;
  try {
    provider = providerForTask(task, "write");
  } catch {
    return false;
  }
  const finishedAt = Math.floor(Date.now() / 1000);
  if (run.status === "applying") {
    const active = activeItemFilter(run.id, units);
    if (items.some((it) => active(it) && retryableItem(it) && !(it.action === "rmdir" && it.status === "skipped"))) return false;
    if (!items.some((it) => it.status === "done" && WORK_ACTIONS.has(it.action))) return false;
    updateRun(run.id, { status: "done", error: "", stats: computeStats(units, items, "apply"), finishedAt });
    afterApply(task, provider, units, items);
    releaseHeldCopies(run);
  } else {
    if (items.some((it) => revertWorkItem(it))) return false;
    updateRun(run.id, { status: "reverted", error: "", stats: computeStats(units, items, "revert"), finishedAt });
    afterRevert(task, provider, units, items);
  }
  planStates.delete(run.id);
  return true;
}
