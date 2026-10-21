/**
 * 整理的持久化：run / unit / item 三张表 + 识别记忆 + TMDB 缓存。
 * item 的 src_path / dst_path 是网盘绝对路径（带前导 /）；时间戳一律秒。
 */
import { and, asc, desc, eq, gt, inArray, like, lt, ne, or, sql } from "drizzle-orm";
import type { OrganizeAction, OrganizeConfidence, OrganizeErrorKind, OrganizeFileKind, OrganizeHint, OrganizeItem, OrganizeItemStatus, OrganizeMatch, OrganizeMatchMemory, OrganizeNaming, OrganizeMediaType, OrganizeRun, OrganizeRunMode, OrganizeRunStage, OrganizeRunStats, OrganizeRunStatus, OrganizeTrigger, OrganizeUnit, OrganizeSkip } from "@openstrm/shared";
import { db } from "../client.js";
import { organizeItems, organizeMatches, organizeRuns, organizeUnits, tmdbCache, organizeSkips } from "../schema.js";

type RunRow = typeof organizeRuns.$inferSelect;
type UnitRow = typeof organizeUnits.$inferSelect;
type ItemRow = typeof organizeItems.$inferSelect;
type MatchRow = typeof organizeMatches.$inferSelect;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function emptyStats(): OrganizeRunStats {
  return {
    units: 0,
    items: 0,
    planned: 0,
    plannedMkdir: 0,
    plannedRmdir: 0,
    plannedDelete: 0,
    keep: 0,
    conflicts: 0,
    skipped: 0,
    done: 0,
    failed: 0,
    reverted: 0,
    pending: 0,
    confidence: { high: 0, medium: 0, low: 0, none: 0 },
    failedByKind: { transient: 0, blocked: 0, stale: 0, rejected: 0, mirror: 0 },
    notReverted: 0,
  };
}

const RUN_STATUSES: OrganizeRunStatus[] = ["planning", "ready", "applying", "done", "failed", "cancelled", "reverting", "reverted"];
const ITEM_STATUSES: OrganizeItemStatus[] = ["pending", "done", "failed", "skipped", "reverted"];
const ERROR_KINDS: OrganizeErrorKind[] = ["", "transient", "blocked", "stale", "rejected", "mirror"];

const coerce = <T extends string>(v: string, list: readonly T[], fallback: T): T => ((list as readonly string[]).includes(v) ? (v as T) : fallback);

function toRun(row: RunRow): OrganizeRun {
  return {
    id: row.id,
    taskId: row.taskId,
    accountName: row.accountName,
    scopePath: row.scopePath,
    scopePaths: parseJson<string[]>(row.scopePaths, []),
    mode: row.mode === "auto" ? "auto" : row.mode === "review" ? "review" : "manual",
    trigger: coerce<OrganizeTrigger>(row.trigger, ["manual", "agent", "share", "follow", "offline", "monitor", "copy"], "manual"),
    naming: row.naming === "local" ? "local" : "tmdb",
    status: coerce(row.status, RUN_STATUSES, "failed"),
    stage: row.stage === "revert" ? "revert" : "apply",
    stats: { ...emptyStats(), ...parseJson<Partial<OrganizeRunStats>>(row.stats, {}) },
    error: row.error,
    log: parseJson<string[]>(row.log, []),
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  };
}

function toUnit(row: UnitRow): OrganizeUnit {
  return {
    runId: row.runId,
    key: row.key,
    rootPath: row.rootPath,
    rawName: row.rawName,
    parsedTitle: row.parsedTitle,
    parsedYear: row.parsedYear,
    match: parseJson<OrganizeMatch | null>(row.match, null),
    seasonOverride: row.seasonOverride ?? null,
    episodeOffset: row.episodeOffset,
    dstRoot: row.dstRoot,
    selected: row.selected,
    remember: row.remember,
    fileCount: row.fileCount,
    videoCount: row.videoCount,
    referencedBy: row.referencedBy,
    notes: parseJson<string[]>(row.notes, []),
    excluded: parseJson<string[]>(row.excluded, []),
    resolutions: parseJson<OrganizeUnit["resolutions"]>(row.resolutions, {}),
    titleOverride: row.titleOverride ?? "",
    yearOverride: row.yearOverride ?? "",
    pins: parseJson<OrganizeUnit["pins"]>(row.pins, {}),
    renames: parseJson<OrganizeUnit["renames"]>(row.renames, {}),
    kinds: parseJson<OrganizeUnit["kinds"]>(row.kinds, {}),
    missing: parseJson<OrganizeUnit["missing"]>(row.missing, {}),
  };
}

function toItem(row: ItemRow): OrganizeItem {
  return {
    id: row.id,
    runId: row.runId,
    unitKey: row.unitKey,
    seq: row.seq,
    kind: row.kind as OrganizeFileKind,
    action: row.action as OrganizeAction,
    srcPath: row.srcPath,
    dstPath: row.dstPath,
    nodeId: row.nodeId,
    reason: row.reason,
    status: coerce(row.status, ITEM_STATUSES, "pending"),
    error: row.error,
    errorKind: coerce(row.errorKind, ERROR_KINDS, ""),
    attempts: row.attempts,
    givenUp: row.givenUp,
    finishedAt: row.finishedAt ?? null,
    curPath: row.curPath,
    hits: row.hits,
  };
}

function toMemory(row: MatchRow): OrganizeMatchMemory {
  return {
    accountName: row.accountName,
    srcPath: row.srcPath,
    mediaType: row.mediaType === "movie" ? "movie" : "tv",
    tmdbId: row.tmdbId,
    title: row.title,
    year: row.year,
    season: row.season ?? null,
    episodeOffset: row.episodeOffset,
    titleOverride: row.titleOverride ?? "",
    yearOverride: row.yearOverride ?? "",
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------- runs ------------------------------- */

export interface NewRun {
  id: string;
  taskId: string;
  accountName: string;
  scopePath: string;
  scopePaths: string[];
  /** 新增路径带的识别提示（追更给的），预览 / 重新预览照用；不放进 OrganizeRun，界面用不着 */
  hints?: OrganizeHint[];
  mode: OrganizeRunMode;
  trigger: OrganizeTrigger;
  naming?: OrganizeNaming;
}

export function insertRun(run: NewRun): OrganizeRun {
  const createdAt = Math.floor(Date.now() / 1000);
  db.insert(organizeRuns)
    .values({
      id: run.id,
      taskId: run.taskId,
      accountName: run.accountName,
      scopePath: run.scopePath,
      scopePaths: JSON.stringify(run.scopePaths),
      hints: JSON.stringify(run.hints ?? []),
      mode: run.mode,
      trigger: run.trigger,
      naming: run.naming ?? "tmdb",
      status: "planning",
      stats: JSON.stringify(emptyStats()),
      createdAt,
    })
    .run();
  return getRun(run.id)!;
}

export function getRunHints(id: string): OrganizeHint[] {
  const row = db.select({ hints: organizeRuns.hints }).from(organizeRuns).where(eq(organizeRuns.id, id)).get();
  return row ? parseJson<OrganizeHint[]>(row.hints, []) : [];
}

export function getRun(id: string): OrganizeRun | null {
  const row = db.select().from(organizeRuns).where(eq(organizeRuns.id, id)).get();
  return row ? toRun(row) : null;
}

export interface RunPatch {
  status?: OrganizeRunStatus;
  stage?: OrganizeRunStage;
  stats?: OrganizeRunStats;
  error?: string;
  log?: string[];
  startedAt?: number | null;
  finishedAt?: number | null;
}

export function updateRun(id: string, patch: RunPatch): void {
  const set: Partial<typeof organizeRuns.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.stage !== undefined) set.stage = patch.stage;
  if (patch.stats !== undefined) set.stats = JSON.stringify(patch.stats);
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.log !== undefined) set.log = JSON.stringify(patch.log.slice(-300));
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  if (Object.keys(set).length === 0) return;
  db.update(organizeRuns).set(set).where(eq(organizeRuns.id, id)).run();
}

export function listRuns(opts: { taskId?: string; limit?: number; offset?: number } = {}): OrganizeRun[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const q = db
    .select()
    .from(organizeRuns)
    .where(opts.taskId ? eq(organizeRuns.taskId, opts.taskId) : undefined)
    .orderBy(desc(organizeRuns.createdAt), desc(sql`${organizeRuns}.rowid`))
    .limit(limit)
    .offset(opts.offset ?? 0);
  return q.all().map(toRun);
}

export function listRunsByStatus(statuses: OrganizeRunStatus[]): OrganizeRun[] {
  if (statuses.length === 0) return [];
  return db.select().from(organizeRuns).where(inArray(organizeRuns.status, statuses)).all().map(toRun);
}

/**
 * 挡着这次撤销的后续整理：同一任务里比这次更晚建的 run，动过这次整理挪好的文件——它的改名 / 移动项的源路径正好是这次
 * done 项的目标路径，而且它确实做了（done，或者改了名还没挪走带着 cur_path），用户也没对那一项放弃撤销。
 * 这时文件已经被它挪走了，得先撤它。不相干的后续整理（别的目录、自动整理的新一集）不挡：逐项撤销本来就逐项核对位置。
 * 只比路径不比节点 id（OpenList 的 id 不可靠）；「更晚」按 rowid（插入顺序）比，created_at 只有秒
 */
export function laterRunTouching(run: OrganizeRun): { id: string; createdAt: number } | null {
  const row = db
    .select({ id: organizeRuns.id, createdAt: organizeRuns.createdAt })
    .from(organizeRuns)
    .where(
      and(
        eq(organizeRuns.taskId, run.taskId),
        sql`${organizeRuns}.rowid > (select rowid from ${organizeRuns} where ${organizeRuns.id} = ${run.id})`,
        sql`exists (
          select 1 from ${organizeItems} b
          where b.run_id = ${organizeRuns.id} and b.action in ('rename', 'move') and b.given_up = 0 and (b.status = 'done' or b.cur_path != '')
            and b.src_path in (select a.dst_path from ${organizeItems} a where a.run_id = ${run.id} and a.action in ('rename', 'move') and a.status = 'done')
        )`,
      ),
    )
    .orderBy(asc(sql`${organizeRuns}.rowid`))
    .limit(1)
    .get();
  return row ?? null;
}

/** 同任务里 since 之后落过盘的另一次整理 / 撤销（结束得比 since 晚、有 done / reverted 的项）：给「预览旧了」的提示用 */
export function changedSince(taskId: string, sinceSec: number, excludeId: string): { id: string; finishedAt: number } | null {
  const row = db
    .select({ id: organizeRuns.id, finishedAt: organizeRuns.finishedAt })
    .from(organizeRuns)
    .where(
      and(
        eq(organizeRuns.taskId, taskId),
        ne(organizeRuns.id, excludeId),
        gt(organizeRuns.finishedAt, sinceSec),
        sql`exists (select 1 from ${organizeItems} where ${organizeItems.runId} = ${organizeRuns.id} and ${organizeItems.status} in ('done', 'reverted'))`,
      ),
    )
    .orderBy(desc(organizeRuns.finishedAt))
    .limit(1)
    .get();
  return row && row.finishedAt !== null ? { id: row.id, finishedAt: row.finishedAt } : null;
}

export function deleteRun(id: string): boolean {
  return db.transaction((tx) => {
    tx.delete(organizeItems).where(eq(organizeItems.runId, id)).run();
    tx.delete(organizeUnits).where(eq(organizeUnits.runId, id)).run();
    return tx.delete(organizeRuns).where(eq(organizeRuns.id, id)).run().changes > 0;
  });
}

/**
 * 留存清理：删掉早于 cutoff、不在进行中的 run（连同 unit / item），放着没执行的预览也算。
 * 每个任务留最近 keepAppliedPerTask 次真正执行过的（有 done 的项，撤销要用的是它们）；没执行过的预览、预览阶段就失败 / 取消的不占名额
 */
export function deleteFinishedRunsBefore(cutoffSec: number, keepAppliedPerTask = 5): number {
  const rows = db
    .select({ id: organizeRuns.id, taskId: organizeRuns.taskId })
    .from(organizeRuns)
    .where(and(lt(organizeRuns.createdAt, cutoffSec), inArray(organizeRuns.status, ["ready", "done", "failed", "cancelled", "reverted"])))
    .all();
  const keep = new Set<string>();
  for (const taskId of new Set(rows.map((r) => r.taskId))) {
    const applied = db
      .select({ id: organizeRuns.id })
      .from(organizeRuns)
      .where(
        and(
          eq(organizeRuns.taskId, taskId),
          sql`exists (select 1 from ${organizeItems} where ${organizeItems.runId} = ${organizeRuns.id} and ${organizeItems.status} = 'done')`,
        ),
      )
      .orderBy(desc(sql`${organizeRuns}.rowid`))
      .limit(keepAppliedPerTask)
      .all();
    for (const r of applied) keep.add(r.id);
  }
  let n = 0;
  for (const r of rows) if (!keep.has(r.id) && deleteRun(r.id)) n++;
  return n;
}

/* ------------------------------- units ------------------------------- */

export function replaceUnits(runId: string, units: OrganizeUnit[]): void {
  db.transaction((tx) => {
    tx.delete(organizeUnits).where(eq(organizeUnits.runId, runId)).run();
    for (const u of units) {
      tx.insert(organizeUnits)
        .values({
          runId,
          key: u.key,
          rootPath: u.rootPath,
          rawName: u.rawName,
          parsedTitle: u.parsedTitle,
          parsedYear: u.parsedYear,
          match: u.match ? JSON.stringify(u.match) : null,
          seasonOverride: u.seasonOverride,
          episodeOffset: u.episodeOffset,
          dstRoot: u.dstRoot,
          selected: u.selected,
          remember: u.remember,
          fileCount: u.fileCount,
          videoCount: u.videoCount,
          referencedBy: u.referencedBy,
          notes: JSON.stringify(u.notes),
          excluded: JSON.stringify(u.excluded ?? []),
          resolutions: JSON.stringify(u.resolutions ?? {}),
          titleOverride: u.titleOverride ?? "",
          yearOverride: u.yearOverride ?? "",
          pins: JSON.stringify(u.pins ?? {}),
          renames: JSON.stringify(u.renames ?? {}),
          kinds: JSON.stringify(u.kinds ?? {}),
          missing: JSON.stringify(u.missing ?? {}),
        })
        .run();
    }
  });
}

export function listUnits(runId: string): OrganizeUnit[] {
  return db.select().from(organizeUnits).where(eq(organizeUnits.runId, runId)).orderBy(asc(organizeUnits.rootPath), asc(organizeUnits.key)).all().map(toUnit);
}

export function getUnit(runId: string, key: string): OrganizeUnit | null {
  const row = db.select().from(organizeUnits).where(and(eq(organizeUnits.runId, runId), eq(organizeUnits.key, key))).get();
  return row ? toUnit(row) : null;
}

export function updateUnit(runId: string, key: string, patch: Partial<OrganizeUnit>): OrganizeUnit | null {
  return db.transaction((tx) => {
    const row = tx.select().from(organizeUnits).where(and(eq(organizeUnits.runId, runId), eq(organizeUnits.key, key))).get();
    if (!row) return null;
    const merged: OrganizeUnit = { ...toUnit(row), ...patch, runId, key };
    tx.update(organizeUnits)
      .set({
        match: merged.match ? JSON.stringify(merged.match) : null,
        seasonOverride: merged.seasonOverride,
        episodeOffset: merged.episodeOffset,
        dstRoot: merged.dstRoot,
        selected: merged.selected,
        remember: merged.remember,
        referencedBy: merged.referencedBy,
        notes: JSON.stringify(merged.notes),
        excluded: JSON.stringify(merged.excluded ?? []),
        resolutions: JSON.stringify(merged.resolutions ?? {}),
        titleOverride: merged.titleOverride ?? "",
        yearOverride: merged.yearOverride ?? "",
        pins: JSON.stringify(merged.pins ?? {}),
        renames: JSON.stringify(merged.renames ?? {}),
        kinds: JSON.stringify(merged.kinds ?? {}),
        missing: JSON.stringify(merged.missing ?? {}),
        parsedTitle: merged.parsedTitle,
        parsedYear: merged.parsedYear,
      })
      .where(and(eq(organizeUnits.runId, runId), eq(organizeUnits.key, key)))
      .run();
    return merged;
  });
}

/* ------------------------------- items ------------------------------- */

export type NewItem = Omit<OrganizeItem, "runId" | "status" | "error" | "errorKind" | "attempts" | "givenUp" | "finishedAt" | "curPath" | "hits"> & {
  status?: OrganizeItemStatus;
  error?: string;
};

function itemValues(runId: string, it: NewItem): typeof organizeItems.$inferInsert {
  return {
    id: it.id,
    runId,
    unitKey: it.unitKey,
    seq: it.seq,
    kind: it.kind,
    action: it.action,
    srcPath: it.srcPath,
    dstPath: it.dstPath,
    nodeId: it.nodeId,
    reason: it.reason,
    status: it.status ?? "pending",
    error: it.error ?? "",
  };
}

export function replaceItems(runId: string, items: NewItem[]): void {
  db.transaction((tx) => {
    tx.delete(organizeItems).where(eq(organizeItems.runId, runId)).run();
    for (const it of items) tx.insert(organizeItems).values(itemValues(runId, it)).run();
  });
}

/** 一次整理的项（按 seq）；给了 unitKey 只要这个单元的（"" 是建目录 / 删空目录） */
export function listItems(runId: string, unitKey?: string): OrganizeItem[] {
  return db
    .select()
    .from(organizeItems)
    .where(unitKey === undefined ? eq(organizeItems.runId, runId) : and(eq(organizeItems.runId, runId), eq(organizeItems.unitKey, unitKey)))
    .orderBy(asc(organizeItems.seq))
    .all()
    .map(toItem);
}

export function updateItem(
  id: string,
  patch: Partial<Pick<OrganizeItem, "status" | "error" | "errorKind" | "attempts" | "givenUp" | "nodeId" | "finishedAt" | "dstPath" | "srcPath" | "curPath" | "hits">>,
): void {
  const set: Partial<typeof organizeItems.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.errorKind !== undefined) set.errorKind = patch.errorKind;
  if (patch.attempts !== undefined) set.attempts = patch.attempts;
  if (patch.givenUp !== undefined) set.givenUp = patch.givenUp;
  if (patch.nodeId !== undefined) set.nodeId = patch.nodeId;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  if (patch.dstPath !== undefined) set.dstPath = patch.dstPath;
  if (patch.srcPath !== undefined) set.srcPath = patch.srcPath;
  if (patch.curPath !== undefined) set.curPath = patch.curPath;
  if (patch.hits !== undefined) set.hits = patch.hits;
  if (Object.keys(set).length === 0) return;
  db.update(organizeItems).set(set).where(eq(organizeItems.id, id)).run();
}

export function updateItems(ids: string[], patch: Partial<Pick<OrganizeItem, "status" | "error" | "errorKind" | "givenUp" | "finishedAt" | "curPath">>): void {
  if (ids.length === 0) return;
  const set: Partial<typeof organizeItems.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.errorKind !== undefined) set.errorKind = patch.errorKind;
  if (patch.givenUp !== undefined) set.givenUp = patch.givenUp;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  if (patch.curPath !== undefined) set.curPath = patch.curPath;
  if (Object.keys(set).length === 0) return;
  db.update(organizeItems).set(set).where(inArray(organizeItems.id, ids)).run();
}

/** 这些项又跑了一轮：attempts + 1 */
export function bumpAttempts(ids: string[]): void {
  if (ids.length === 0) return;
  db.update(organizeItems).set({ attempts: sql`${organizeItems.attempts} + 1` }).where(inArray(organizeItems.id, ids)).run();
}

const OWN_WINDOW_S = 24 * 3600;
/** 执行、撤销各一条 rename + 一条 move（115 把挪 + 改名分两条事件报），再多就是别人动的 */
const OWN_MAX_HITS = 4;
const dirOfPath = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const baseOfPath = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * 网盘监控用：这条事件（节点 nodeId 出现在 path，时间 at）是不是整理自己做的。
 *   - 执行过的项（done）：新路径是 dstPath，或者先原地改名后的中间路径 `源目录/新名字`
 *   - 撤销过的项（reverted）：新路径是 srcPath，或者反向的中间路径 `目标目录/旧名字`
 *   - 建目录项（mkdir done）：夸克快照会把新目录报成 create，115 报成 folder
 *   - 删目录的事件（kind = remove）：只按节点认执行时删掉的源目录（rmdir done）和撤销时删掉的自建目录（mkdir reverted）
 *   - 执行中的项（pending 且 cur_path 非空）：已经原地改了名还没挪走，改名事件的路径是中间名字，移动事件的路径是目标
 * 只认操作之后 24 小时内、且事件时间不早于操作的；每项最多认 OWN_MAX_HITS 条，之后同一节点再动就是用户动的
 */
export function findOwnOperation(nodeId: string, path: string, at: number, kind: "remove" | "other" = "other"): OrganizeItem | null {
  if (!nodeId) return null;
  const cutoff = Math.floor(Date.now() / 1000) - OWN_WINDOW_S;
  const rows = db
    .select()
    .from(organizeItems)
    .where(
      and(
        eq(organizeItems.nodeId, nodeId),
        lt(organizeItems.hits, OWN_MAX_HITS),
        or(
          and(inArray(organizeItems.status, ["done", "reverted"]), gt(organizeItems.finishedAt, cutoff)),
          // 执行中：原地改完名还没挪走的项（大范围整理要跑好几分钟，监控会在这个窗口里拉到改名事件）
          and(eq(organizeItems.status, "pending"), ne(organizeItems.curPath, "")),
        ),
      ),
    )
    .orderBy(desc(organizeItems.finishedAt))
    .limit(10)
    .all()
    .map(toItem);
  for (const it of rows) {
    if (it.status === "pending") {
      // 改名事件报的是中间名字；批量挪完、还没来得及记账时移动事件报的是目标
      if (kind !== "remove" && (path === it.curPath || path === it.dstPath)) return it;
      continue;
    }
    // 事件比操作还早（快照式来源的时间是扫描时间，给 5 分钟余量）
    if (it.finishedAt !== null && at > 0 && at < it.finishedAt - 300) continue;
    // 删目录的事件：目录已经不在路径缓存里，事件报的路径靠不住，按节点认——执行时删掉的腾空源目录（撤销时重建的是新节点，
    // 旧节点的删除只可能是我们做的，所以不看状态）、撤销时删掉的自建目录（done 的自建目录被删就是用户删的，要照常处理）。
    // 文件从来不删，所以文件节点的删除一定是用户做的
    if (kind === "remove") {
      if (it.action === "rmdir" || (it.action === "mkdir" && it.status === "reverted")) return it;
      continue;
    }
    // 执行是先原地改名再挪走，撤销是先挪回再改回原名，两边的中间位置都是 `源目录/新名字`
    const intermediate = `${dirOfPath(it.srcPath)}/${baseOfPath(it.dstPath)}`;
    if (it.status === "done") {
      if (path === it.dstPath || path === intermediate) return it;
    } else if (path === it.srcPath || path === intermediate) return it;
  }
  return null;
}

/** 监控跳过了一条：计一次，超过 OWN_MAX_HITS 就不再认 */
export function bumpOwnHit(id: string): void {
  db.update(organizeItems).set({ hits: sql`${organizeItems.hits} + 1` }).where(eq(organizeItems.id, id)).run();
}

/**
 * 同任务别的整理撤销时因为不空留下的自建目录（mkdir 项 skipped、建过、没放弃），dstPath 在给出的这些目录里：
 * 后面的整理撤销把文件挪走以后，这些目录可能空了
 */
export function listLeftoverDirs(taskId: string, excludeRunId: string, paths: string[]): OrganizeItem[] {
  if (paths.length === 0) return [];
  return db
    .select()
    .from(organizeItems)
    .where(
      and(
        eq(organizeItems.action, "mkdir"),
        eq(organizeItems.status, "skipped"),
        ne(organizeItems.nodeId, ""),
        ne(organizeItems.runId, excludeRunId),
        inArray(organizeItems.dstPath, paths),
        sql`${organizeItems.givenUp} = 0`,
        sql`${organizeItems.runId} in (select id from ${organizeRuns} where ${organizeRuns.taskId} = ${taskId} and ${organizeRuns.stage} = 'revert')`,
      ),
    )
    .all()
    .map(toItem);
}

/* ------------------------------- 识别记忆 ------------------------------- */

/** 记一条识别记忆（改的标题 / 年份可不给，当没改） */
export function rememberMatch(m: Omit<OrganizeMatchMemory, "updatedAt" | "titleOverride" | "yearOverride"> & Partial<Pick<OrganizeMatchMemory, "titleOverride" | "yearOverride">>): void {
  const updatedAt = Math.floor(Date.now() / 1000);
  db.insert(organizeMatches)
    .values({
      accountName: m.accountName,
      srcPath: m.srcPath,
      mediaType: m.mediaType,
      tmdbId: m.tmdbId,
      title: m.title,
      year: m.year,
      season: m.season,
      episodeOffset: m.episodeOffset,
      titleOverride: m.titleOverride ?? "",
      yearOverride: m.yearOverride ?? "",
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [organizeMatches.accountName, organizeMatches.srcPath],
      set: {
        mediaType: m.mediaType,
        tmdbId: m.tmdbId,
        title: m.title,
        year: m.year,
        season: m.season,
        episodeOffset: m.episodeOffset,
        titleOverride: m.titleOverride ?? "",
        yearOverride: m.yearOverride ?? "",
        updatedAt,
      },
    })
    .run();
}

export function recallMatch(accountName: string, srcPath: string): OrganizeMatchMemory | null {
  const row = db
    .select()
    .from(organizeMatches)
    .where(and(eq(organizeMatches.accountName, accountName), eq(organizeMatches.srcPath, srcPath)))
    .get();
  return row ? toMemory(row) : null;
}

export function forgetMatch(accountName: string, srcPath: string): boolean {
  return db.delete(organizeMatches).where(and(eq(organizeMatches.accountName, accountName), eq(organizeMatches.srcPath, srcPath))).run().changes > 0;
}

/** 目录被整理挪走后，记忆跟着改路径，下次在新位置也认得 */
export function repathMatches(accountName: string, oldPath: string, newPath: string): number {
  const rows = db
    .select()
    .from(organizeMatches)
    .where(and(eq(organizeMatches.accountName, accountName), or(eq(organizeMatches.srcPath, oldPath), like(organizeMatches.srcPath, `${oldPath}/%`))))
    .all();
  let n = 0;
  db.transaction((tx) => {
    for (const r of rows) {
      const next = r.srcPath === oldPath ? newPath : `${newPath}${r.srcPath.slice(oldPath.length)}`;
      tx.delete(organizeMatches).where(and(eq(organizeMatches.accountName, accountName), eq(organizeMatches.srcPath, r.srcPath))).run();
      tx.insert(organizeMatches)
        .values({ ...r, srcPath: next })
        .onConflictDoUpdate({ target: [organizeMatches.accountName, organizeMatches.srcPath], set: { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, year: r.year, season: r.season, episodeOffset: r.episodeOffset, updatedAt: r.updatedAt } })
        .run();
      n++;
    }
  });
  return n;
}

export function listMatches(accountName?: string): OrganizeMatchMemory[] {
  return db
    .select()
    .from(organizeMatches)
    .where(accountName ? eq(organizeMatches.accountName, accountName) : undefined)
    .orderBy(desc(organizeMatches.updatedAt))
    .all()
    .map(toMemory);
}

/* ------------------------------- TMDB 缓存 ------------------------------- */

/* ------------------------------- 不整理的目录 ------------------------------- */

const toSkip = (r: typeof organizeSkips.$inferSelect): OrganizeSkip => ({ accountName: r.accountName, path: r.path, note: r.note, createdAt: r.createdAt });

export function listSkips(accountName?: string): OrganizeSkip[] {
  const rows = accountName ? db.select().from(organizeSkips).where(eq(organizeSkips.accountName, accountName)).all() : db.select().from(organizeSkips).all();
  return rows.map(toSkip).sort((a, b) => a.accountName.localeCompare(b.accountName) || a.path.localeCompare(b.path));
}

/** 加一条（已有就只更新备注） */
export function addSkip(accountName: string, path: string, note = ""): OrganizeSkip {
  db.insert(organizeSkips)
    .values({ accountName, path, note })
    .onConflictDoUpdate({ target: [organizeSkips.accountName, organizeSkips.path], set: { note } })
    .run();
  return toSkip(db.select().from(organizeSkips).where(and(eq(organizeSkips.accountName, accountName), eq(organizeSkips.path, path))).get()!);
}

export function removeSkip(accountName: string, path: string): boolean {
  return db.delete(organizeSkips).where(and(eq(organizeSkips.accountName, accountName), eq(organizeSkips.path, path))).run().changes > 0;
}

export function readTmdbCache<T>(key: string, maxAgeSec: number): T | null {
  return peekTmdbCache<T>(key, maxAgeSec)?.value ?? null;
}

/**
 * 和 readTmdbCache 一样，但分得清「没有这条 / 过期了」（返回 null）和「缓存着 null」（TMDB 说没有这个 id）：
 * 后者不用再去问一遍
 */
export function peekTmdbCache<T>(key: string, maxAgeSec: number): { value: T | null } | null {
  const row = db.select().from(tmdbCache).where(eq(tmdbCache.key, key)).get();
  if (!row) return null;
  if (Math.floor(Date.now() / 1000) - row.fetchedAt > maxAgeSec) return null;
  return { value: parseJson<T | null>(row.value, null) };
}

export function writeTmdbCache(key: string, value: unknown): void {
  const fetchedAt = Math.floor(Date.now() / 1000);
  db.insert(tmdbCache)
    .values({ key, value: JSON.stringify(value), fetchedAt })
    .onConflictDoUpdate({ target: tmdbCache.key, set: { value: JSON.stringify(value), fetchedAt } })
    .run();
}

export function deleteTmdbCacheBefore(cutoffSec: number): number {
  return db.delete(tmdbCache).where(lt(tmdbCache.fetchedAt, cutoffSec)).run().changes;
}

/** 整张表清掉，返回删掉的行数 */
export function clearTmdbCache(): number {
  return db.delete(tmdbCache).run().changes;
}

/** 仅供测试 */
export function __test_resetOrganize(): void {
  db.delete(organizeItems).run();
  db.delete(organizeUnits).run();
  db.delete(organizeRuns).run();
  db.delete(organizeMatches).run();
  db.delete(organizeSkips).run();
  db.delete(tmdbCache).run();
}

export type { OrganizeConfidence, OrganizeMediaType };
