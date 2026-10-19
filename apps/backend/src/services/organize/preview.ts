/**
 * 预览：建 run → 列范围 → 分单元 → 识别（TMDB）→ 规划 → 落库；预览里改单元 / 换匹配；换匹配弹框的 TMDB 搜索。
 */
import { randomUUID } from "node:crypto";
import type { OrganizeKindOverride, OrganizeEpisodePin, OrganizeProbeResult, MediaProbeTags, OrganizeNaming, OrganizeCandidate, OrganizeConflictResolution, OrganizeHint, OrganizeItem, OrganizeMatch, OrganizeMatchMemory, OrganizeMediaType, OrganizeRun, OrganizeRunMode, OrganizeRunStats, OrganizeSeasonInfo, OrganizeTrigger, OrganizeUnit, OrganizeUnitPatch, TaskDefinition } from "@openstrm/shared";
import { getAll as listLibraryEntries } from "../../db/repositories/media-library.js";
import { getRun, getRunHints, getUnit, insertRun, listItems, listRunsByStatus, listUnits, recallMatch, replaceItems, replaceUnits, updateRun, updateUnit, type NewItem } from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { listTasks, getTask } from "../../db/repositories/tasks.js";
import { isAbortError } from "../../lib/errors.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { resolveInDataDir } from "../../paths.js";
import { driveErrorToHttp } from "../drive/errors.js";
import { providerForTask } from "../drive/registry.js";
import { normalizePath, splitPath, type DriveNode, type DriveProvider } from "../drive/types.js";
import { rewriteOfflineSubPaths } from "../offline/service.js";
import { rewriteFollowSubPaths } from "../follow/service.js";
import { rewriteCopyPaths } from "../copy/queue.js";
import type { TmdbDetails, TmdbSearchResult } from "../tmdb.js";
import { messageOf } from "./failures.js";
import { idTagFromName, identifyUnit, type IdEvidence, type KnownId, type TmdbApi } from "./identify.js";
import { nfoEvidence } from "./nfo.js";
import { hintFor, hintSource } from "./hints.js";
import { duplicatePathFor, isStagingDir } from "../strm/staging.js";
import { type UnitPlanInput, finalizeItems, planUnit, type EpisodeFill, type PlannedItem, type ScopeRoot, type UnitPlan } from "./plan.js";
import { indexLocalStrm, mapLocalStrm, planLocalUnit, toSyntheticUnit } from "./local-naming.js";
import { cachedProbeTags, probeDriveFile, probeSummary, probeTags, type ProbeTarget } from "../media/probe.js";
import { isTaskRunning } from "../task/registry.js";
import { parseRules } from "./rules.js";
import { resolveOrganizeSettings } from "./settings.js";
import { isNamedAfter, looksLikeReleaseDir } from "./parse-name.js";
import { looksLikeFileName } from "../drive/walk.js";
import { type UnitFile, buildUnits, type ScopeEntry, type Unit } from "./units.js";
import { log, ORGANIZE_LIMITS, handPicked, deps, type Job, beginOp, jobLog, setProgress, baseOf, dirOf, joinRel, absOf, relOf, videoExtsOf, computeStats, runStartedAt, startJob, type PlanState, planContext, mergePreferId, mergeEntries, planStates, releaseHeldCopies, accountTasks } from "./run-state.js";
import { applyRun } from "./apply.js";

/* ------------------------------- 建 run ------------------------------- */

export interface CreateRunInput {
  taskId: string;
  /** 相对任务 originPath 的范围目录 */
  subPath?: string;
  /** 只整理这些路径（相对任务 originPath）；自动触发时用 */
  paths?: string[];
  /** 新文件带的识别提示（追更给的，见 hints.ts）；重新预览把原来的带过来 */
  hints?: OrganizeHint[];
  mode?: OrganizeRunMode;
  trigger?: OrganizeTrigger;
  /** 刷新 TMDB 信息：这次预览每部作品的详情和季集都跳过缓存重新向 TMDB 拉（作品多会慢） */
  refreshTmdb?: boolean;
  /** 命名来源：默认按 TMDB 识别 + 模板；local 按本地 strm 的目录结构（只有手动模式） */
  naming?: OrganizeNaming;
}

export async function createRun(input: CreateRunInput): Promise<OrganizeRun> {
  const task = getTask(input.taskId);
  if (!task) throw new HttpError(404, `Task not found: ${input.taskId}`);
  const provider = providerForTask(task, "write");
  const settings = readAppSettings();
  const naming: OrganizeNaming = input.naming ?? "tmdb";
  if (naming === "tmdb" && !deps.tmdb(settings)) throw new HttpError(400, "TMDB 未配置 apiKey，请先在设置中填入");
  if (naming === "local") {
    // 只有手动：按本地结构没有「把握大小」可言，不自动执行；同步正在改同一棵树（会把改过名的 strm 当多余删掉）时不做
    if (input.mode && input.mode !== "manual") throw new HttpError(400, "按本地 strm 结构整理只能手动预览", { code: "LOCAL_MANUAL_ONLY" });
    if (isTaskRunning(task.id)) throw new HttpError(409, "任务正在同步，等它结束再按本地结构整理", { code: "TASK_SYNCING" });
  }
  const rules = parseRules(resolveOrganizeSettings(settings).rules);
  if (rules.errors.length > 0) throw new HttpError(400, `识别词有语法错误：${rules.errors.join("；")}`);
  const scopePath = splitPath(input.subPath ?? "").join("/");
  let scopePaths = [...new Set((input.paths ?? []).map((p) => splitPath(p).join("/")).filter(Boolean))];
  // 范围只能是任务目录之内：`..` 会让本地镜像跑出数据目录
  for (const p of [scopePath, ...scopePaths]) {
    if (splitPath(p).some((seg) => seg === "." || seg === "..")) throw new HttpError(400, `范围路径不合法：${p}`);
  }
  // 提示只按路径对文件，路径不合法的直接丢掉，同一个文件留最后一条
  const hints = [...new Map((input.hints ?? []).map((h) => [splitPath(h.path).join("/"), h] as const)).entries()]
    .filter(([p]) => p && !splitPath(p).some((seg) => seg === "." || seg === ".."))
    .map(([path, h]) => ({ ...h, path }));
  const trigger = input.trigger ?? "manual";
  if (handPicked(trigger)) {
    // 手动选的多个范围：套在别的范围里面的去掉（已经整个包含了）
    scopePaths = scopePaths.filter((p) => !scopePaths.some((o) => o !== p && p.startsWith(`${o}/`)));
    // 手动的范围要是网盘上真有的目录，不然要等预览失败才知道（自动整理的新增路径不在就跳过，照旧）。
    // 在查重和建 run 之前做：那两步之间不能有 await
    for (const p of scopePaths.length > 0 ? scopePaths : scopePath ? [scopePath] : []) {
      const abs = absOf(task, p);
      let node: DriveNode | null;
      try {
        node = await provider.resolvePath(abs);
      } catch (err) {
        throw driveErrorToHttp(err, "检查范围目录失败");
      }
      if (!node) throw new HttpError(400, `网盘上找不到 ${abs}`);
      if (!node.isDir) throw new HttpError(400, `${abs} 不是目录，范围要选目录`);
    }
  }
  // 同一任务同时只跑一个进行中的 run：两个 run 同时改同一批文件会互相踩
  const busy = listRunsByStatus(["planning", "applying", "reverting"]).find((r) => r.taskId === task.id);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`, { runId: busy.id });

  const startedAt = Date.now();
  const run = insertRun({
    id: randomUUID(),
    taskId: task.id,
    accountName: provider.account.name,
    scopePath,
    scopePaths,
    hints,
    mode: input.mode ?? "manual",
    trigger,
    naming,
  });
  runStartedAt.set(run.id, startedAt);
  startJob(run.id, (job) => preview(job, run.id, { refreshTmdb: input.refreshTmdb === true }));
  return getRun(run.id)!;
}

/* ------------------------------- 预览：列 → 分单元 → 识别 → 规划 ------------------------------- */

interface Walked {
  entries: ScopeEntry[];
  files: number;
  /** 整棵列过的目录（相对任务 originPath）：这些目录里的东西全知道，其余目录要用时再列 */
  roots: string[];
}

/**
 * 范围目录本身腾空后删不删：手动把范围指到某个发布目录（`Show.S01.1080p-GROUP`、`片名 (2025)`）时，
 * 里面的东西全挪走后这个空壳没用了，一起删；`inbox`、`电影` 这种收件箱式的范围留着。任务根目录（范围为空）永远不删
 */
const scopeRemovable = (run: OrganizeRun): boolean => run.scopePaths.length === 0 && run.scopePath !== "" && looksLikeReleaseDir(baseOf(run.scopePath));

/** run 的范围写成一组路径（相对任务 originPath）；"" 是整个任务 */
const scopeListOf = (run: OrganizeRun): string[] => (run.scopePaths.length > 0 ? run.scopePaths : [run.scopePath]);

/** inner 的每一条路径都在 outer 的某一条路径之下（整个任务覆盖一切） */
const covers = (outer: string[], inner: string[]): boolean => inner.every((p) => outer.some((o) => o === "" || p === o || p.startsWith(`${o}/`)));

/** 一次预览作废另一次：标已取消、写明原因，内存里的单元结构也丢掉 */
function supersede(old: OrganizeRun, reason: string): void {
  updateRun(old.id, { status: "cancelled", error: reason, finishedAt: Math.floor(Date.now() / 1000) });
  planStates.delete(old.id);
}

/**
 * 预览完成时，把同任务里范围被它覆盖的旧「待执行」预览作废：网盘已经按这次预览的样子来了，
 * 旧的留着只会被误执行；范围不被覆盖的（别的目录）照旧留着
 */
function supersedeCovered(run: OrganizeRun): number {
  const scope = scopeListOf(run);
  let n = 0;
  for (const old of listRunsByStatus(["ready"])) {
    if (old.id === run.id || old.taskId !== run.taskId || !covers(scope, scopeListOf(old))) continue;
    supersede(old, "已被新的预览取代");
    n++;
  }
  return n;
}

/**
 * 这个任务里范围落在给定范围之内、还等着执行的清单：在这个范围上新做一次预览，做完时会把它们作废
 * （和 supersedeCovered 同一套规则）。智能体发起预览前先看一眼，别把人在界面上改了一半的清单作废掉
 */
export function readyRunsWithin(taskId: string, scope: { subPath?: string; paths?: string[] }): OrganizeRun[] {
  const paths = [...new Set((scope.paths ?? []).map((p) => splitPath(p).join("/")).filter(Boolean))];
  const outer = paths.length > 0 ? paths : [splitPath(scope.subPath ?? "").join("/")];
  return listRunsByStatus(["ready"]).filter((r) => r.taskId === taskId && covers(outer, scopeListOf(r)));
}

/**
 * 启动时收拢堆在一起的「待执行」预览：同一个任务里范围被更新的那次覆盖的，留最新的一条，其余作废。
 * 每次预览完成本来就会这么收（`supersedeCovered`），这里管的是那之前留下的、和进程重启后没法再改的旧预览——
 * 待处理列表里一串「tv · 整个任务」谁也分不清，还都是按旧网盘状态算的
 */
export function collapseStaleReadyRuns(): number {
  // createdAt 只到秒，同一秒建的按落库顺序算新旧（后进的更新）
  const ready = listRunsByStatus(["ready"])
    .map((run, i) => ({ run, i }))
    .sort((a, b) => b.run.createdAt - a.run.createdAt || b.i - a.i)
    .map((x) => x.run);
  const kept: OrganizeRun[] = [];
  let n = 0;
  for (const run of ready) {
    const newer = kept.find((k) => k.taskId === run.taskId && covers(scopeListOf(k), scopeListOf(run)));
    if (!newer) {
      kept.push(run);
      continue;
    }
    supersede(run, "已被同范围更新的预览取代");
    n++;
  }
  return n;
}

/**
 * 分单元时的范围：单一范围照旧；手动选的多个范围各按单一范围的规则来（见 buildUnits 的 scopes）；
 * 自动触发的新增路径按任务根分单元（新落进来的发布目录名字可靠，按目录名认）
 */
const unitScopesOf = (run: OrganizeRun): string[] => (run.scopePaths.length === 0 ? [run.scopePath] : handPicked(run.trigger) ? run.scopePaths : [""]);

/**
 * 删空目录的边界：只删范围里面腾空的目录。范围本身：单一范围 / 手动选的多个范围按「像发布目录 / 季目录」判断；
 * 自动触发的新增路径是目录的，它本来就是新落进来的，腾空了可删，但它的上级（转存落点 inbox 这种）不碰；是文件的不删任何目录
 */
function scopeRootsOf(run: OrganizeRun, walkedDirs: string[]): ScopeRoot[] {
  if (run.scopePaths.length === 0) return [{ path: run.scopePath, removable: scopeRemovable(run) }];
  if (handPicked(run.trigger)) return walkedDirs.map((p) => ({ path: p, removable: p !== "" && looksLikeReleaseDir(baseOf(p)) }));
  return walkedDirs.map((p) => ({ path: p, removable: p !== "" }));
}

/**
 * 单元根算不算这部作品独占的目录（腾空了能跟着删）。只看名字和结构，里面还剩什么由 finalizeItems 按清单算：
 *   - 目录名就是这部作品的名字（isNamedAfter；titles 是识别出来的片名）；
 *   - 不是从大目录里拆出来的（一个目录只会分出一个单元，除非按标题拆开，拆出来的 key 带 `|`：装着几部作品）；
 *   - 不是别的同账号任务的根目录，也不装着别的任务的根目录；
 *   - 没有待兑现的云下载回执指进去（115 的目标目录在加任务时就定了，删了后面的下载就没地方落）。
 * 追更、复制队列指进去的照旧跟到作品目录
 */
function ownWorkRoot(state: PlanState, unit: Unit, titles: string[]): boolean {
  const p = unit.rootPath;
  if (!p || unit.key.includes("|") || !isNamedAfter(baseOf(p), titles)) return false;
  const abs = normalizePath(absOf(state.task, p));
  if (state.otherTaskRoots.some((r) => r === abs || r.startsWith(`${abs}/`))) return false;
  return !state.offlineRefs.some((sub) => sub === p || sub.startsWith(`${p}/`));
}

/**
 * 删空目录的边界，给 finalizeItems：在 state.scopeRoots 之外，手动 / 智能体发起的整理里，单元根（这部作品原来所在的目录）
 * 是它独占的目录（ownWorkRoot）时，腾空了也删——范围选的是只有片名的剧目录、季目录（单元根是上一级的剧目录），都会留下这样的空壳。
 * 只看里面有什么都知道的：等于某个范围根，或者越到范围外、整棵列过（state.outsideRoots）；范围里面的目录腾空了本来就删。
 * 自动整理照旧：不删范围外、也不删新增路径所在的目录。按当时的匹配现算：预览、换匹配后的重规划都调它
 */
function cleanupRoots(state: PlanState, titlesOf: (key: string) => string[]): ScopeRoot[] {
  const roots = state.scopeRoots.map((r) => ({ ...r }));
  if (!state.handPicked) return roots;
  for (const u of state.units.values()) {
    const p = u.rootPath;
    if (!p) continue;
    const equal = roots.find((r) => r.path === p);
    if (equal?.removable) continue;
    const inside = state.scopeRoots.some((r) => r.path === "" || p.startsWith(`${r.path}/`));
    if (!equal && (inside || !state.outsideRoots.has(p))) continue;
    if (!ownWorkRoot(state, u, titlesOf(u.key))) continue;
    if (equal) equal.removable = true;
    else roots.push({ path: p, removable: true });
  }
  return roots;
}

/**
 * 判断「目录名是不是这部作品的名字」用的片名：识别出来的中文名、原名、英文名。
 * withCandidates：连「换匹配」的备选一起（预览时决定要不要去网盘列范围外的单元根，换成备选后重规划不用再列）
 */
function workTitles(m: OrganizeMatch | null, withCandidates = false): string[] {
  if (!m) return [];
  return [m.title, m.originalTitle, m.enTitle ?? "", ...(withCandidates ? (m.candidates ?? []).map((c) => c.title) : [])].filter(Boolean);
}

/** 单元行的片名：识别出来的几个名字，加上用户改的标题（改了标题的目录名要按新名字对） */
const unitTitles = (row: OrganizeUnit | undefined): string[] => (row ? [...workTitles(row.match), row.titleOverride].filter(Boolean) : []);

/**
 * 单元的引用数（追更 / 云下载回执 / 复制队列里有多少条落在它下面）：单元根在范围里，或者这次会腾空删掉（范围外、作品独占的目录，
 * 见 cleanupRoots），按整个单元根算；单元根越到了范围外、又不删的，只有范围里的会挪走，只数范围里的。rmdirs：清单里要删的目录
 */
function refsOf(state: PlanState, unit: Unit, rmdirs: ReadonlySet<string>): number {
  const under = (p: string, dir: string) => dir === "" || p === dir || p.startsWith(`${dir}/`);
  const whole = state.scopes.some((dir) => under(unit.rootPath, dir)) || rmdirs.has(unit.rootPath);
  if (whole) return referencesTo(state.refPaths, unit.rootPath);
  return state.scopes.filter((dir) => unit.files.some((f) => under(f.path, dir))).reduce((n, dir) => n + referencesTo(state.refPaths, dir), 0);
}

/** 清单里要删的目录（相对任务 originPath） */
const rmdirsOf = (items: PlannedItem[]): Set<string> => new Set(items.filter((i) => i.action === "rmdir").map((i) => i.srcPath));

/**
 * 单元根越到范围外的（范围直接选在季目录上，单元根是上一级的剧目录）：腾空后删不删得知道里面还有什么，整棵列一遍，列过的记进 outsideRoots。
 * 只在有必要时去网盘列：手动 / 智能体发起的整理、开着「整理完删空目录」、是这部作品独占的目录（名字连「换匹配」的备选一起比，
 * 换成备选后重规划不用再列）、这个单元确实要把东西挪出这个目录。嵌套的只列外层（里层跟着就知道了）。
 * 不是目录、不在了、太大、列失败的都不记：不知道里面还有什么就不删
 */
async function listOutsideUnitRoots(
  provider: DriveProvider,
  state: PlanState,
  plans: UnitPlan[],
  signal: AbortSignal,
  titlesOf: (unit: Unit) => string[],
): Promise<ScopeEntry[]> {
  if (!state.handPicked || !state.org.cleanupEmptyDirs) return [];
  const under = (p: string, dir: string) => dir === "" || p === dir || p.startsWith(`${dir}/`);
  const planOf = new Map(plans.map((pl) => [pl.unitKey, pl]));
  const wanted: string[] = [];
  for (const u of state.units.values()) {
    const root = u.rootPath;
    if (!root || state.roots.some((r) => under(root, r))) continue;
    const movesOut = planOf.get(u.key)?.items.some((it) => it.action === "move" && under(it.srcPath, root) && !under(it.dstPath, root));
    if (movesOut && ownWorkRoot(state, u, titlesOf(u))) wanted.push(root);
  }
  const known = new Set(state.entries.map((e) => e.path));
  const out: ScopeEntry[] = [];
  for (const root of wanted) {
    if (wanted.some((o) => o !== root && root.startsWith(`${o}/`))) continue;
    signal.throwIfAborted();
    try {
      const node = await provider.resolvePath(absOf(state.task, root), signal);
      if (!node?.isDir) continue;
      const entries = await listTree(provider, state.task, root, signal, node.id);
      if (entries.filter((e) => !e.isDir).length > ORGANIZE_LIMITS.MAX_FILES) continue;
      for (const e of [{ path: root, isDir: true, id: node.id }, ...entries]) {
        if (known.has(e.path)) continue;
        known.add(e.path);
        out.push(e);
      }
      for (const w of wanted) if (under(w, root)) state.outsideRoots.add(w);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      log.warn({ err, root }, "列范围外的单元根失败：腾空了也不删它");
    }
  }
  return out;
}

/** 单元里单独取消勾选的文件（网盘绝对路径）换成规划用的相对路径 */
const excludedRel = (task: TaskDefinition, unit: OrganizeUnit): Set<string> => new Set(unit.excluded.map((p) => relOf(task, p)));

/** 单元上按网盘绝对路径记的冲突处理 → 相对任务 originPath（规划用的路径） */
const resolutionsRel = (task: TaskDefinition, unit: OrganizeUnit): Map<string, OrganizeConflictResolution> =>
  new Map(Object.entries(unit.resolutions ?? {}).map(([p, r]) => [relOf(task, p), r]));
const pinsRel = (task: TaskDefinition, unit: OrganizeUnit): Map<string, OrganizeEpisodePin> => new Map(Object.entries(unit.pins ?? {}).map(([p, r]) => [relOf(task, p), r]));
const renamesRel = (task: TaskDefinition, unit: OrganizeUnit): Map<string, string> => new Map(Object.entries(unit.renames ?? {}).map(([p, r]) => [relOf(task, p), r]));
const kindsRel = (task: TaskDefinition, unit: OrganizeUnit): Map<string, OrganizeKindOverride> => new Map(Object.entries(unit.kinds ?? {}).map(([p, r]) => [relOf(task, p), r]));

/** 规划里要用的、单元行上的人为设定（标题 / 年份、钉的季集、改的文件名、改判的类型）换成相对路径 */
const overridesOf = (task: TaskDefinition, unit: OrganizeUnit): Pick<UnitPlanInput, "titleOverride" | "yearOverride" | "pins" | "renames" | "kinds"> => ({
  titleOverride: unit.titleOverride,
  yearOverride: unit.yearOverride,
  pins: pinsRel(task, unit),
  renames: renamesRel(task, unit),
  kinds: kindsRel(task, unit),
});

/** 整棵列一个目录（相对任务 originPath）：有 walkSubtree 的（夸克 / OpenList）带 id，115 只有路径，id 到执行时再解析 */
async function listTree(provider: DriveProvider, task: TaskDefinition, rel: string, signal: AbortSignal, id?: string): Promise<ScopeEntry[]> {
  const abs = absOf(task, rel);
  if (provider.walkSubtree) {
    return (await provider.walkSubtree(abs, { id, signal })).map((e) => ({ path: joinRel(rel, e.path), isDir: e.isDir, id: e.id, size: e.size }));
  }
  // listSubtree 给的是文件 + 顶层空目录；没有扩展名的当目录（和 115 导出树的判断一致）
  return (await provider.listSubtree(abs, { id, signal })).map((p) => ({ path: joinRel(rel, p), isDir: !looksLikeFileName(baseOf(p)) }));
}

/** 列范围：有 walkSubtree 的（夸克 / OpenList）带 id，115 只有路径，id 到执行时再解析 */
async function walkScope(provider: DriveProvider, task: TaskDefinition, run: OrganizeRun, signal: AbortSignal): Promise<Walked> {
  const entries: ScopeEntry[] = [];
  const seen = new Set<string>();
  const roots: string[] = [];
  const push = (e: ScopeEntry) => {
    if (seen.has(e.path)) return;
    seen.add(e.path);
    entries.push(e);
  };
  const walkDir = async (rel: string, id?: string) => {
    roots.push(rel);
    for (const e of await listTree(provider, task, rel, signal, id)) push(e);
  };
  if (run.scopePaths.length === 0) {
    await walkDir(run.scopePath);
  } else {
    for (const rel of run.scopePaths) {
      const node = await provider.resolvePath(absOf(task, rel), signal);
      if (!node) continue;
      if (node.isDir) await walkDir(rel, node.id);
      else push({ path: rel, isDir: false, id: node.id });
    }
  }
  const files = entries.filter((e) => !e.isDir).length;
  if (files > ORGANIZE_LIMITS.MAX_FILES) throw new Error(`范围里有 ${files} 个文件，超过一次整理的上限 ${ORGANIZE_LIMITS.MAX_FILES}，请缩小范围`);
  return { entries, files, roots };
}

/**
 * 记住的识别里的季 / 集偏移只补空（见 plan.ts 的 EpisodeFill），不写进单元的季覆盖 / 集偏移：作品目录以后还会收别的季、
 * 整理好的文件再整理也不能再套一次。认出来的不是记着的那部作品（识别词直指了别的）就不用
 */
function memoryFill(memory: OrganizeMatchMemory | null | undefined, match: OrganizeMatch | null): EpisodeFill | null {
  if (!memory || !match || match.mediaType !== "tv" || memory.tmdbId !== match.tmdbId || memory.mediaType !== match.mediaType) return null;
  if (memory.season === null && memory.episodeOffset === 0) return null;
  return { season: memory.season, episodeOffset: memory.episodeOffset, from: "按记住的识别" };
}

/** 影库条目：转存自影库的目录名和条目的 rawName 一致 */
function libraryEvidence(unit: Unit, entries: ReturnType<typeof listLibraryEntries>): KnownId | null {
  if (!unit.rootPath) return null;
  const name = baseOf(unit.rootPath);
  const hit = entries.find((e) => e.tmdbId && (e.mediaType === "movie" || e.mediaType === "tv") && (e.rawName === name || e.title === name));
  return hit ? { tmdbId: hit.tmdbId!, mediaType: hit.mediaType as OrganizeMediaType, source: "收藏夹条目" } : null;
}

/** 范围之外的目标目录里现有的条目（连目录本身一起），给冲突检测和 mkdir 判断用 */
async function listOutsideDstDirs(
  provider: DriveProvider,
  task: TaskDefinition,
  roots: string[],
  plans: UnitPlan[],
  entries: ScopeEntry[],
  signal: AbortSignal,
  /** 已经去网盘看过的目录（在的列过了、不在的也记着）：同一次预览里重规划时不再重复列；会被这次调用补上 */
  listed: Set<string> = new Set(),
): Promise<ScopeEntry[]> {
  const inScope = (rel: string) => roots.some((r) => r === "" || rel === r || rel.startsWith(`${r}/`));
  const dirs = new Set<string>();
  for (const p of plans) {
    for (const it of p.items) {
      if ((it.action === "rename" || it.action === "move") && !inScope(dirOf(it.dstPath))) dirs.add(dirOf(it.dstPath));
      // 冲突选了挪进重复文件目录：那边现在有什么也得知道（撞名了往后排 (2)）
      if (it.resolve === "duplicate" && !inScope(dirOf(duplicatePathFor(it.srcPath)))) dirs.add(dirOf(duplicatePathFor(it.srcPath)));
    }
  }
  // 只列最深的那些目录：它存在就顺便说明祖先都存在；不存在就往上找到第一个存在的祖先列出来。
  // 已知的条目没带 id 的（115 整棵列只有路径）照样交出去，调用方合并时留带 id 的那份（mergePreferId）
  const known = new Map(entries.map((e) => [e.path, !!e.id]));
  const fresh = (p: string, id: string | undefined) => {
    const had = known.get(p);
    if (had === true || (had === false && !id)) return false;
    known.set(p, !!id);
    return true;
  };
  const out: ScopeEntry[] = [];
  for (const dir of [...dirs].sort()) {
    let cur = dir;
    while (cur && !inScope(cur) && !listed.has(cur)) {
      signal.throwIfAborted();
      const node = await provider.resolvePath(absOf(task, cur), signal);
      if (node?.isDir) {
        if (fresh(cur, node.id)) out.push({ path: cur, isDir: true, id: node.id });
        for (const e of await provider.listDir(node.id, signal)) {
          const p = joinRel(cur, e.name);
          if (fresh(p, e.id)) out.push({ path: p, isDir: e.isDir, id: e.id, size: e.size });
        }
        listed.add(cur);
        break;
      }
      // 不在的也记着：它下面的目录更不会在，下次到这里就停
      listed.add(cur);
      cur = dirOf(cur);
    }
  }
  return out;
}

function toUnitRow(runId: string, unit: Unit, match: OrganizeMatch | null, plan: UnitPlan | null, referencedBy: number): OrganizeUnit {
  return {
    runId,
    key: unit.key,
    rootPath: unit.rootPath,
    rawName: unit.rawName,
    parsedTitle: unit.parsed.title,
    parsedYear: unit.parsed.year ?? "",
    match,
    seasonOverride: null,
    episodeOffset: 0,
    dstRoot: plan?.dstRoot ?? "",
    selected: !!match,
    remember: false,
    fileCount: unit.files.length,
    videoCount: unit.files.filter((f) => f.kind === "video").length,
    referencedBy,
    notes: plan?.notes ?? [],
    excluded: [],
    resolutions: {},
    titleOverride: "",
    yearOverride: "",
    pins: {},
    renames: {},
    kinds: {},
  };
}

function toItemRows(task: TaskDefinition, items: PlannedItem[]): NewItem[] {
  return items.map((it, seq) => ({
    id: randomUUID(),
    unitKey: it.unitKey,
    seq,
    kind: it.kind,
    action: it.action,
    srcPath: absOf(task, it.srcPath),
    dstPath: absOf(task, it.dstPath),
    nodeId: it.nodeId,
    reason: it.reason,
  }));
}

/** 追更 / 云下载回执里有多少条落在这个目录下 */
function referencesTo(refPaths: string[], rootRel: string): number {
  if (!rootRel) return 0;
  return refPaths.filter((p) => p === rootRel || p.startsWith(`${rootRel}/`)).length;
}

async function preview(job: Job, runId: string, opts: { refreshTmdb: boolean }): Promise<void> {
  const run = getRun(runId)!;
  const task = getTask(run.taskId);
  if (!task) throw new Error("任务已不存在");
  const provider = providerForTask(task, "write");
  const settings = readAppSettings();
  // 命名模板 / id 标签 / 集标题可以按任务覆盖
  const org = resolveOrganizeSettings(settings, task);
  // 按本地 strm 结构的不识别，不要 TMDB；缺 key 的检查放在分支之后
  const tmdb = run.naming === "local" ? null : deps.tmdb(settings, { fresh: opts.refreshTmdb });
  const signal = job.abort.signal;
  updateRun(runId, { startedAt: Math.floor(Date.now() / 1000) });

  setProgress(job, "walk", 0, 0, "正在列网盘目录");
  // 手动选的多个目录列出来（和页面「N 个目录」一个说法）；自动触发的新增路径可能几十条，只报个数
  const scopeNote = run.scopePaths.length === 0 ? "" : handPicked(run.trigger) ? `（${run.scopePaths.length} 个目录：${run.scopePaths.slice(0, 5).join("、")}${run.scopePaths.length > 5 ? " 等" : ""}）` : `（${run.scopePaths.length} 个新增路径）`;
  jobLog(job, `开始预览：${task.originPath}${run.scopePath ? `/${run.scopePath}` : ""}${scopeNote}`);
  if (opts.refreshTmdb) jobLog(job, "刷新 TMDB 信息：每部作品的详情和季集跳过缓存重新向 TMDB 拉取，作品多会慢一些");
  const walked = await walkScope(provider, task, run, signal);
  jobLog(job, `列到 ${walked.files} 个文件`);
  signal.throwIfAborted();

  if (run.naming === "local") {
    await previewLocal(job, runId, run, task, provider, settings, org, walked, signal);
    return;
  }
  if (!tmdb) throw new Error("TMDB 未配置 apiKey");

  const rules = parseRules(org.rules).rules;
  const scopes = unitScopesOf(run);
  // 重复文件目录（冲突项挪进去的）、归档目录（复制后挪进去的）是暂存区，不再当作品扫；冲突检测还是要知道里面有什么，所以只挡 buildUnits
  const units = buildUnits(walked.entries.filter((e) => !isStagingDir(e.path)), {
    scopePath: run.scopePath,
    scopes,
    taskRootName: baseOf(normalizePath(task.originPath)),
    videoExts: videoExtsOf(settings),
    rules,
    libraryType: task.organize?.libraryType,
  });
  jobLog(job, `分成 ${units.length} 个作品单元`);

  const state = newPlanState({ task, settings, org, run, walked, provider, units });
  attachProbes(state, provider.account.name);
  if (org.probe === "missing") await autoProbe(job, state, provider, signal);
  const library = listLibraryEntries();
  const hints = getRunHints(runId);
  const rows: OrganizeUnit[] = [];
  const plans: UnitPlan[] = [];
  let i = 0;
  for (const unit of units) {
    signal.throwIfAborted();
    setProgress(job, "identify", i++, units.length, `识别 ${unit.rawName}`);
    const absRoot = absOf(task, unit.rootPath);
    const followed = hintFor(unit, hints);
    const evidence: IdEvidence = {
      follow: followed.hint ? { tmdbId: followed.hint.tmdbId, mediaType: followed.hint.mediaType, source: hintSource(followed.hint) } : null,
      memory: recallMatch(provider.account.name, absRoot),
      // 目录名里的 [tmdbid=…] 多半是整理自己写的，排最前；本地 nfo 可能是上传者的刮削器写的，识别时要核对标题；影库条目最后
      known: [idTagFromName(unit.rawName, unit.kindHint), await nfoEvidence(resolveInDataDir(task.targetPath), unit), libraryEvidence(unit, library)],
    };
    let match: OrganizeMatch | null = null;
    let episodeTitles = new Map<string, string>();
    let identifyNotes: string[] = [];
    try {
      const r = await identifyUnit({ unit, evidence, libraryType: task.organize?.libraryType, episodeTitles: org.episodeTitle }, tmdb);
      match = r.match;
      episodeTitles = r.episodeTitles;
      identifyNotes = r.notes;
      for (const n of r.notes) jobLog(job, `「${unit.rawName}」${n}`);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      jobLog(job, `识别「${unit.rawName}」失败：${messageOf(err)}`);
    }
    // 追更的提示用上了（认出来的就是提示里的作品）：人定的季 / 集偏移照样强制，补空季只补空，不再看记忆
    const hint = followed.hint && match && match.tmdbId === followed.hint.tmdbId && match.mediaType === followed.hint.mediaType ? followed.hint : null;
    const hintNote = followed.note ?? (followed.hint && match && !hint ? `认出来的不是${hintSource(followed.hint)}里的作品，季和集偏移没沿用` : "");
    if (hintNote) {
      identifyNotes = [...identifyNotes, hintNote];
      jobLog(job, `「${unit.rawName}」${hintNote}`);
    }
    state.episodeTitles.set(unit.key, episodeTitles);
    state.identifyNotes.set(unit.key, identifyNotes);
    // 引用数等删空目录的边界定了再算（refsOf）
    const row = toUnitRow(runId, unit, match, null, 0);
    let fill: EpisodeFill | null;
    if (hint) {
      row.seasonOverride = hint.season;
      row.episodeOffset = hint.episodeOffset;
      fill = hint.seasonFallback !== null ? { season: hint.seasonFallback, episodeOffset: 0, from: `沿用${hintSource(hint)}` } : null;
    } else fill = memoryFill(evidence.memory, match);
    if (fill) state.fills.set(unit.key, fill);
    // 记住的标题 / 年份：认出来的还是记忆里那一部才照用
    const mem = evidence.memory;
    if (!hint && mem && match && mem.tmdbId === match.tmdbId && mem.mediaType === match.mediaType && (mem.titleOverride || mem.yearOverride)) {
      row.titleOverride = mem.titleOverride;
      row.yearOverride = mem.yearOverride;
      const what = [mem.titleOverride ? `标题用「${mem.titleOverride}」` : "", mem.yearOverride ? `年份用 ${mem.yearOverride}` : ""].filter(Boolean).join("、");
      identifyNotes = [...identifyNotes, `按记住的识别：${what}`];
      state.identifyNotes.set(unit.key, identifyNotes);
    }
    const plan = planUnit(
      { unit, match, seasonOverride: row.seasonOverride, episodeOffset: row.episodeOffset, fill, episodeTitles, selected: row.selected, titleOverride: row.titleOverride, yearOverride: row.yearOverride },
      { settings: org, libraryType: task.organize?.libraryType },
    );
    row.dstRoot = plan.dstRoot;
    row.notes = [...identifyNotes, ...plan.notes];
    rows.push(row);
    plans.push(plan);
    jobLog(job, match ? `「${unit.rawName}」→ ${match.title} (${match.year}) [${match.confidence}] ${match.reason}` : `「${unit.rawName}」没有识别出来`);
  }

  setProgress(job, "plan", 0, 0, "规划目标路径");
  // 单元根越到范围外、又是这部作品独占的目录（范围直接选在季目录上）：整棵列一遍，腾空后删不删得知道里面还有什么
  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  const rootEntries = await listOutsideUnitRoots(provider, state, plans, signal, (u) => [...workTitles(rowByKey.get(u.key)?.match ?? null, true), rowByKey.get(u.key)?.titleOverride ?? ""].filter(Boolean));
  const known = [...walked.entries, ...rootEntries];
  // 目标目录在范围之外（整理到任务根下的作品目录）时，冲突检测得知道那边已经有什么：每个目标目录列一次。
  // 有 walkSubtree 的网盘整棵列过的单元根里 id、内容都全了，落在里面的不再列；115 整棵列只有路径，照列，合并时留带 id 的
  const listedRoots = provider.walkSubtree ? [...walked.roots, ...state.outsideRoots] : walked.roots;
  const extra = await listOutsideDstDirs(provider, task, listedRoots, plans, known, signal, state.listed);
  state.entries = mergePreferId(known, extra);
  const items = finalizeItems(plans, { entries: state.entries, scopeRoots: cleanupRoots(state, (key) => unitTitles(rowByKey.get(key))), items: [], cleanupEmptyDirs: org.cleanupEmptyDirs });
  const rmdirs = rmdirsOf(items);
  for (const row of rows) row.referencedBy = refsOf(state, state.units.get(row.key)!, rmdirs);
  planStates.set(runId, state);
  replaceUnits(runId, rows);
  replaceItems(runId, toItemRows(task, items));
  const stats = computeStats(rows, listItems(runId), "apply");
  const superseded = supersedeCovered(run);
  if (superseded > 0) jobLog(job, `作废了 ${superseded} 个范围被这次覆盖的旧预览`);
  // 收尾这句先进日志再落库，不然页面上的日志里没有它
  jobLog(job, `预览完成：${stats.units} 个单元，${stats.planned} 项要动，${stats.conflicts} 项冲突`);
  updateRun(runId, { status: "ready", stats, log: job.logs, error: "" });

  if (run.mode !== "manual") await afterAutoPreview(runId, task, run.mode, rows, stats);
}

/** 预览的规划状态，两种命名来源共用：范围里的条目、单元、删空目录的边界、追更 / 云下载 / 复制队列指着的路径…… */
function newPlanState(args: {
  task: TaskDefinition;
  settings: PlanState["settings"];
  org: PlanState["org"];
  run: OrganizeRun;
  walked: Walked;
  provider: Parameters<typeof walkScope>[0];
  units: Unit[];
}): PlanState {
  const { task, settings, org, run, walked, provider, units } = args;
  const state: PlanState = {
    task,
    settings,
    org,
    entries: walked.entries,
    roots: walked.roots,
    units: new Map(units.map((u) => [u.key, u])),
    episodeTitles: new Map(),
    identifyNotes: new Map(),
    scopeRoots: scopeRootsOf(run, walked.roots),
    listed: new Set(),
    handPicked: handPicked(run.trigger),
    scopes: unitScopesOf(run),
    refPaths: [],
    offlineRefs: rewriteOfflineSubPaths(task.id, [], true),
    otherTaskRoots: accountTasks(provider.account.name)
      .filter((t) => t.id !== task.id)
      .map((t) => normalizePath(t.originPath)),
    outsideRoots: new Set(),
    fills: new Map(),
  };
  state.refPaths = [...rewriteFollowSubPaths(task.id, [], true), ...state.offlineRefs, ...rewriteCopyPaths(task.id, task.originPath, [], true)];
  return state;
}

/**
 * 按本地 strm 的目录结构预览（naming = local）：不分单元、不识别，本地 strm 指着谁就把谁挪到本地的相对位置。
 * 单元是本地的作品目录，没有 TMDB 匹配；勾选、按文件勾选、冲突办法照常，换匹配 / 季集 / 记住没有
 */
async function previewLocal(
  job: Job,
  runId: string,
  run: OrganizeRun,
  task: TaskDefinition,
  provider: Parameters<typeof walkScope>[0],
  settings: PlanState["settings"],
  org: PlanState["org"],
  walked: Walked,
  signal: AbortSignal,
): Promise<void> {
  setProgress(job, "identify", 0, 0, "读本地 strm");
  const index = await indexLocalStrm(task, listTasks(), { limit: ORGANIZE_LIMITS.MAX_FILES, signal });
  const inScope = (rel: string) => walked.roots.some((r) => r === "" || rel === r || rel.startsWith(`${r}/`));
  const mapping = mapLocalStrm(walked.entries, index, { videoExts: videoExtsOf(settings), inScope });
  const s = mapping.summary;
  const extras = [
    s.duplicates ? `${s.duplicates} 个文件被多个 strm 指着（跳过）` : "",
    s.outside ? `${s.outside} 个 strm 指着这次范围之外` : "",
    s.missing ? `${s.missing} 个 strm 指着的文件已不在网盘上（strm 管理页能体检）` : "",
    s.foreign ? `${s.foreign} 个 strm 的内容对不上这个任务（别的任务的、或手改过的）` : "",
    s.truncated ? `本地 strm 超过 ${ORGANIZE_LIMITS.MAX_FILES} 个，只读了前面的` : "",
  ].filter(Boolean);
  jobLog(job, `本地 ${s.strms} 个 strm：对上范围里 ${s.matched} 个文件，${s.moving} 个要改名 / 挪动，${s.unchanged} 个已经一样${extras.length > 0 ? `；${extras.join("；")}` : ""}`);
  if (task.removeExtraFiles) jobLog(job, "注意：任务开着「删除本地多余文件」，执行前别跑同步，不然改过名的 strm 会被当多余删掉");
  if (task.cronExpression) jobLog(job, "注意：任务有定时同步，整理进行中那一轮会跳过；建议先把这次整理执行完");
  signal.throwIfAborted();

  const state = newPlanState({ task, settings, org, run, walked, provider, units: mapping.units.map(toSyntheticUnit) });
  state.local = new Map(mapping.units.map((u) => [u.key, u]));
  const rows: OrganizeUnit[] = [];
  const plans: UnitPlan[] = [];
  for (const lu of mapping.units) {
    const plan = planLocalUnit(lu, { selected: true });
    const row = toUnitRow(runId, state.units.get(lu.key)!, null, plan, 0);
    row.selected = true;
    row.parsedTitle = "";
    row.parsedYear = "";
    rows.push(row);
    plans.push(plan);
  }
  jobLog(job, `按本地的作品目录分成 ${rows.length} 个单元`);

  setProgress(job, "plan", 0, 0, "规划目标路径");
  const extra = await listOutsideDstDirs(provider, task, walked.roots, plans, walked.entries, signal, state.listed);
  state.entries = mergePreferId(walked.entries, extra);
  const items = finalizeItems(plans, { entries: state.entries, scopeRoots: cleanupRoots(state, () => []), items: [], cleanupEmptyDirs: org.cleanupEmptyDirs });
  const rmdirs = rmdirsOf(items);
  for (const row of rows) row.referencedBy = refsOf(state, state.units.get(row.key)!, rmdirs);
  planStates.set(runId, state);
  replaceUnits(runId, rows);
  replaceItems(runId, toItemRows(task, items));
  const stats = computeStats(rows, listItems(runId), "apply");
  const superseded = supersedeCovered(run);
  if (superseded > 0) jobLog(job, `作废了 ${superseded} 个范围被这次覆盖的旧预览`);
  jobLog(job, `预览完成：${stats.units} 个单元，${stats.planned} 项要动，${stats.conflicts} 项冲突`);
  updateRun(runId, { status: "ready", stats, log: job.logs, error: "" });
}

/* ------------------------------- 探测编码（mediainfo.js） ------------------------------- */

const PROBE_VARS: Array<keyof MediaProbeTags> = ["resolution", "videoCodec", "audio", "hdr"];

/** 模板里用到了哪些可以探测出来的标签 */
function probeVarsOf(org: PlanState["org"]): Array<keyof MediaProbeTags> {
  const text = `${org.templates.movie} ${org.templates.tv}`;
  return PROBE_VARS.filter((v) => text.includes(`{${v}}`));
}

const probeTargetOf = (state: PlanState, file: UnitFile): ProbeTarget => ({ path: absOf(state.task, file.path), id: file.id, size: file.size });

/** 文件名里缺模板要用的标签、探测结果里也没有 */
const lacksProbeTags = (file: UnitFile, wanted: Array<keyof MediaProbeTags>): boolean => wanted.some((v) => !file.parsed.tags[v] && !file.probe?.[v]);

function videoFilesOf(state: PlanState, keys?: Iterable<string>): UnitFile[] {
  const units = keys ? [...keys].map((k) => state.units.get(k)).filter((u): u is Unit => !!u) : [...state.units.values()];
  return units.flatMap((u) => u.files.filter((f) => f.kind === "video"));
}

/** 预览开始时把缓存里的探测结果填进单元文件（不碰网盘） */
function attachProbes(state: PlanState, accountName: string): void {
  const files = videoFilesOf(state);
  const tags = cachedProbeTags(accountName, files.map((f) => probeTargetOf(state, f)));
  for (const f of files) {
    const t = tags.get(absOf(state.task, f.path));
    if (t) f.probe = t;
  }
}

/** 设置开着「预览时自动探测」：识别之前把文件名缺标签的视频探一遍，进度写在识别那一栏 */
async function autoProbe(job: Job, state: PlanState, provider: DriveProvider, signal: AbortSignal): Promise<void> {
  const wanted = probeVarsOf(state.org);
  if (wanted.length === 0) return;
  const targets = videoFilesOf(state).filter((f) => lacksProbeTags(f, wanted));
  if (targets.length === 0) return;
  let ok = 0;
  let cached = 0;
  let failed = 0;
  for (const [i, f] of targets.entries()) {
    signal.throwIfAborted();
    setProgress(job, "identify", i, targets.length, `探测编码 ${f.name}`);
    const r = await probeDriveFile(provider, provider.account.name, probeTargetOf(state, f), { signal });
    if (r.status === "ok" && r.probe) {
      f.probe = probeTags(r.probe);
      ok++;
      if (r.cached) cached++;
    } else failed++;
  }
  jobLog(job, `探测编码：${targets.length} 个视频的文件名里缺模板要用的标签，读到 ${ok} 个（${cached} 个用缓存），${failed} 个没读到`);
}

export interface ProbeSelection {
  /** 这个单元的全部视频 */
  key?: string;
  /** 这些单元里文件名缺模板要用的标签的视频 */
  keys?: string[];
  /** 清单里勾选的全部单元中，文件名缺模板要用的标签的视频 */
  missing?: boolean;
}

export type ProbeUnitsResult = OrganizeProbeResult;

/**
 * 预览里探测编码：读文件头（有缓存的不读）、把标签填进单元文件、重新规划。按单元点的会重试上次失败的；
 * 「探测缺标签的」对失败过的不再读网盘、照旧算没读到（那些多半是读不了的，错误原因还在）。按本地 strm 结构的清单不套模板，没有探测的意义
 */
export async function probeUnits(runId: string, sel: ProbeSelection, opts: { retryFailed?: boolean } = {}): Promise<ProbeUnitsResult> {
  const { state } = editableRun(runId);
  if (state.local) throw new HttpError(400, "按本地 strm 结构整理的清单不套模板，不用探测编码", { code: "NOT_TMDB_RUN" });
  if (!sel.key && !sel.keys?.length && !sel.missing) throw new HttpError(400, "key、keys 或 missing 至少给一个");
  for (const k of [...(sel.key ? [sel.key] : []), ...(sel.keys ?? [])]) if (!state.units.has(k)) throw new HttpError(404, `单元不存在：${k}`);
  const end = beginOp(runId);
  try {
    const wanted = probeVarsOf(state.org);
    let targets: UnitFile[];
    if (sel.key) targets = videoFilesOf(state, [sel.key]);
    else {
      const scope = sel.keys?.length ? sel.keys : listUnits(runId).filter((r) => r.selected).map((r) => r.key);
      targets = wanted.length === 0 ? [] : videoFilesOf(state, scope).filter((f) => lacksProbeTags(f, wanted));
    }
    const ownerOf = new Map<UnitFile, string>();
    for (const u of state.units.values()) for (const f of u.files) ownerOf.set(f, u.key);
    const provider = providerForTask(state.task);
    const out: ProbeUnitsResult = { probed: 0, cached: 0, failed: 0, units: 0, files: [] };
    const touched = new Set<string>();
    for (const f of targets) {
      const r = await probeDriveFile(provider, provider.account.name, probeTargetOf(state, f), { retryFailed: opts.retryFailed ?? !!sel.key });
      const unitKey = ownerOf.get(f) ?? "";
      if (r.status === "ok" && r.probe) {
        f.probe = probeTags(r.probe);
        out.probed++;
        if (r.cached) out.cached++;
        touched.add(unitKey);
        out.files.push({ path: absOf(state.task, f.path), unitKey, summary: probeSummary(r.probe) });
      } else {
        out.failed++;
        out.files.push({ path: absOf(state.task, f.path), unitKey, error: r.error ?? "没读到" });
      }
    }
    // 从这里到落库没有 await
    const current = assertStillEditable(runId, state);
    const fresh = new Map(listUnits(runId).map((r) => [r.key, r]));
    const changed = new Map<string, OrganizeUnit>();
    for (const key of touched) {
      const row = fresh.get(key);
      if (row) changed.set(key, row);
    }
    if (changed.size > 0) {
      const before = itemsFingerprints(listItems(runId));
      replanRun(current, state, changed);
      const after = itemsFingerprints(listItems(runId));
      out.units = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).length;
    }
    return out;
  } finally {
    end();
  }
}

/** 每个单元的项的指纹（来源、去向、动作）：重新规划前后比一下就知道哪些单元真的变了 */
function itemsFingerprints(items: OrganizeItem[]): Map<string, string> {
  const by = new Map<string, string[]>();
  for (const it of items) {
    const list = by.get(it.unitKey) ?? [];
    list.push(JSON.stringify([it.srcPath, it.dstPath, it.action]));
    by.set(it.unitKey, list);
  }
  return new Map([...by].map(([k, v]) => [k, v.sort().join("\n")]));
}

/** 项上带探测标签（只在预览的单元结构还在内存里时有） */
export function decorateItemsWithProbes(runId: string, items: OrganizeItem[]): OrganizeItem[] {
  const state = planStates.get(runId);
  if (!state) return items;
  const byAbs = new Map<string, MediaProbeTags>();
  for (const u of state.units.values()) for (const f of u.files) if (f.probe) byAbs.set(absOf(state.task, f.path), f.probe);
  if (byAbs.size === 0) return items;
  return items.map((it) => {
    const probe = byAbs.get(it.srcPath);
    return probe ? { ...it, probe } : it;
  });
}

/** 规划一个单元：按本地 strm 结构的 run 走 planLocalUnit，其余走 planUnit */
function planUnitFor(state: PlanState, unit: Unit, input: Omit<UnitPlanInput, "unit">): UnitPlan {
  const local = state.local?.get(unit.key);
  if (local) return planLocalUnit(local, { selected: input.selected, excluded: input.excluded, resolutions: input.resolutions, renames: input.renames });
  return planUnit({ unit, ...input }, planContext(state));
}

/** 自动整理：run 是 auto 模式、全是 high 且没冲突就直接执行；否则留着等人确认并通知 */
async function afterAutoPreview(runId: string, task: TaskDefinition, mode: OrganizeRunMode, units: OrganizeUnit[], stats: OrganizeRunStats): Promise<void> {
  const run = getRun(runId);
  if (stats.planned === 0) {
    // 一项都不用动：直接收尾，内存里的规划状态也用不着了
    planStates.delete(runId);
    updateRun(runId, { status: "done", finishedAt: Math.floor(Date.now() / 1000) });
    if (run) releaseHeldCopies(run);
    return;
  }
  const sure = units.filter((u) => u.selected).every((u) => u.match?.confidence === "high");
  if (mode === "auto" && sure && stats.conflicts === 0) {
    // 让 preview 的 job 先收尾，再起执行的 job
    setTimeout(() => {
      applyRun(runId).catch((err) => log.warn({ err, runId }, "自动执行失败"));
    }, 0);
    return;
  }
  // 要等人确认：不知道要等多久，复制先按现在的样子走
  if (run) releaseHeldCopies(run);
  const unsure = units.filter((u) => u.match && u.match.confidence !== "high").length + units.filter((u) => !u.match).length;
  void deps.notify({ type: "organize-review", task, runId, units: stats.units, planned: stats.planned, unsure, conflicts: stats.conflicts });
}

/* ------------------------------- 预览里改单元 ------------------------------- */

const NOT_EDITABLE = "这次预览是上次启动时做的，单元结构没保存下来，改不了；可以直接执行，或者重新预览";

/**
 * 把 patch 套在一个单元行上（换匹配时带上新的识别结果）；dstRoot / notes 由重新规划填。
 * 换了作品（resetOverrides）原来改的标题 / 年份是上一部的，清掉；同一次里又给了新的照给
 */
function applyUnitPatch(row: OrganizeUnit, patch: OrganizeUnitPatch, picked?: OrganizeMatch, resetOverrides = false): OrganizeUnit {
  return {
    ...row,
    match: picked ?? row.match,
    seasonOverride: patch.seasonOverride === undefined ? row.seasonOverride : patch.seasonOverride,
    episodeOffset: patch.episodeOffset ?? row.episodeOffset,
    selected: patch.selected ?? (patch.match ? true : row.selected),
    remember: patch.remember ?? row.remember,
    titleOverride: patch.title !== undefined ? (patch.title ?? "").trim() : resetOverrides ? "" : row.titleOverride,
    yearOverride: patch.year !== undefined ? (patch.year ?? "").trim() : resetOverrides ? "" : row.yearOverride,
  };
}

/**
 * 预览里改了单元之后整体重新规划：别的单元按内存里的单元结构和库里的匹配 / 季 / 偏移 / 勾选重新规划一遍（顺序和预览一样），
 * 冲突检测、建目录 / 删空目录整体重算。附属文件跟着哪个视频、撞名算不算冲突这些规划期标记不落库，从库里的项反推会丢，
 * 谁先占到目标也会跟着变，所以不能只重做改了的单元。全是同步的：调用方在它之前做完检查，中间不能有 await
 */
function replanRun(run: OrganizeRun, state: PlanState, changed: Map<string, OrganizeUnit>): void {
  const rows = new Map(listUnits(run.id).map((r) => [r.key, r]));
  const plans: UnitPlan[] = [];
  const planned: Array<{ row: OrganizeUnit; plan: UnitPlan }> = [];
  for (const u of state.units.values()) {
    const r = changed.get(u.key) ?? rows.get(u.key);
    if (!r) continue;
    const plan = planUnitFor(state, u, {
      match: r.match,
      seasonOverride: r.seasonOverride,
      episodeOffset: r.episodeOffset,
      fill: state.fills.get(u.key),
      episodeTitles: state.episodeTitles.get(u.key),
      selected: r.selected,
      excluded: excludedRel(state.task, r),
      resolutions: resolutionsRel(state.task, r),
      ...overridesOf(state.task, r),
    });
    planned.push({ row: r, plan });
    plans.push(plan);
  }
  const titlesOf = (key: string) => unitTitles(changed.get(key) ?? rows.get(key));
  const all = finalizeItems(plans, { entries: state.entries, scopeRoots: cleanupRoots(state, titlesOf), items: [], cleanupEmptyDirs: state.org.cleanupEmptyDirs });
  const rmdirs = rmdirsOf(all);
  // 选过的冲突办法这一轮没用上（没撞上：单元取消了勾选、别的单元让开了位置……）就清掉。挂着不清，哪天又撞上了
  // （重新勾上、换回原来的季）会悄悄生效，其中「删掉 / 覆盖」就成了没人再看一眼的删除；撞上了但办法没成的（候选名都被占）留着
  const used = new Set(all.filter((i) => i.resolve && (i.resolved || i.action === "conflict")).map((i) => JSON.stringify([i.unitKey, i.srcPath])));
  for (const { row: r, plan } of planned) {
    const entries = Object.entries(r.resolutions ?? {});
    const kept = entries.filter(([abs]) => used.has(JSON.stringify([r.key, relOf(state.task, abs)])));
    const pruned = kept.length !== entries.length;
    // 换了匹配，单元根删不删可能跟着变（名字对不对得上），引用数照着重算
    const refs = refsOf(state, state.units.get(r.key)!, rmdirs);
    if (changed.has(r.key)) {
      updateUnit(run.id, r.key, {
        ...r,
        ...(pruned ? { resolutions: Object.fromEntries(kept) } : {}),
        referencedBy: refs,
        dstRoot: plan.dstRoot,
        notes: [...(state.identifyNotes.get(r.key) ?? []), ...plan.notes],
      });
    } else if (pruned || refs !== r.referencedBy) {
      updateUnit(run.id, r.key, { ...(pruned ? { resolutions: Object.fromEntries(kept) } : {}), referencedBy: refs });
    }
  }
  replaceItems(run.id, toItemRows(state.task, all));
  updateRun(run.id, { stats: computeStats(listUnits(run.id), listItems(run.id), "apply") });
}

/** 能改的待执行预览：run 在、是 ready、单元结构还在内存里 */
function editableRun(runId: string): { run: OrganizeRun; state: PlanState } {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (run.status !== "ready") throw new HttpError(409, `只有待执行的整理能改（当前 ${run.status}）`);
  const state = planStates.get(runId);
  if (!state) throw new HttpError(409, NOT_EDITABLE);
  return { run, state };
}

/**
 * 落库前再确认一次：等 TMDB / 列目录的时候可能已经开始执行、被取消、被取代或删掉了——那就什么都不写。
 * 从这里到落库不能有 await
 */
function assertStillEditable(runId: string, state: PlanState): OrganizeRun {
  const current = getRun(runId);
  if (!current || current.status !== "ready" || planStates.get(runId) !== state) throw new HttpError(409, "这次预览已经不能改了：已经开始执行、被取消或删掉了");
  return current;
}

/** 改了单元之后目标目录可能是没列过的：把这些单元按改完的样子规划一遍，列一遍目标目录（列不到就按已知的条目算） */
async function listDraftTargets(runId: string, state: PlanState, drafts: UnitPlan[]): Promise<ScopeEntry[]> {
  if (drafts.length === 0) return [];
  try {
    return await listOutsideDstDirs(providerForTask(state.task, "write"), state.task, state.roots, drafts, state.entries, new AbortController().signal, state.listed);
  } catch (err) {
    log.warn({ err, runId }, "列目标目录失败，冲突检测按已知的条目算");
    return [];
  }
}

/**
 * 一次改清单。按顺序：批量勾选单元 → 还没选办法的冲突统一选一个办法 → 逐单元改 → 逐文件改；
 * 换匹配要查的 TMDB、改完目标目录可能没列过要列的，都在前面 await 完，最后确认还能改、只重规划一次。
 * 页面上的三种改法（patchUnit / patchUnits / patchItems）和智能体的批量修改都走这里
 */
export interface PlanPatch {
  /** 批量勾选单元：全选 / 全不选 / 只选把握大的（和整理页的按钮一样；没识别出来的单元不能勾，不动它） */
  select?: "all" | "none" | "confident";
  /**
   * 还没选办法、也没取消勾选的冲突统一这么办；删掉 / 覆盖不给批量选。哪些算「还没选」按落库那一刻的清单定：
   * 等 TMDB / 列目录的时候别人（界面上的用户）刚给某个冲突选了办法或取消了勾选，不能被这里盖回去
   */
  conflicts?: "rename" | "duplicate";
  /** 逐单元：换匹配、季、集偏移、勾选、记住 */
  units?: Array<OrganizeUnitPatch & { key: string }>;
  /**
   * 逐文件：unitKey + srcPath（网盘绝对路径）定位——同一个字幕可能按名字前缀跟到两个单元下，两边各是各的。
   * 勾选 / 取消勾选记在单元的 excluded 里，冲突办法记在 resolutions 里（null 是撤回，回到「留在原处」）。
   * 办法只能给现在是冲突、或者已经选过办法的文件：取消勾选的文件要先勾回来（还冲突再选）。
   * 取消勾选的文件规划时跳过、跟着它的字幕 / nfo 一起留下
   */
  files?: Array<{ unitKey: string; srcPath: string } & FilePatch>;
}

/**
 * 文件级的改动：勾选、冲突办法、钉季 / 集（只给剧集单元里的视频；null 撤掉）、改目标文件名（null 或空串撤掉；不能带目录）、
 * 改判类型（视频当正片 / 当花絮；null 回到按规则）。钉了、改了名、改判了的文件会重新勾上
 */
type FilePatch = { selected?: boolean; resolve?: OrganizeConflictResolution | null; pin?: OrganizeEpisodePin | null; name?: string | null; kind?: OrganizeKindOverride | null };

/**
 * 一个单元套上文件级的改动：勾选记在 excluded、冲突办法记在 resolutions。
 * 选了办法的项本来就勾着（取消勾选的选不了办法，见 patchPlan）；撤回办法（null）= 留在原处，记成取消勾选；取消勾选同时撤掉办法
 */
function applyFilePatches(row: OrganizeUnit, files: Array<[string, FilePatch]>): Pick<OrganizeUnit, "excluded" | "resolutions" | "pins" | "renames" | "kinds"> {
  const excluded = new Set(row.excluded);
  const resolutions = { ...row.resolutions };
  const pins = { ...(row.pins ?? {}) };
  const renames = { ...(row.renames ?? {}) };
  const kinds = { ...(row.kinds ?? {}) };
  for (const [path, fp] of files) {
    const selected = fp.resolve !== undefined ? fp.resolve !== null : fp.selected;
    if (selected !== false) excluded.delete(path);
    else excluded.add(path);
    if (fp.resolve !== undefined || selected === false) {
      if (fp.resolve) resolutions[path] = fp.resolve;
      else delete resolutions[path];
    }
    if (fp.pin !== undefined) {
      const pin = fp.pin && (fp.pin.season !== undefined || fp.pin.episode !== undefined) ? { ...(fp.pin.season !== undefined ? { season: fp.pin.season } : {}), ...(fp.pin.episode !== undefined ? { episode: fp.pin.episode } : {}) } : null;
      if (pin) pins[path] = pin;
      else delete pins[path];
    }
    if (fp.name !== undefined) {
      const name = fp.name?.trim();
      if (name) renames[path] = name;
      else delete renames[path];
    }
    if (fp.kind !== undefined) {
      if (fp.kind) kinds[path] = fp.kind;
      else delete kinds[path];
    }
  }
  return { excluded: [...excluded].sort(), resolutions, pins, renames, kinds };
}

/** 两个单元行在规划上有没有区别（换了匹配是新对象，按引用比就够） */
/** 刷新 TMDB 信息时比「拉回来的和原来一样吗」：只看会落到命名 / 分类 / 海报上的字段 */
function sameMatchData(a: OrganizeMatch, b: OrganizeMatch): boolean {
  const pick = (m: OrganizeMatch) =>
    JSON.stringify([m.title, m.originalTitle, m.enTitle ?? "", m.year, m.posterUrl, m.imdbId ?? "", m.genreIds ?? [], m.countries ?? [], m.originalLanguage ?? "", m.seasons ?? [], m.collection?.name ?? ""]);
  return pick(a) === pick(b);
}

function sameEpisodeTitles(a: Map<string, string> | undefined, b: Map<string, string>): boolean {
  const norm = (m: Map<string, string> | undefined) => JSON.stringify([...(m ?? new Map<string, string>())].sort());
  return norm(a) === norm(b);
}

function sameUnitRow(a: OrganizeUnit, b: OrganizeUnit): boolean {
  return (
    a.match === b.match &&
    a.selected === b.selected &&
    a.remember === b.remember &&
    a.seasonOverride === b.seasonOverride &&
    a.episodeOffset === b.episodeOffset &&
    (a.titleOverride ?? "") === (b.titleOverride ?? "") &&
    (a.yearOverride ?? "") === (b.yearOverride ?? "") &&
    [...a.excluded].sort().join("\n") === [...b.excluded].sort().join("\n") &&
    JSON.stringify(Object.entries(a.resolutions ?? {}).sort()) === JSON.stringify(Object.entries(b.resolutions ?? {}).sort()) &&
    JSON.stringify(Object.entries(a.pins ?? {}).sort()) === JSON.stringify(Object.entries(b.pins ?? {}).sort()) &&
    JSON.stringify(Object.entries(a.renames ?? {}).sort()) === JSON.stringify(Object.entries(b.renames ?? {}).sort()) &&
    JSON.stringify(Object.entries(a.kinds ?? {}).sort()) === JSON.stringify(Object.entries(b.kinds ?? {}).sort())
  );
}

export async function patchPlan(runId: string, input: PlanPatch): Promise<{ changed: string[] }> {
  const { state } = editableRun(runId);
  const end = beginOp(runId);
  try {
    const rows = new Map(listUnits(runId).map((r) => [r.key, r]));
    const unitPatches = new Map<string, OrganizeUnitPatch>();
    for (const { key, ...patch } of input.units ?? []) {
      if (!state.units.has(key) || !rows.has(key)) throw new HttpError(404, "单元不存在");
      if (state.local && (patch.match !== undefined || patch.seasonOverride !== undefined || patch.episodeOffset !== undefined || patch.refresh || patch.remember || patch.title !== undefined || patch.year !== undefined)) {
        throw new HttpError(400, "按本地 strm 结构整理的清单没有识别结果，不能换匹配、改季集、改标题、刷新或记住", { code: "NOT_TMDB_RUN" });
      }
      if (patch.title && patch.title.includes("/")) throw new HttpError(400, "标题不能带 /");
      if (patch.year && !/^\d{4}$/.test(patch.year.trim())) throw new HttpError(400, "年份是四位数字");
      if (!rows.get(key)!.match && !patch.match && (patch.title || patch.year)) throw new HttpError(400, "这部还没识别出来，先换匹配", { code: "NO_MATCH" });
      unitPatches.set(key, { ...unitPatches.get(key), ...patch });
    }
    // 换了匹配 / 季 / 集偏移的单元：文件的目标跟着变，原来给冲突选的办法对着的是旧目标（「覆盖」删的会是另一份），
    // 一律清掉；这一批里也不许再给它选办法——还没看到新的冲突，等重新规划后再选
    const reidentified = new Set<string>();
    for (const [key, patch] of unitPatches) {
      const row = rows.get(key)!;
      const matchChanged = patch.match !== undefined && (!row.match || row.match.tmdbId !== patch.match.tmdbId || row.match.mediaType !== patch.match.mediaType);
      const seasonChanged = patch.seasonOverride !== undefined && patch.seasonOverride !== row.seasonOverride;
      const offsetChanged = patch.episodeOffset !== undefined && patch.episodeOffset !== row.episodeOffset;
      // 刷新 TMDB 信息的也算：目标可能变（拉回来发现没变的，下面会再拿掉）
      if (matchChanged || seasonChanged || offsetChanged || patch.refresh === true) reidentified.add(key);
    }
    // 点名的文件：单元 + 路径要是现在清单里的一项（建目录 / 删空目录不属于任何单元）
    const items = listItems(runId);
    const fileKey = (unitKey: string, srcPath: string) => JSON.stringify([unitKey, srcPath]);
    const known = new Map(items.filter((it) => it.unitKey !== "" && it.kind !== "dir").map((it) => [fileKey(it.unitKey, it.srcPath), it]));
    const conflicts = new Set(items.filter((it) => it.action === "conflict").map((it) => fileKey(it.unitKey, it.srcPath)));
    const named = new Map<string, Map<string, FilePatch>>();
    for (const { unitKey, srcPath, ...patch } of input.files ?? []) {
      const it = known.get(fileKey(unitKey, srcPath));
      if (!it) throw new HttpError(404, "清单里没有这个文件");
      if (patch.pin) {
        // 钉季 / 集只对剧集单元里的视频有意义；本地结构的清单不识别，没有季集
        if (state.local) throw new HttpError(400, "按本地 strm 结构整理的清单不按季集命名，不能钉季 / 集", { code: "NOT_TMDB_RUN" });
        if (it.kind !== "video") throw new HttpError(400, "只有视频能钉季 / 集", { code: "PIN_NOT_VIDEO" });
        const row = rows.get(unitKey);
        const mediaType = unitPatches.get(unitKey)?.match?.mediaType ?? row?.match?.mediaType;
        if (mediaType !== "tv") throw new HttpError(400, "只有剧集的视频能钉季 / 集", { code: "PIN_NOT_TV" });
      }
      if (patch.name && patch.name.includes("/")) throw new HttpError(400, "目标文件名不能带目录");
      if (patch.kind) {
        // 改判只在「这是不是正片」上：只有视频文件有正片 / 花絮之分；本地结构的清单不分
        if (state.local) throw new HttpError(400, "按本地 strm 结构整理的清单不分正片 / 花絮", { code: "NOT_TMDB_RUN" });
        if (it.kind !== "video") throw new HttpError(400, "只有视频能改判成正片 / 花絮", { code: "KIND_NOT_VIDEO" });
      }
      // 办法只给冲突项（和界面一样）；已经选过的可以改主意，撤回总可以。
      // 不然「自己起名」能给任意文件起任意名字，别的办法也会记在单元上、等以后撞上了才生效
      if (patch.resolve && !conflicts.has(fileKey(unitKey, srcPath)) && !rows.get(unitKey)?.resolutions?.[srcPath]) {
        throw new HttpError(400, "只有冲突的文件能选处理办法", { code: "NOT_CONFLICT" });
      }
      if (patch.resolve && reidentified.has(unitKey)) {
        throw new HttpError(400, "这部作品这次换了匹配 / 季 / 集偏移，冲突要等重新规划之后再选办法", { code: "RESOLVE_AFTER_REPLAN" });
      }
      const byPath = named.get(unitKey) ?? new Map<string, FilePatch>();
      byPath.set(srcPath, patch);
      named.set(unitKey, byPath);
    }
    /**
     * 每个单元要套的文件级改动：批量的冲突办法只给「还没选办法、也没取消勾选」的冲突项，按传进来的清单和单元行定；
     * 点名的文件盖过批量的（点名取消勾选的就是不要它）
     */
    const fileChangesOf = (list: OrganizeItem[], unitRows: Map<string, OrganizeUnit>): Map<string, Array<[string, FilePatch]>> => {
      const byUnit = new Map<string, Map<string, FilePatch>>();
      if (input.conflicts) {
        for (const it of list) {
          const row = unitRows.get(it.unitKey);
          if (it.action !== "conflict" || !row || reidentified.has(it.unitKey) || row.resolutions?.[it.srcPath] || row.excluded.includes(it.srcPath)) continue;
          const byPath = byUnit.get(it.unitKey) ?? new Map<string, FilePatch>();
          byPath.set(it.srcPath, { resolve: { how: input.conflicts } });
          byUnit.set(it.unitKey, byPath);
        }
      }
      for (const [unitKey, patches] of named) {
        const byPath = byUnit.get(unitKey) ?? new Map<string, FilePatch>();
        for (const [path, fp] of patches) byPath.set(path, fp);
        byUnit.set(unitKey, byPath);
      }
      return new Map([...byUnit].map(([k, m]) => [k, [...m]]));
    };
    let filesByUnit = fileChangesOf(items, rows);

    // 换匹配：按指定的 TMDB 编号重新识别（查不到就整批不改）。
    // 刷新 TMDB 信息（refresh）：身份不变，按现在的编号跳过缓存重新拉详情和季集；拉回来和原来一样就当没改
    const picked = new Map<string, { match: OrganizeMatch; episodeTitles: Map<string, string>; keep: boolean }>();
    for (const [key, patch] of unitPatches) {
      const row = rows.get(key)!;
      const target = patch.match ?? (patch.refresh ? row.match : undefined);
      if (!target) {
        if (patch.refresh) throw new HttpError(400, "这部还没识别出来，先换匹配", { code: "NO_MATCH" });
        continue;
      }
      const old = row.match && row.match.tmdbId === target.tmdbId && row.match.mediaType === target.mediaType ? row.match : null;
      if (old && !patch.refresh) continue;
      const tmdb = deps.tmdb(state.settings, { fresh: patch.refresh === true });
      if (!tmdb) throw new HttpError(400, "TMDB 未配置 apiKey");
      const r = await identifyUnit(
        { unit: state.units.get(key)!, evidence: { known: { tmdbId: target.tmdbId, mediaType: target.mediaType, source: old ? "刷新 TMDB 信息" : "手动指定" } }, episodeTitles: state.org.episodeTitle },
        tmdb,
      );
      if (!r.match) throw new HttpError(404, `TMDB 上没有 ${target.mediaType} ${target.tmdbId}`);
      if (!old) {
        picked.set(key, { match: { ...r.match, candidates: row.match?.candidates ?? [] }, episodeTitles: r.episodeTitles, keep: false });
        continue;
      }
      // 刷新：把握、理由、备选照旧（用户没确认什么）；详情和集标题都没变就什么都不动，连冲突办法都留着
      const next: OrganizeMatch = { ...r.match, confidence: old.confidence, reason: old.reason, candidates: old.candidates ?? [] };
      if (sameMatchData(old, next) && sameEpisodeTitles(state.episodeTitles.get(key), r.episodeTitles)) {
        reidentified.delete(key);
        continue;
      }
      picked.set(key, { match: next, episodeTitles: r.episodeTitles, keep: true });
    }

    /** 一个单元行套上这次的全部改动 */
    const nextOf = (row: OrganizeUnit): OrganizeUnit => {
      let next = row;
      if (input.select && row.match) {
        next = { ...next, selected: input.select === "all" || (input.select === "confident" && row.match.confidence === "high") };
      }
      const up = unitPatches.get(row.key);
      const pk = picked.get(row.key);
      if (up) next = applyUnitPatch(next, up, pk?.match, !!pk && !pk.keep);
      if (reidentified.has(row.key)) next = { ...next, resolutions: {} };
      const files = filesByUnit.get(row.key);
      if (files) next = { ...next, ...applyFilePatches(next, files) };
      return next;
    };

    // 改完之后要动的单元，目标目录可能是没列过的：按改完的样子规划一遍，先把目标目录列了，冲突检测和 mkdir 判断才准
    const drafts: UnitPlan[] = [];
    for (const row of rows.values()) {
      const next = nextOf(row);
      const unit = state.units.get(row.key);
      if (!unit || sameUnitRow(row, next) || !next.selected || !next.match) continue;
      drafts.push(
        planUnitFor(state, unit, {
          match: next.match,
          seasonOverride: next.seasonOverride,
          episodeOffset: next.episodeOffset,
          fill: picked.has(row.key) && !picked.get(row.key)?.keep ? null : state.fills.get(row.key),
          episodeTitles: picked.get(row.key)?.episodeTitles ?? state.episodeTitles.get(row.key),
          selected: true,
          excluded: excludedRel(state.task, next),
          resolutions: resolutionsRel(state.task, next),
          ...overridesOf(state.task, next),
        }),
      );
    }
    const extra = await listDraftTargets(runId, state, drafts);

    // 从这里到落库没有 await：先确认这次预览还能改，再从库里重读单元套改动——两次修改交错时，后一次不能把前一次的改动盖回去
    const current = assertStillEditable(runId, state);
    mergeEntries(state, extra);
    for (const [key, p] of picked) {
      state.episodeTitles.set(key, p.episodeTitles);
      // 刷新不是换作品：识别时的备注和记忆补的季都还作数
      if (p.keep) continue;
      state.identifyNotes.set(key, []);
      state.fills.delete(key);
    }
    // 批量的冲突办法按这一刻的清单和单元行重新定：等的时候别人可能刚改过
    const freshRows = listUnits(runId);
    if (input.conflicts) filesByUnit = fileChangesOf(listItems(runId), new Map(freshRows.map((r) => [r.key, r])));
    const changed = new Map<string, OrganizeUnit>();
    for (const fresh of freshRows) {
      if (!state.units.has(fresh.key)) continue;
      const next = nextOf(fresh);
      if (!sameUnitRow(fresh, next)) changed.set(fresh.key, next);
    }
    if (changed.size > 0) replanRun(current, state, changed);
    return { changed: [...changed.keys()] };
  } finally {
    end();
  }
}

/** 预览里改一个单元：换匹配 / 季 / 集偏移 / 勾选 / 记住 */
export async function patchUnit(runId: string, key: string, patch: OrganizeUnitPatch): Promise<OrganizeUnit> {
  const { state } = editableRun(runId);
  if (!state.units.has(key) || !getUnit(runId, key)) throw new HttpError(404, "单元不存在");
  await patchPlan(runId, { units: [{ ...patch, key }] });
  return getUnit(runId, key)!;
}

/** 批量勾选 / 取消勾选单元（全选、全不选、只选把握大的）：一次重规划，不是一个单元一次。没识别出来的单元不能勾 */
export async function patchUnits(runId: string, keys: string[], patch: { selected?: boolean; remember?: boolean }): Promise<{ changed: number }> {
  const { state } = editableRun(runId);
  const wanted = new Set(keys);
  const units = listUnits(runId)
    .filter((r) => wanted.has(r.key) && (r.match || state.local) && state.units.has(r.key))
    .map((r) => ({ key: r.key, ...(patch.selected !== undefined ? { selected: patch.selected } : {}), ...(patch.remember !== undefined ? { remember: patch.remember } : {}) }));
  const { changed } = await patchPlan(runId, { units });
  return { changed: changed.length };
}

/** 页面按文件改：ids 是当前清单里的项（重规划之后 id 会换，页面拿最新的清单）；不认识的 id 不管 */
export interface ItemsPatch {
  selected?: boolean;
  /** 给冲突项选的办法；null 是撤回选择，回到「留在原处」 */
  resolve?: OrganizeConflictResolution | null;
  /** 钉季 / 集（剧集单元里的视频）；null 撤掉 */
  pin?: OrganizeEpisodePin | null;
  /** 改目标文件名（不带目录，没写扩展名沿用原来的）；null 撤掉 */
  name?: string | null;
  /** 改判类型：video 当正片、extra 当花絮；null 回到按规则判断 */
  kind?: OrganizeKindOverride | null;
}

export async function patchItems(runId: string, ids: string[], patch: ItemsPatch): Promise<{ changed: number }> {
  editableRun(runId);
  const wanted = new Set(ids);
  const files = listItems(runId)
    .filter((it) => wanted.has(it.id) && it.unitKey !== "" && it.kind !== "dir")
    .map((it) => ({
      unitKey: it.unitKey,
      srcPath: it.srcPath,
      ...(patch.selected !== undefined ? { selected: patch.selected } : {}),
      ...(patch.resolve !== undefined ? { resolve: patch.resolve } : {}),
      ...(patch.pin !== undefined ? { pin: patch.pin } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    }));
  const { changed } = await patchPlan(runId, { files });
  return { changed: changed.length };
}

/* ------------------------------- 换匹配弹框的 TMDB 搜索 ------------------------------- */

function tmdbOrThrow(): TmdbApi {
  const tmdb = deps.tmdb(readAppSettings());
  if (!tmdb) throw new HttpError(400, "TMDB 未配置 apiKey，请先在设置中填入");
  return tmdb;
}

const toPick = (r: Pick<TmdbSearchResult, "id" | "title" | "year" | "posterUrl">, mediaType: OrganizeCandidate["mediaType"]): OrganizeCandidate => ({
  tmdbId: r.id,
  mediaType,
  title: r.title,
  year: r.year,
  posterUrl: r.posterUrl,
  score: 0,
});

/** 换匹配弹框的搜索：可以限定类型和年份；不限类型但给了年份时电影、剧集各搜一次（TMDB 的 multi 搜索不认年份） */
export async function searchCandidates(q: { query: string; type?: OrganizeCandidate["mediaType"]; year?: string }): Promise<OrganizeCandidate[]> {
  const tmdb = tmdbOrThrow();
  const year = q.year && /^(19|20)\d{2}$/.test(q.year) ? q.year : undefined;
  let results: TmdbSearchResult[];
  try {
    if (q.type) results = await tmdb.search(q.query, q.type, year);
    else if (year) results = [...(await tmdb.search(q.query, "movie", year)), ...(await tmdb.search(q.query, "tv", year))];
    else results = await tmdb.search(q.query, "multi");
  } catch (err) {
    throw upstreamError(`TMDB 搜索失败：${messageOf(err)}`);
  }
  const seen = new Set<string>();
  const out: OrganizeCandidate[] = [];
  for (const r of results) {
    if (r.mediaType !== "movie" && r.mediaType !== "tv") continue;
    const key = `${r.mediaType}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toPick(r, r.mediaType));
  }
  return out;
}

/** 按 TMDB 编号查一部：换匹配弹框里直接填编号 / 贴链接 */
/** 按编号查一部作品：候选的样子，外加原名和剧集的每季集数（智能体核对季 / 集偏移用） */
export async function lookupWork(
  mediaType: OrganizeCandidate["mediaType"],
  tmdbId: number,
): Promise<{ candidate: OrganizeCandidate; originalTitle: string; seasons?: OrganizeSeasonInfo[] }> {
  const tmdb = tmdbOrThrow();
  let d: TmdbDetails | null;
  try {
    d = await tmdb.details(mediaType, tmdbId);
  } catch (err) {
    throw upstreamError(`TMDB 查询失败：${messageOf(err)}`);
  }
  if (!d) throw new HttpError(404, `TMDB 上没有${mediaType === "movie" ? "电影" : "剧集"} ${tmdbId}`);
  return {
    candidate: toPick({ id: d.id, title: d.title || d.originalTitle, year: d.year, posterUrl: d.posterUrl }, mediaType),
    originalTitle: d.originalTitle,
    ...(d.seasons ? { seasons: d.seasons } : {}),
  };
}

/** 改标题弹框用：这部作品在 TMDB 上的译名、原名、英文名和别名（alternative_titles + 各语言翻译），人从里面挑或照着改 */
export async function lookupTitles(mediaType: OrganizeCandidate["mediaType"], tmdbId: number): Promise<{ title: string; originalTitle: string; enTitle: string; year: string; aliases: string[] }> {
  const tmdb = tmdbOrThrow();
  let d: TmdbDetails | null;
  try {
    d = await tmdb.details(mediaType, tmdbId);
  } catch (err) {
    throw upstreamError(`TMDB 查询失败：${messageOf(err)}`);
  }
  if (!d) throw new HttpError(404, `TMDB 上没有${mediaType === "movie" ? "电影" : "剧集"} ${tmdbId}`);
  const main = new Set([d.title, d.originalTitle, d.enTitle].map((t) => t.trim()).filter(Boolean));
  const aliases = [...new Set(d.aliases.map((a) => a.trim()).filter((a) => a && !main.has(a)))];
  return { title: d.title || d.originalTitle, originalTitle: d.originalTitle, enTitle: d.enTitle, year: d.year, aliases };
}

export async function lookupCandidate(mediaType: OrganizeCandidate["mediaType"], tmdbId: number): Promise<OrganizeCandidate> {
  const tmdb = tmdbOrThrow();
  let d: TmdbDetails | null;
  try {
    d = await tmdb.details(mediaType, tmdbId);
  } catch (err) {
    throw upstreamError(`TMDB 查询失败：${messageOf(err)}`);
  }
  if (!d) throw new HttpError(404, `TMDB 上没有${mediaType === "movie" ? "电影" : "剧集"} ${tmdbId}`);
  return toPick({ id: d.id, title: d.title || d.originalTitle, year: d.year, posterUrl: d.posterUrl }, mediaType);
}
