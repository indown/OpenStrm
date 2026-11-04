/**
 * 影库的作品单元：抄来的目录树里切出来的一部电影 / 一部剧，和它在 TMDB 上认成了哪一部（services/library/units.ts、identify.ts）。
 * 重建单元时按单元键保留识别结果；海报墙按 tmdbId 聚合（services/library/works.ts）。
 */
import type { LibraryConfidence, LibraryUnitStatus, OrganizeCandidate } from "@openstrm/shared";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../client.js";
import { librarySaves, libraryShares, libraryUnits, mediaLibrary } from "../schema.js";
import { notifyLibraryChange, type UnitKeyState } from "./library-changes.js";

type Row = typeof libraryUnits.$inferSelect;

/** 切出来的一个单元（还没认） */
export interface BuiltUnit {
  unitKey: string;
  nodeId: string;
  path: string;
  rawName: string;
  ownsDir: boolean;
  fileIds: string[];
  parsedTitle: string;
  parsedTitles: string[];
  parsedYear: string;
  kindHint: "movie" | "tv" | "unknown";
  seasons: number[];
  videoCount: number;
  size: number;
  sampleFile: string;
}

export interface UnitRow extends BuiltUnit {
  sourceId: string;
  status: LibraryUnitStatus;
  tmdbId: number | null;
  mediaType: "movie" | "tv" | null;
  title: string;
  originalTitle: string;
  enTitle: string;
  year: string;
  posterUrl: string;
  confidence: LibraryConfidence;
  reason: string;
  candidates: OrganizeCandidate[];
  /** TMDB 类型编号、国家 / 地区代码、原语言；null = 还没从详情补 */
  genres: number[] | null;
  countries: string[] | null;
  originalLanguage: string | null;
  aka: string;
  identifiedAt: number | null;
  retryAt: number | null;
  error: string;
  createdAt: number;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const v = JSON.parse(raw) as T | null;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

const coerceStatus = (v: string): LibraryUnitStatus => (v === "done" || v === "manual" || v === "ignored" ? v : "pending");
const coerceConfidence = (v: string): LibraryConfidence => (v === "high" || v === "medium" || v === "low" ? v : "none");
const coerceKind = (v: string): BuiltUnit["kindHint"] => (v === "movie" || v === "tv" ? v : "unknown");

export function toUnit(r: Row): UnitRow {
  return {
    sourceId: r.sourceId,
    unitKey: r.unitKey,
    nodeId: r.nodeId,
    path: r.path,
    rawName: r.rawName,
    ownsDir: r.ownsDir,
    fileIds: parseJson<string[]>(r.fileIds, []),
    parsedTitle: r.parsedTitle,
    parsedTitles: parseJson<string[]>(r.parsedTitles, []),
    parsedYear: r.parsedYear,
    kindHint: coerceKind(r.kindHint),
    seasons: parseJson<number[]>(r.seasons, []),
    videoCount: r.videoCount,
    size: r.size,
    sampleFile: r.sampleFile,
    status: coerceStatus(r.status),
    tmdbId: r.tmdbId ?? null,
    mediaType: r.mediaType === "movie" || r.mediaType === "tv" ? r.mediaType : null,
    title: r.title,
    originalTitle: r.originalTitle,
    enTitle: r.enTitle,
    year: r.year,
    posterUrl: r.posterUrl,
    confidence: coerceConfidence(r.confidence),
    reason: r.reason,
    candidates: parseJson<OrganizeCandidate[]>(r.candidates, []),
    genres: r.genres == null ? null : parseJson<number[]>(r.genres, []),
    countries: r.countries == null ? null : parseJson<string[]>(r.countries, []),
    originalLanguage: r.originalLanguage ?? null,
    aka: r.aka,
    identifiedAt: r.identifiedAt ?? null,
    retryAt: r.retryAt ?? null,
    error: r.error,
    createdAt: r.createdAt,
  };
}

/** 识别结果清空、回到待认 */
const RESET = {
  status: "pending",
  tmdbId: null,
  mediaType: null,
  title: "",
  originalTitle: "",
  enTitle: "",
  year: "",
  posterUrl: "",
  confidence: "none",
  reason: "",
  candidates: "[]",
  genres: null,
  countries: null,
  originalLanguage: null,
  aka: "",
  identifiedAt: null,
  retryAt: null,
  error: "",
} as const;

const keyOf = (sourceId: string, unitKey: string) => and(eq(libraryUnits.sourceId, sourceId), eq(libraryUnits.unitKey, unitKey));

/** 海报墙上一张卡的作品键：认出来的是 `movie:1` / `tv:2`，没认出的是 `unit:<来源>:<单元键>`；视图、接口、智能体工具都用这两个拼 */
export const workKey = (mediaType: "movie" | "tv", tmdbId: number): string => `${mediaType}:${tmdbId}`;
export const unitWorkKey = (sourceId: string, unitKey: string): string => `unit:${sourceId}:${unitKey}`;

/** 一个单元决定它在海报墙视图里落在哪的三个字段（写前写后各读一次，给视图增量维护用） */
function keyState(sourceId: string, unitKey: string): UnitKeyState | null {
  const r = db.select({ status: libraryUnits.status, tmdbId: libraryUnits.tmdbId, mediaType: libraryUnits.mediaType }).from(libraryUnits).where(keyOf(sourceId, unitKey)).get();
  return r ? { status: coerceStatus(r.status), tmdbId: r.tmdbId ?? null, mediaType: r.mediaType === "movie" || r.mediaType === "tv" ? r.mediaType : null } : null;
}

/** 单个单元写完：把前后状态广播给视图 */
function unitChanged(sourceId: string, unitKey: string, before: UnitKeyState | null): void {
  notifyLibraryChange({ kind: "unit", sourceId, unitKey, before, after: keyState(sourceId, unitKey) });
}

/**
 * 重建一个来源的单元：同一个单元键的更新结构字段、保留识别结果——解析出来的名字 / 年份 / 类型猜测变了才回到待认，
 * 手动指定的、忽略的一直保留；新的待认；没了的删掉
 */
export function replaceUnits(sourceId: string, built: BuiltUnit[], now: number): { added: number; removed: number; reset: number } {
  const existing = new Map(
    db
      .select()
      .from(libraryUnits)
      .where(eq(libraryUnits.sourceId, sourceId))
      .all()
      .map((r) => [r.unitKey, r]),
  );
  const keep = new Set<string>();
  let added = 0;
  let reset = 0;
  db.transaction((tx) => {
    for (const b of built) {
      if (keep.has(b.unitKey)) continue;
      keep.add(b.unitKey);
      const structural = {
        nodeId: b.nodeId,
        path: b.path,
        rawName: b.rawName,
        ownsDir: b.ownsDir,
        fileIds: JSON.stringify(b.fileIds),
        parsedTitle: b.parsedTitle,
        parsedTitles: JSON.stringify(b.parsedTitles),
        parsedYear: b.parsedYear,
        kindHint: b.kindHint,
        seasons: JSON.stringify(b.seasons),
        videoCount: b.videoCount,
        size: b.size,
        sampleFile: b.sampleFile,
      };
      const old = existing.get(b.unitKey);
      if (!old) {
        tx.insert(libraryUnits)
          .values({ sourceId, unitKey: b.unitKey, ...structural, createdAt: now })
          .run();
        added++;
        continue;
      }
      const renamed = old.parsedTitle !== b.parsedTitle || old.parsedYear !== b.parsedYear || old.kindHint !== b.kindHint || old.parsedTitles !== structural.parsedTitles;
      const sticky = old.status === "manual" || old.status === "ignored";
      const again = renamed && !sticky && old.status !== "pending";
      if (again) reset++;
      tx.update(libraryUnits)
        .set({ ...structural, ...(again ? RESET : {}) })
        .where(keyOf(sourceId, b.unitKey))
        .run();
    }
    for (const key of existing.keys()) {
      if (!keep.has(key)) tx.delete(libraryUnits).where(keyOf(sourceId, key)).run();
    }
  });
  notifyLibraryChange({ kind: "all" });
  return { added, removed: [...existing.keys()].filter((k) => !keep.has(k)).length, reset };
}

export function deleteUnits(sourceId: string): void {
  db.delete(libraryUnits).where(eq(libraryUnits.sourceId, sourceId)).run();
  notifyLibraryChange({ kind: "all" });
}

export function getUnit(sourceId: string, unitKey: string): UnitRow | null {
  const r = db.select().from(libraryUnits).where(keyOf(sourceId, unitKey)).get();
  return r ? toUnit(r) : null;
}

export function unitsOfSource(sourceId: string): UnitRow[] {
  return db.select().from(libraryUnits).where(eq(libraryUnits.sourceId, sourceId)).orderBy(asc(libraryUnits.path)).all().map(toUnit);
}

/** 一个来源里没被忽略的单元有几个（整个来源就一部时，它的名字写到来源根上） */
export function countActiveUnits(sourceId: string): number {
  const r = db
    .select({ n: sql<number>`count(*)` })
    .from(libraryUnits)
    .where(and(eq(libraryUnits.sourceId, sourceId), sql`${libraryUnits.status} != 'ignored'`))
    .get();
  return r?.n ?? 0;
}

/** 根目录落在这些节点上的单元（给搜索结果挂作品） */
export function unitsAtNodes(sourceId: string, nodeIds: string[]): UnitRow[] {
  if (nodeIds.length === 0) return [];
  return db
    .select()
    .from(libraryUnits)
    .where(and(eq(libraryUnits.sourceId, sourceId), inArray(libraryUnits.nodeId, nodeIds)))
    .all()
    .map(toUnit);
}

/** 根目录在这个目录下面的单元（按分享里的路径；剧目录里的各季、合集里的几部） */
export function unitsUnder(sourceId: string, path: string): UnitRow[] {
  const prefix = `${path.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
  return db
    .select()
    .from(libraryUnits)
    .where(and(eq(libraryUnits.sourceId, sourceId), sql`${libraryUnits.path} like ${prefix} escape '\\'`))
    .all()
    .map(toUnit);
}

/** 下一个该认的：先来的来源先认，同一个来源按路径；一时出错的等到点 */
export function nextPendingUnit(nowSec: number): UnitRow | null {
  const r = db
    .select({ u: libraryUnits })
    .from(libraryUnits)
    .innerJoin(mediaLibrary, eq(mediaLibrary.id, libraryUnits.sourceId))
    .where(and(eq(libraryUnits.status, "pending"), or(isNull(libraryUnits.retryAt), lte(libraryUnits.retryAt, nowSec))))
    .orderBy(asc(mediaLibrary.createdAt), asc(libraryUnits.path))
    .limit(1)
    .get();
  return r ? toUnit(r.u) : null;
}

/** 等着重试的最早什么时候到点（工人空闲时按它定下次醒来） */
export function nextUnitRetryAt(): number | null {
  const r = db
    .select({ at: sql<number | null>`min(${libraryUnits.retryAt})` })
    .from(libraryUnits)
    .where(and(eq(libraryUnits.status, "pending"), isNotNull(libraryUnits.retryAt)))
    .get();
  return r?.at ?? null;
}

export interface Identified {
  status: "done" | "manual";
  tmdbId: number | null;
  mediaType: "movie" | "tv" | null;
  title: string;
  originalTitle: string;
  enTitle: string;
  year: string;
  posterUrl: string;
  confidence: LibraryConfidence;
  reason: string;
  candidates: OrganizeCandidate[];
  aka: string;
  /** 顺手从 TMDB 详情拿到的类型、国家 / 地区；没给就留空等工人补 */
  details?: UnitDetails;
}

export function saveIdentified(sourceId: string, unitKey: string, v: Identified, now: number): void {
  const { details, ...rest } = v;
  const before = keyState(sourceId, unitKey);
  db.update(libraryUnits)
    .set({ ...rest, ...detailColumns(v.tmdbId != null ? details : undefined), candidates: JSON.stringify(v.candidates), identifiedAt: now, retryAt: null, error: "" })
    .where(keyOf(sourceId, unitKey))
    .run();
  unitChanged(sourceId, unitKey, before);
}

/** 从 TMDB 详情来的类型、国家 / 地区、原语言 */
export interface UnitDetails {
  genres: number[];
  countries: string[];
  originalLanguage: string;
}

/** 没给（没认出、详情没拿到）就是 null：以后由识别工人补 */
const detailColumns = (d: UnitDetails | undefined) =>
  d ? { genres: JSON.stringify(d.genres), countries: JSON.stringify(d.countries), originalLanguage: d.originalLanguage } : { genres: null, countries: null, originalLanguage: null };

/** 补类型、国家 / 地区（不动识别结果） */
export function saveDetails(sourceId: string, unitKey: string, d: UnitDetails): void {
  db.update(libraryUnits).set(detailColumns(d)).where(keyOf(sourceId, unitKey)).run();
  // 分组里带着类型、地区（max(genres)）：单元的状态、计数、来源统计都没变，只让视图重查这一组
  const s = keyState(sourceId, unitKey);
  if (s && s.tmdbId != null && s.mediaType) notifyLibraryChange({ kind: "group", mediaType: s.mediaType, tmdbId: s.tmdbId });
}

/** 认出来了、还没补类型的：先来的先补 */
export function nextMissingDetails(): UnitRow | null {
  const r = db
    .select()
    .from(libraryUnits)
    .where(and(inArray(libraryUnits.status, ["done", "manual"]), isNotNull(libraryUnits.tmdbId), isNull(libraryUnits.genres)))
    .orderBy(asc(libraryUnits.createdAt))
    .limit(1)
    .get();
  return r ? toUnit(r) : null;
}

/** 认出来了、还没补类型的有几个（按类型、地区筛时告诉人结果可能不全） */
export function countMissingDetails(): number {
  const r = db
    .select({ n: sql<number>`count(*)` })
    .from(libraryUnits)
    .where(and(inArray(libraryUnits.status, ["done", "manual"]), isNotNull(libraryUnits.tmdbId), isNull(libraryUnits.genres)))
    .get();
  return r?.n ?? 0;
}

export function setUnitRetry(sourceId: string, unitKey: string, retryAt: number, error: string): void {
  db.update(libraryUnits).set({ retryAt, error }).where(keyOf(sourceId, unitKey)).run();
}

/** 不是影视（花絮合集、字幕包……）：不再认，海报墙不出 */
export function ignoreUnit(sourceId: string, unitKey: string, now: number): void {
  const before = keyState(sourceId, unitKey);
  db.update(libraryUnits)
    .set({ ...RESET, status: "ignored", identifiedAt: now })
    .where(keyOf(sourceId, unitKey))
    .run();
  unitChanged(sourceId, unitKey, before);
}

/** 重新认：回到待认（手动指定的也放掉） */
export function resetUnit(sourceId: string, unitKey: string): void {
  const before = keyState(sourceId, unitKey);
  db.update(libraryUnits).set(RESET).where(keyOf(sourceId, unitKey)).run();
  unitChanged(sourceId, unitKey, before);
}

/** 自动认过的都放回待认（识别规则改了）：手动指定的、忽略的不动。返回放回去几个 */
export function resetAutoIdentified(): number {
  const changes = db.update(libraryUnits).set(RESET).where(eq(libraryUnits.status, "done")).run().changes;
  if (changes > 0) notifyLibraryChange({ kind: "all" });
  return changes;
}

/** 一个来源里自动认过的都放回待认（整来源重认）：手动指定的、忽略的不动。一条 UPDATE，视图整个作废。返回放回去几个 */
export function resetDoneUnits(sourceId: string): number {
  const changes = db
    .update(libraryUnits)
    .set(RESET)
    .where(and(eq(libraryUnits.sourceId, sourceId), eq(libraryUnits.status, "done")))
    .run().changes;
  if (changes > 0) notifyLibraryChange({ kind: "all" });
  return changes;
}

/** 各状态的单元数（没认出 = 认过但没有 tmdbId） */
export function unitStatusCounts(): { pending: number; identified: number; none: number; ignored: number } {
  const rows = db
    .select({ status: libraryUnits.status, hasId: sql<number>`${libraryUnits.tmdbId} is not null`, n: sql<number>`count(*)` })
    .from(libraryUnits)
    .groupBy(libraryUnits.status, sql`${libraryUnits.tmdbId} is not null`)
    .all();
  const out = { pending: 0, identified: 0, none: 0, ignored: 0 };
  for (const r of rows) {
    if (r.status === "pending") out.pending += r.n;
    else if (r.status === "ignored") out.ignored += r.n;
    else if (r.hasId) out.identified += r.n;
    else out.none += r.n;
  }
  return out;
}

/** 海报墙的一组：同一个 tmdbId 的单元（已失效分享里的不算，转存不了） */
export interface WorkGroup {
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  /** 按名字筛的时候原名、英文名也算 */
  originalTitle: string;
  enTitle: string;
  year: string;
  posterUrl: string;
  /** 3 高（含手动）/ 2 中 / 1 低 */
  conf: number;
  versions: number;
  shares: number;
  videoCount: number;
  size: number;
  seasons: number[];
  addedAt: number;
  genres: number[];
  countries: string[];
}

const CONF_RANK = sql<number>`max(case when ${libraryUnits.status} = 'manual' or ${libraryUnits.confidence} = 'high' then 3 when ${libraryUnits.confidence} = 'medium' then 2 when ${libraryUnits.confidence} = 'low' then 1 else 0 end)`;
const NOT_EXPIRED = sql`coalesce(${libraryShares.status}, 'unknown') != 'expired'`;

/** 全部分组；给了 only 就只算那一部（视图增量重查用） */
export function workGroups(only?: { mediaType: "movie" | "tv"; tmdbId: number }): WorkGroup[] {
  return db
    .select({
      mediaType: libraryUnits.mediaType,
      tmdbId: libraryUnits.tmdbId,
      title: sql<string>`max(${libraryUnits.title})`,
      originalTitle: sql<string>`max(${libraryUnits.originalTitle})`,
      enTitle: sql<string>`max(${libraryUnits.enTitle})`,
      year: sql<string>`max(${libraryUnits.year})`,
      posterUrl: sql<string>`max(${libraryUnits.posterUrl})`,
      conf: CONF_RANK,
      versions: sql<number>`count(*)`,
      shares: sql<number>`count(distinct ${libraryUnits.sourceId})`,
      videoCount: sql<number>`sum(${libraryUnits.videoCount})`,
      size: sql<number>`max(${libraryUnits.size})`,
      seasons: sql<string>`group_concat(${libraryUnits.seasons}, ';')`,
      addedAt: sql<number>`max(${libraryUnits.createdAt})`,
      genres: sql<string | null>`max(${libraryUnits.genres})`,
      countries: sql<string | null>`max(${libraryUnits.countries})`,
    })
    .from(libraryUnits)
    .innerJoin(mediaLibrary, eq(mediaLibrary.id, libraryUnits.sourceId))
    .leftJoin(libraryShares, eq(libraryShares.shareCode, mediaLibrary.shareCode))
    .where(
      and(
        inArray(libraryUnits.status, ["done", "manual"]),
        isNotNull(libraryUnits.tmdbId),
        NOT_EXPIRED,
        only ? and(eq(libraryUnits.mediaType, only.mediaType), eq(libraryUnits.tmdbId, only.tmdbId)) : undefined,
      ),
    )
    .groupBy(libraryUnits.mediaType, libraryUnits.tmdbId)
    .all()
    .map((r) => ({
      mediaType: r.mediaType === "movie" ? "movie" : "tv",
      tmdbId: r.tmdbId ?? 0,
      title: r.title ?? "",
      originalTitle: r.originalTitle ?? "",
      enTitle: r.enTitle ?? "",
      year: r.year ?? "",
      posterUrl: r.posterUrl ?? "",
      conf: r.conf,
      versions: r.versions,
      shares: r.shares,
      videoCount: r.videoCount ?? 0,
      size: r.size ?? 0,
      seasons: [...new Set((r.seasons ?? "").split(";").flatMap((s) => parseJson<number[]>(s, [])))].sort((a, b) => a - b),
      addedAt: r.addedAt ?? 0,
      genres: parseJson<number[]>(r.genres ?? "[]", []),
      countries: parseJson<string[]>(r.countries ?? "[]", []),
    }));
}

/** 认过但没认出的单元（已失效分享里的不算）；给了 only 就只看那一个（视图增量重查用） */
export function unidentifiedUnits(only?: { sourceId: string; unitKey: string }): UnitRow[] {
  return db
    .select({ u: libraryUnits })
    .from(libraryUnits)
    .innerJoin(mediaLibrary, eq(mediaLibrary.id, libraryUnits.sourceId))
    .leftJoin(libraryShares, eq(libraryShares.shareCode, mediaLibrary.shareCode))
    .where(and(eq(libraryUnits.status, "done"), isNull(libraryUnits.tmdbId), NOT_EXPIRED, only ? keyOf(only.sourceId, only.unitKey) : undefined))
    .all()
    .map((r) => toUnit(r.u));
}

/** 一部作品的所有单元（作品弹框里的版本列表；已失效分享里的也给，标出来） */
export function unitsOfWork(mediaType: "movie" | "tv", tmdbId: number): UnitRow[] {
  return db
    .select()
    .from(libraryUnits)
    .where(and(eq(libraryUnits.mediaType, mediaType), eq(libraryUnits.tmdbId, tmdbId), inArray(libraryUnits.status, ["done", "manual"])))
    .orderBy(asc(libraryUnits.createdAt))
    .all()
    .map(toUnit);
}

export interface SourceUnitSummary {
  total: number;
  identified: number;
  pending: number;
  /** 整个来源就是一部作品（认出来的都是同一个 tmdbId、没有没认出的）：它的海报和名字 */
  poster: string;
  title: string;
}

/** 每个来源的单元统计（来源列表用）；忽略的不算。给了 sourceId 就只算那一个来源（视图增量重查用） */
export function unitSummaries(sourceId?: string): Map<string, SourceUnitSummary> {
  const rows = db
    .select({
      sourceId: libraryUnits.sourceId,
      total: sql<number>`count(*)`,
      identified: sql<number>`sum(case when ${libraryUnits.tmdbId} is not null then 1 else 0 end)`,
      pending: sql<number>`sum(case when ${libraryUnits.status} = 'pending' then 1 else 0 end)`,
      works: sql<number>`count(distinct ${libraryUnits.tmdbId})`,
      poster: sql<string>`max(${libraryUnits.posterUrl})`,
      title: sql<string>`max(${libraryUnits.title})`,
    })
    .from(libraryUnits)
    .where(and(sql`${libraryUnits.status} != 'ignored'`, sourceId !== undefined ? eq(libraryUnits.sourceId, sourceId) : undefined))
    .groupBy(libraryUnits.sourceId)
    .all();
  const out = new Map<string, SourceUnitSummary>();
  for (const r of rows) {
    const single = r.works === 1 && r.identified === r.total;
    out.set(r.sourceId, { total: r.total, identified: r.identified ?? 0, pending: r.pending ?? 0, poster: single ? (r.poster ?? "") : "", title: single ? (r.title ?? "") : "" });
  }
  return out;
}

/* ------------------------------- 从收藏夹转存过 ------------------------------- */

export interface SaveRecord {
  sourceId: string;
  unitKey: string;
  taskId: string;
  subPath: string;
  savedAt: number;
}

/** 记一笔「从收藏夹存过」：同一个单元存进同一个任务的只留最近一次 */
export function recordSaves(rows: Array<Omit<SaveRecord, "savedAt">>, now: number): void {
  if (rows.length === 0) return;
  db.insert(librarySaves)
    .values(rows.map((r) => ({ ...r, savedAt: now })))
    .onConflictDoUpdate({
      target: [librarySaves.sourceId, librarySaves.unitKey, librarySaves.taskId],
      set: { subPath: sql`excluded.sub_path`, savedAt: sql`excluded.saved_at` },
    })
    .run();
}

/** 一部作品的哪些单元存过、存到哪（带单元的名字和季） */
export function savesOfWork(mediaType: "movie" | "tv", tmdbId: number): Array<SaveRecord & { rawName: string; seasons: number[] }> {
  return db
    .select({ s: librarySaves, rawName: libraryUnits.rawName, seasons: libraryUnits.seasons })
    .from(librarySaves)
    .innerJoin(libraryUnits, and(eq(libraryUnits.sourceId, librarySaves.sourceId), eq(libraryUnits.unitKey, librarySaves.unitKey)))
    .where(and(eq(libraryUnits.mediaType, mediaType), eq(libraryUnits.tmdbId, tmdbId), inArray(libraryUnits.status, ["done", "manual"])))
    .all()
    .map((r) => ({ ...r.s, rawName: r.rawName, seasons: parseJson<number[]>(r.seasons, []) }));
}

/** 一个单元存过哪儿（没认出的作品就是它自己） */
export function savesOfUnit(sourceId: string, unitKey: string): SaveRecord[] {
  return db.select().from(librarySaves).where(and(eq(librarySaves.sourceId, sourceId), eq(librarySaves.unitKey, unitKey))).all();
}

/** 存过的作品键：认出来的是 `movie:1` / `tv:2`，没认出的是 `unit:<来源>:<单元键>`（海报墙「已有」角标） */
export function savedWorkKeys(): Set<string> {
  const rows = db
    .select({ sourceId: libraryUnits.sourceId, unitKey: libraryUnits.unitKey, mediaType: libraryUnits.mediaType, tmdbId: libraryUnits.tmdbId })
    .from(librarySaves)
    .innerJoin(libraryUnits, and(eq(libraryUnits.sourceId, librarySaves.sourceId), eq(libraryUnits.unitKey, librarySaves.unitKey)))
    .all();
  return new Set(rows.map((r) => (r.tmdbId != null && r.mediaType ? `${r.mediaType}:${r.tmdbId}` : unitWorkKey(r.sourceId, r.unitKey))));
}

