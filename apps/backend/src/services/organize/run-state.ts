/**
 * 整理的进程内状态和几个模块共用的小工具：依赖注入、内存里的 job、规划状态、统计、
 * 「能不能执行 / 撤销」的判定、失败分组。别的 run-*.ts 都 import 这里，这里不 import 它们。
 */
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { AppSettings, OrganizeItem, OrganizeProgress, OrganizeRun, OrganizeFailureGroup, OrganizeRunDetail, OrganizeRunStage, OrganizeRunStats, OrganizeTrigger, OrganizeUnit, TaskDefinition } from "@openstrm/shared";
import { emptyStats, getRun, laterRunTouching, listItems, listUnits, updateRun } from "../../db/repositories/organize.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { isAbortError } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { normalizePath } from "../drive/types.js";
import { releaseCopyHolds, type CopyMove } from "../copy/queue.js";
import { dstDirFor } from "../copy/paths.js";
import { extSet } from "../strm/naming.js";
import { notify } from "../notify.js";
import { messageOf, retryableItem, revertPendingItem, revertWorkItem } from "./failures.js";
import { TmdbClient, type TmdbApi, type TmdbClientOptions } from "./identify.js";
import { isLocalUnitKey, type LocalUnit } from "./local-naming.js";
import type { EpisodeFill, ScopeRoot } from "./plan.js";
import type { ResolvedOrganizeSettings } from "./settings.js";
import { AUDIO_EXTS, type ScopeEntry, type Unit } from "./units.js";

/** 整理挪完之后，复制待办的目标目录按新路径重算（层级跟着源走） */
export const copyLayout = (base: string, rootPath: string | undefined, srcPath: string): string => dstDirFor(base, rootPath, srcPath).dstDir;

export const log = moduleLogger("organize");

export const ORGANIZE_LIMITS = {
  /** 一次 run 最多看这么多文件 */
  MAX_FILES: 20_000,
  /** 内存里留的日志行数 */
  LOG_LINES: 300,
} as const;

/**
 * 人挑的范围：手动的、智能体替人发起的。范围照手动的规则来（选的是目录、要先确认网盘上有），
 * 其余来源给的是自动触发时新落进来的路径
 */
export const handPicked = (trigger: OrganizeTrigger): boolean => trigger === "manual" || trigger === "agent";

/* ------------------------------- 依赖注入 ------------------------------- */

interface Deps {
  /** opts.fresh：详情和季集跳过缓存（刷新 TMDB 信息） */
  tmdb: (settings: AppSettings, opts?: TmdbClientOptions) => TmdbApi | null;
  notify: typeof notify;
  /** 临时失败（网络 / 超时）自动重试前等多久；测试里调短 */
  retryDelayMs: number;
}

const realDeps: Deps = {
  tmdb: (settings, opts) => {
    const key = settings.tmdb?.apiKey?.trim();
    return key ? new TmdbClient(key, settings.tmdb?.language || "zh-CN", opts) : null;
  },
  notify,
  retryDelayMs: 3000,
};

export let deps: Deps = { ...realDeps };

/** 仅供测试：换掉 TMDB / 通知 / 重试间隔；传 null 恢复 */
export function setOrganizeDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 内存里的 job ------------------------------- */

export interface Job {
  runId: string;
  abort: AbortController;
  progress: OrganizeProgress;
  logs: string[];
  done: Promise<void>;
}

export const jobs = new Map<string, Job>();

/**
 * 不是后台 job 的写操作（预览里改单元、放弃失败项）进行中的个数。它们中间要等 TMDB / 列目录 / 改回原名，
 * 这段时间里执行 / 撤销 / 删除要等它们落完库：不然执行拿着旧清单跑，改单元回来把清单整个换掉，执行的记账全落空
 */
const runOps = new Map<string, number>();

export function beginOp(runId: string): () => void {
  runOps.set(runId, (runOps.get(runId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (runOps.get(runId) ?? 1) - 1;
    if (left > 0) runOps.set(runId, left);
    else runOps.delete(runId);
  };
}

export function assertNoOps(runId: string): void {
  if (runOps.has(runId)) throw new HttpError(409, "这次整理还有修改在保存，稍等再试");
}

export function jobLog(job: Job, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  job.logs.push(line);
  if (job.logs.length > ORGANIZE_LIMITS.LOG_LINES) job.logs.shift();
  log.info({ runId: job.runId }, msg);
}

export function setProgress(job: Job, phase: OrganizeProgress["phase"], done: number, total: number, message: string): void {
  job.progress = { phase, done, total, message };
}

/** 仅供测试：等一个 run 的后台工作结束 */
export async function waitForRun(runId: string): Promise<void> {
  const job = jobs.get(runId);
  if (job) await job.done;
}

export function isRunBusy(runId: string): boolean {
  return jobs.has(runId);
}

/** 这次 run 的后台工作（预览 / 执行 / 撤销）什么时候结束；没有在跑的是 undefined。智能体限时等结果用 */
export function runDone(runId: string): Promise<void> | undefined {
  return jobs.get(runId)?.done;
}

/** 这次 run 的后台工作现在的进度（每次都读最新的） */
export function runProgress(runId: string): OrganizeProgress | undefined {
  return jobs.get(runId)?.progress;
}

/* ------------------------------- 小工具 ------------------------------- */

export const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export const joinRel = (a: string, b: string): string => (a && b ? `${a}/${b}` : a || b);

/**
 * 相对任务 originPath 的路径 → 网盘绝对路径。只拼、不动每一段的内容：
 * normalizePath 会把每段首尾的空格削掉（`凡人修仙传/Season 1 ` 这种网盘上真实存在的名字），
 * 那样 abs → rel 就回不到原来的路径，按文件勾选 / 冲突处理（都按绝对路径记）会对不上号
 */
export function absOf(task: TaskDefinition, rel: string): string {
  const origin = normalizePath(task.originPath);
  return rel ? `${origin === "/" ? "" : origin}/${rel.replace(/^\/+/, "")}` : origin;
}

/** 网盘绝对路径 → 相对任务 originPath；和 absOf 严格互逆（段里的空格照原样留着） */
/** 网盘绝对路径 → 相对任务 originPath；不在任务目录下的去掉开头的 / 原样给 */
export function relOf(task: TaskDefinition, abs: string): string {
  const origin = normalizePath(task.originPath);
  const p = abs.startsWith("/") ? abs : `/${abs}`;
  if (p === origin) return "";
  return p.startsWith(`${origin === "/" ? "" : origin}/`) ? p.slice(origin === "/" ? 1 : origin.length + 1) : p.replace(/^\//, "");
}

export function videoExtsOf(settings: AppSettings): Set<string> {
  const all = extSet(settings.strmExtensions);
  for (const a of AUDIO_EXTS) all.delete(a);
  return all;
}

/** 单元算不算「排上了」：勾选且识别出来；按本地 strm 结构的单元没有识别这一步，勾选就算 */
export const unitActive = (u: Pick<OrganizeUnit, "key" | "selected" | "match">): boolean => u.selected && (!!u.match || isLocalUnitKey(u.key));

export function computeStats(units: OrganizeUnit[], items: OrganizeItem[], stage: OrganizeRunStage): OrganizeRunStats {
  const stats = emptyStats();
  stats.units = units.length;
  for (const u of units) stats.confidence[u.match?.confidence ?? "none"]++;
  const selectedUnits = new Set(units.filter(unitActive).map((u) => u.key));
  for (const it of items) {
    if (it.kind !== "dir") stats.items++;
    const active = it.unitKey === "" || selectedUnits.has(it.unitKey);
    if (it.action === "conflict") stats.conflicts++;
    else if (it.action === "skip") stats.skipped++;
    else if (it.action === "keep") stats.keep++;
    else if (active) {
      stats.planned++;
      if (it.action === "mkdir") stats.plannedMkdir++;
      else if (it.action === "rmdir") stats.plannedRmdir++;
      else if (it.action === "delete") stats.plannedDelete++;
    }
    if (it.status === "done") stats.done++;
    if (it.status === "failed") stats.failed++;
    if (it.status === "reverted") stats.reverted++;
    if (it.givenUp) continue;
    // 还没做的：勾选了、会动网盘的 pending 项（中途停下的 run 里就是「没做完」的）
    if (it.status === "pending" && active && WORK_ACTIONS.has(it.action)) stats.pending++;
    // 还等着处理的失败：failed 按各自类别（旧数据没分类的算临时）；done / reverted 带类别的是镜像没跟上或撤销在网盘那步失败
    if (it.status === "failed") stats.failedByKind[it.errorKind || "transient"]++;
    else if ((it.status === "done" || it.status === "reverted") && it.errorKind) stats.failedByKind[it.errorKind]++;
    // 撤销阶段：仍在整理后位置的 done、撤销时发现找不到的 failed（stale，撤销给它记了 finishedAt）都是没退回；
    // 执行时就没成的 failed（没 finishedAt）文件还在原处，不算
    if (stage === "revert" && (it.action === "rename" || it.action === "move") && (it.status === "done" || (it.status === "failed" && it.errorKind === "stale" && it.finishedAt !== null))) stats.notReverted++;
  }
  return stats;
}

/**
 * 每次 run 建出来的那一刻（毫秒）：放行压着的复制时按它比「在这次整理开始之前登记的」。
 * 库里的 created_at 只到秒，按秒比会把同一秒里、整理开始之后才登记的复制也提前放掉（那些要等下一次整理）。
 * 进程重启就没了，那时退回按秒比
 */
export const runStartedAt = new LRUCache<string, number>({ max: 1000 });

/**
 * onAbort：执行 / 撤销被取消时的收尾。取消多半发生在网盘请求中途、异常从 work 里抛出来，
 * 做完的项照样要进统计、收尾照常；预览没有收尾，取消了直接标 cancelled
 */
export function startJob(runId: string, work: (job: Job) => Promise<void>, onAbort?: (job: Job) => void): Job {
  const job: Job = {
    runId,
    abort: new AbortController(),
    progress: { phase: "idle", done: 0, total: 0, message: "" },
    // 接着这次 run 已有的日志往下写：预览 → 执行 → 重试 → 撤销是一本账，后一次别把前一次的冲掉（落库时只留最近 300 行）
    logs: [...(getRun(runId)?.log ?? [])].slice(-ORGANIZE_LIMITS.LOG_LINES),
    done: Promise.resolve(),
  };
  jobs.set(runId, job);
  job.done = work(job)
    .catch((err) => {
      const aborted = isAbortError(err) || job.abort.signal.aborted;
      if (aborted && onAbort) {
        try {
          onAbort(job);
          return;
        } catch (e) {
          log.warn({ err: e, runId }, "取消后的收尾失败，按取消记");
        }
      }
      const msg = aborted ? "已取消" : messageOf(err);
      jobLog(job, `失败：${msg}`);
      const run = getRun(runId);
      if (run && (run.status === "planning" || run.status === "applying" || run.status === "reverting")) {
        updateRun(runId, {
          status: job.abort.signal.aborted ? "cancelled" : "failed",
          error: msg,
          log: job.logs,
          finishedAt: Math.floor(Date.now() / 1000),
        });
      }
      // 整理没办成：等它的复制别再干等兜底时间
      if (run) releaseHeldCopies(run);
    })
    .finally(() => {
      jobs.delete(runId);
    });
  return job;
}

/** 本地镜像只看同一账号的任务：不同网盘上同名的目录（都叫 tv）各有各的本地目录，按路径匹配会串到别的账号的任务上 */
export const accountTasks = (accountName: string): TaskDefinition[] => listTasks().filter((t) => t.account === accountName);

export interface PlanState {
  task: TaskDefinition;
  settings: AppSettings;
  org: ResolvedOrganizeSettings;
  entries: ScopeEntry[];
  roots: string[];
  units: Map<string, Unit>;
  episodeTitles: Map<string, Map<string, string>>;
  /** 识别阶段留给单元的提示（nfo 证据没采用之类）：重新规划时和规划的提示拼在一起；手动换了匹配就清掉 */
  identifyNotes: Map<string, string[]>;
  /** 删空目录的边界（见 finalizeItems 的 scopeRoots） */
  scopeRoots: ScopeRoot[];
  /** 这次预览已经去网盘看过的范围外目录（在的列过了、不在的也记着）：重规划时不再重复列 */
  listed: Set<string>;
  /** 手动 / 智能体发起的：只有它们会删范围外、腾空了的作品目录（见 cleanupRoots） */
  handPicked: boolean;
  /** 分单元的范围（unitScopesOf），算单元的引用数用 */
  scopes: string[];
  /** 追更 / 云下载回执 / 复制队列指着的路径（相对任务 originPath），算单元的引用数用 */
  refPaths: string[];
  /** 待兑现的云下载回执指着的目录（相对任务 originPath）：腾空了也不删 */
  offlineRefs: string[];
  /** 同账号别的任务的根目录（网盘绝对路径）：它们和装着它们的目录都不删 */
  otherTaskRoots: string[];
  /** 越到范围外、整棵列过的单元根（里面有什么都知道了，腾空后能判断删不删，见 cleanupRoots） */
  outsideRoots: Set<string>;
  /** 单元的补空值（记住的识别、追更上次的整理，见 plan.ts 的 EpisodeFill）：重规划照用；人换了匹配就清掉，那是上一部作品的 */
  fills: Map<string, EpisodeFill>;
  /** 按本地 strm 结构整理的 run（naming = local）：每个单元的文件映射，规划不走 planUnit 走 planLocalUnit；tmdb 的 run 没有 */
  local?: Map<string, LocalUnit>;
}

export const planContext = (state: PlanState) => ({ settings: state.org, libraryType: state.task.organize?.libraryType });

/** 合并条目，按路径去重；同一路径留带 id 的那份（115 整棵列只有路径，单独列目录才有 id，覆盖 / 删除时要按 id 核对） */
export function mergePreferId(base: ScopeEntry[], extra: ScopeEntry[]): ScopeEntry[] {
  if (extra.length === 0) return base;
  const byPath = new Map(base.map((e) => [e.path, e]));
  for (const e of extra) {
    const had = byPath.get(e.path);
    if (!had || (!had.id && e.id)) byPath.set(e.path, e);
  }
  return [...byPath.values()];
}

/** 把新列到的条目并进本轮已知的条目 */
export function mergeEntries(state: PlanState, extra: ScopeEntry[]): void {
  state.entries = mergePreferId(state.entries, extra);
}

/** 内存里的 run 状态：单元结构（Unit）不落库，改匹配重新规划时要用；进程重启后 run 只能看和执行，不能再改 */
export const planStates = new Map<string, PlanState>();

/**
 * 清单内容的指纹：人点头的是哪一版，执行的就是哪一版（智能体执行前核对）。只看会改变执行结果的东西——
 * 单元的勾选、匹配、季、偏移、排除、冲突办法、改的标题 / 年份、钉的季集、改的文件名，各项的动作和 src → dst；不看 id、时间、「记住」
 */
export function planFingerprint(runId: string, known?: { units: OrganizeUnit[]; items: OrganizeItem[] }): string {
  const h = createHash("sha1");
  for (const u of known?.units ?? listUnits(runId)) {
    h.update(
      JSON.stringify([
        u.key,
        u.selected,
        u.match?.mediaType ?? null,
        u.match?.tmdbId ?? null,
        u.seasonOverride,
        u.episodeOffset,
        [...u.excluded].sort(),
        Object.entries(u.resolutions ?? {}).sort(),
        u.titleOverride ?? "",
        u.yearOverride ?? "",
        Object.entries(u.pins ?? {}).sort(),
        Object.entries(u.renames ?? {}).sort(),
        Object.entries(u.kinds ?? {}).sort(),
      ]),
    );
  }
  for (const it of known?.items ?? listItems(runId)) h.update(JSON.stringify([it.action, it.kind, it.srcPath, it.dstPath]));
  return h.digest("hex").slice(0, 10);
}

/** 会在网盘上动手的动作 */
export const WORK_ACTIONS = new Set<OrganizeItem["action"]>(["mkdir", "rename", "move", "rmdir", "delete"]);

/** 只有勾选且识别出来的单元的项才动；目录项（unitKey 为空）随时动 */
export function activeItemFilter(runId: string, known: OrganizeUnit[] = listUnits(runId)): (it: OrganizeItem) => boolean {
  const units = new Map(known.map((u) => [u.key, u]));
  return (it) => {
    if (it.unitKey === "") return true;
    const u = units.get(it.unitKey);
    return !!u && unitActive(u);
  };
}

/** 移动项在源目录里的中间名字（先原地改名再挪）；同名的没有 */
export const intermediateOf = (it: OrganizeItem): string | undefined => (it.action === "move" && baseOf(it.srcPath) !== baseOf(it.dstPath) ? `${dirOf(it.srcPath)}/${baseOf(it.dstPath)}` : undefined);

interface DirMapping {
  from: string;
  to: string;
  /** 单元根 → 作品目录（识别记忆跟着挪的只有这种） */
  root: boolean;
  /** 这条映射下挪过的文件项：撤销时一个都没退回（源目录还不在）就不把落点改回去 */
  items: OrganizeItem[];
}

/**
 * 整理把目录腾空删掉后，追更 / 云下载回执的落点要跟过去的映射（撤销时反过来用）：
 *   - 腾空删掉的单元根（剧目录 / 发布目录）→ 作品目录；
 *   - 腾空删掉的其它目录，里面直接放着的项都挪进了同一个目录（`某剧/season2` → `作品目录/Season 02`）→ 那个目录。
 *     范围直接选在季目录上时单元根是上一级、不会被删，指着这个季目录的追更靠这一条跟过去。
 * 长的 from 排在前面：改写取第一个命中的，`某剧/season2` 要先于 `某剧`
 */
export function dirMappings(task: TaskDefinition, units: OrganizeUnit[], items: OrganizeItem[], removed: Set<string>): DirMapping[] {
  const out: DirMapping[] = [];
  const isFile = (it: OrganizeItem) => it.action === "rename" || it.action === "move";
  for (const u of units) {
    if ((u.match || isLocalUnitKey(u.key)) && u.dstRoot && u.rootPath && removed.has(u.rootPath) && u.rootPath !== u.dstRoot) {
      out.push({ from: u.rootPath, to: u.dstRoot, root: true, items: items.filter((it) => it.unitKey === u.key && isFile(it)) });
    }
  }
  const roots = new Set(out.map((m) => m.from));
  const targets = new Map<string, { to: Set<string>; items: OrganizeItem[] }>();
  for (const it of items) {
    if (it.action !== "move") continue;
    const from = dirOf(relOf(task, it.srcPath));
    if (!removed.has(from) || roots.has(from)) continue;
    const t = targets.get(from) ?? { to: new Set<string>(), items: [] };
    t.to.add(dirOf(relOf(task, it.dstPath)));
    t.items.push(it);
    targets.set(from, t);
  }
  for (const [from, t] of targets) if (t.to.size === 1) out.push({ from, to: [...t.to][0], root: false, items: t.items });
  return out.sort((a, b) => b.from.length - a.from.length);
}

/** 这次真正挪过 / 改过名的文件（任务相对路径）；撤销时反过来：已退回的项从目标回到原处 */
export function movedFiles(task: TaskDefinition, items: OrganizeItem[], how: "done" | "reverted"): CopyMove[] {
  return items
    .filter((it) => (it.action === "rename" || it.action === "move") && it.status === how)
    .map((it) =>
      how === "done"
        ? { from: relOf(task, it.srcPath), to: relOf(task, it.dstPath) }
        : { from: relOf(task, it.dstPath), to: relOf(task, it.srcPath) },
    );
}

/**
 * 自动整理这次到头了（执行完、没有要动的、留着等人确认、失败或取消）：
 * 在它开始之前登记、为等它而压着的复制放行。开始时间按毫秒记着的就按毫秒比；
 * 进程重启过、只剩库里到秒的 createdAt 时，同一秒登记的也算进来
 */
export function releaseHeldCopies(run: Pick<OrganizeRun, "id" | "taskId" | "createdAt">): void {
  const n = releaseCopyHolds(run.taskId, runStartedAt.get(run.id) ?? (run.createdAt + 1) * 1000);
  if (n > 0) log.info({ taskId: run.taskId, released: n }, "自动整理办完，放行压着的复制");
}

/**
 * 能不能（再）执行。ready 的执行全部；done / failed / cancelled 的重试失败和没做的项（默认只重试临时失败，
 * stale / rejected 要用户点名）；开始撤销的 run 不能再执行。count 是会做的项数
 */
export function applicability(run: OrganizeRun, ids?: string[], known?: { items: OrganizeItem[]; units: OrganizeUnit[] }): OrganizeRunDetail["applicable"] {
  if (run.stage === "revert") return { ok: false, reason: "这次整理已经开始撤销，只能继续撤销", count: 0 };
  if (run.status === "ready") return run.stats.planned > 0 ? { ok: true, count: run.stats.planned, deletes: run.stats.plannedDelete } : { ok: false, reason: "没有要动的项", count: 0 };
  if (!["done", "failed", "cancelled"].includes(run.status)) return { ok: false, reason: `当前状态（${run.status}）不能执行`, count: 0 };
  const all = known?.items ?? listItems(run.id);
  // 从没执行过的（待执行的预览被取消 / 被新的预览取代）：所有项都是 pending，那不是「没做完」，要执行就重新预览
  if (!all.some((it) => it.attempts > 0)) return { ok: false, reason: "这次预览没有执行过；要执行请重新预览", count: 0 };
  const active = activeItemFilter(run.id, known?.units);
  const items = all.filter(active);
  const deletesIn = (list: OrganizeItem[]) => list.filter((it) => it.action === "delete").length;
  if (ids) {
    const set = new Set(ids);
    const picked = items.filter((it) => set.has(it.id) && retryableItem(it, true));
    return picked.length > 0 ? { ok: true, count: picked.length, deletes: deletesIn(picked) } : { ok: false, reason: "这些项没有可以重试的", count: 0 };
  }
  // 「目录不是空的」这种顺带再看一眼的 rmdir 不算有事可做，也不进按钮上的数字
  const retry = items.filter((it) => retryableItem(it) && !(it.action === "rmdir" && it.status === "skipped"));
  if (retry.length === 0) return { ok: false, reason: "没有要重试的项", count: 0 };
  return { ok: true, count: retry.length, deletes: deletesIn(retry) };
}

/* ------------------------------- 撤销 ------------------------------- */

export function revertability(run: OrganizeRun, items: OrganizeItem[] = listItems(run.id)): OrganizeRunDetail["revertable"] {
  if (!["done", "failed", "cancelled", "reverted"].includes(run.status)) return { ok: false, reason: "只有执行过的整理能撤销" };
  // 没执行过文件的不用撤；撤销中断过的连没删的自建目录也算还有事
  if (!items.some((it) => (run.stage === "revert" ? revertWorkItem(it) : revertPendingItem(it)))) {
    if (run.stage !== "revert" && items.some((it) => it.action === "delete" && it.status === "done")) return { ok: false, reason: "这次整理只删了文件，删掉的退不回来（在网盘回收站里找）" };
    return { ok: false, reason: run.stage === "revert" ? "已经全部退回" : "这次整理没有改动任何文件" };
  }
  // 后面的整理动过这次挪好的文件：文件已经被它挪走了，得先撤它。不相干的后续整理（别的目录、自动整理的新一集）不挡
  const blocker = laterRunTouching(run);
  if (blocker) return { ok: false, reason: "后面的一次整理又动过这次整理挪好的文件，先撤销那一次", blockedBy: blocker };
  return { ok: true };
}

/**
 * 失败面板的分组，按「下一步该做什么」分；和 retryableItem / skipItems 的规则同源，前端只管文案和按钮。
 * 执行阶段：failed 按类别（stale 可以重新预览）、done 但本地没跟上（mirror）、没轮到的 pending；
 * 撤销阶段：网盘那步失败的 done 按类别（挪回了没改名的不能放弃，记在 held）、撤销时找不到的（lost）、已退回但本地没跟上（mirror）
 */
export function failureGroups(run: OrganizeRun, items: OrganizeItem[], units: OrganizeUnit[]): OrganizeFailureGroup[] {
  if (!["done", "failed", "cancelled", "reverted"].includes(run.status)) return [];
  const selected = new Set(units.filter(unitActive).map((u) => u.key));
  const active = (it: OrganizeItem) => it.unitKey === "" || selected.has(it.unitKey);
  const isFile = (it: OrganizeItem) => it.action === "rename" || it.action === "move";
  const live = items.filter((it) => !it.givenUp);
  const groups: OrganizeFailureGroup[] = [];
  const push = (key: OrganizeFailureGroup["key"], list: OrganizeItem[], actions: Partial<Pick<OrganizeFailureGroup, "retry" | "skip" | "repreview">>, held = 0) => {
    if (list.length === 0) return;
    // 撤销阶段的组里不会有删除项（删掉的退不回来，不进撤销）
    const deletes = list.filter((it) => it.action === "delete").length;
    groups.push({ key, itemIds: list.map((it) => it.id), retry: false, skip: false, repreview: false, held, deletes, ...actions });
  };
  if (run.stage === "apply") {
    const failed = live.filter((it) => it.status === "failed" && active(it));
    for (const k of ["blocked", "transient", "stale", "rejected"] as const) push(k, failed.filter((it) => (it.errorKind || "transient") === k), { retry: true, skip: true, repreview: k === "stale" });
    push("mirror", live.filter((it) => it.status === "done" && it.errorKind === "mirror"), { retry: true, skip: true });
    // 没做完的只对执行过的 run 说：待执行的预览被取消 / 取代时所有项都是 pending，那不是「没做完」
    if (items.some((it) => it.attempts > 0)) push("pending", live.filter((it) => it.status === "pending" && active(it) && WORK_ACTIONS.has(it.action)), { retry: true, skip: true });
  } else {
    const stuck = live.filter((it) => it.status === "done" && isFile(it) && it.errorKind !== "" && it.errorKind !== "mirror");
    for (const k of ["blocked", "transient", "stale", "rejected"] as const) {
      const list = stuck.filter((it) => it.errorKind === k);
      push(k, list, { retry: true, skip: true }, list.filter((it) => it.curPath !== "").length);
    }
    push("lost", live.filter((it) => it.status === "failed" && it.errorKind === "stale" && isFile(it) && it.finishedAt !== null), { skip: true });
    push("mirror", live.filter((it) => it.status === "reverted" && it.errorKind === "mirror"), { retry: true, skip: true });
  }
  return groups;
}
