import { eq, desc, and, inArray, isNull, lte, or } from "drizzle-orm";
import type {
  LibraryIndexStatus,
  LibraryShareHealth,
  LibraryShareStatus,
  MediaLibraryEntry,
  ScrapeStatus,
  MediaType,
} from "@openstrm/shared";
import { db } from "../client.js";
import { libraryShares, mediaLibrary } from "../schema.js";
import { notifyLibraryChange } from "./library-changes.js";

type Row = typeof mediaLibrary.$inferSelect;
type ShareRow = typeof libraryShares.$inferSelect;

function safeParseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function coerceMediaType(v: string): MediaType {
  return v === "movie" || v === "tv" || v === "collection" ? v : "unknown";
}

function coerceScrapeStatus(v: string): ScrapeStatus {
  return v === "pending" || v === "failed" ? v : "done";
}

function coerceIndexStatus(v: string): LibraryIndexStatus {
  return v === "indexing" || v === "done" || v === "failed" ? v : "pending";
}

export function coerceShareStatus(v: string | null | undefined): LibraryShareStatus {
  return v === "ok" || v === "suspect" || v === "expired" || v === "locked" ? v : "unknown";
}

export function healthOf(row: Pick<ShareRow, "status" | "reason" | "checkedAt" | "expiredAt"> | null | undefined): LibraryShareHealth {
  return {
    status: coerceShareStatus(row?.status),
    reason: row?.reason ?? "",
    checkedAt: row?.checkedAt ?? null,
    expiredAt: row?.expiredAt ?? null,
  };
}

function deserialize(row: Row): MediaLibraryEntry {
  return {
    id: row.id,
    shareUrl: row.shareUrl,
    shareCode: row.shareCode,
    receiveCode: row.receiveCode,
    sharePath: row.sharePath,
    shareRootCid: row.shareRootCid,
    rawName: row.rawName,
    title: row.title,
    fileCount: row.fileCount,
    coverUrl: row.coverUrl,
    tags: safeParseTags(row.tags),
    notes: row.notes,
    mediaType: coerceMediaType(row.mediaType),
    tmdbId: row.tmdbId ?? null,
    year: row.year,
    overview: row.overview,
    scrapeStatus: coerceScrapeStatus(row.scrapeStatus),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    shareTitle: row.shareTitle,
    indexStatus: coerceIndexStatus(row.indexStatus),
    indexError: row.indexError,
    indexedAt: row.indexedAt ?? null,
    dirsTotal: row.dirsTotal,
    dirsListed: row.dirsListed,
    nodeCount: row.nodeCount,
    videoCount: row.videoCount,
    totalSize: row.totalSize,
    truncated: row.truncated,
  };
}

/** 新建来源时索引相关的字段：排队等抄 */
export function freshIndexFields(): Pick<
  MediaLibraryEntry,
  "indexStatus" | "indexError" | "indexedAt" | "dirsTotal" | "dirsListed" | "nodeCount" | "videoCount" | "totalSize" | "truncated"
> {
  return { indexStatus: "pending", indexError: "", indexedAt: null, dirsTotal: 0, dirsListed: 0, nodeCount: 0, videoCount: 0, totalSize: 0, truncated: false };
}

/** 用户能改、刮削会改的列；索引进度不在这里（setIndexState 单独写，免得读改写把进度盖回去） */
function toRow(entry: MediaLibraryEntry) {
  return {
    id: entry.id,
    shareUrl: entry.shareUrl,
    shareCode: entry.shareCode,
    receiveCode: entry.receiveCode,
    sharePath: entry.sharePath ?? "",
    shareRootCid: entry.shareRootCid ?? "",
    rawName: entry.rawName ?? "",
    title: entry.title ?? "",
    fileCount: entry.fileCount ?? 0,
    coverUrl: entry.coverUrl ?? "",
    tags: JSON.stringify(entry.tags ?? []),
    notes: entry.notes ?? "",
    mediaType: entry.mediaType ?? "unknown",
    tmdbId: entry.tmdbId ?? null,
    year: entry.year ?? "",
    overview: entry.overview ?? "",
    scrapeStatus: entry.scrapeStatus ?? "done",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    shareTitle: entry.shareTitle ?? "",
  };
}

/** toRow minus {id, createdAt}; everything else is legally set-able by update(). */
function toUpdateRow(entry: MediaLibraryEntry) {
  const { id: _id, createdAt: _c, ...rest } = toRow(entry);
  return rest;
}

export function insert(entry: MediaLibraryEntry): void {
  db.insert(mediaLibrary)
    .values({
      ...toRow(entry),
      indexStatus: entry.indexStatus,
      indexError: entry.indexError,
      indexedAt: entry.indexedAt,
      dirsTotal: entry.dirsTotal,
      dirsListed: entry.dirsListed,
      nodeCount: entry.nodeCount,
      videoCount: entry.videoCount,
      totalSize: entry.totalSize,
      truncated: entry.truncated,
    })
    .run();
}

export function update(id: string, updates: Partial<MediaLibraryEntry>): MediaLibraryEntry | null {
  const row = db.select().from(mediaLibrary).where(eq(mediaLibrary.id, id)).get();
  if (!row) return null;
  const current = deserialize(row);
  const merged: MediaLibraryEntry = {
    ...current,
    ...updates,
    id: current.id,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  db.update(mediaLibrary).set(toUpdateRow(merged)).where(eq(mediaLibrary.id, id)).run();
  // 换了分享码（换链接）：单元归到另一个分享、死活跟着变，海报墙视图整个作废
  if (merged.shareCode !== current.shareCode) notifyLibraryChange({ kind: "all" });
  return merged;
}

/** 抄目录的进度 / 结果：只写这几列，不动 updatedAt（列表按它排序，进度一变就跳位置不好） */
export interface IndexState {
  indexStatus: LibraryIndexStatus;
  indexError: string;
  indexGen: number;
  indexedAt: number | null;
  indexStartedAt: number | null;
  indexRetryAt: number | null;
  dirsTotal: number;
  dirsListed: number;
  nodeCount: number;
  videoCount: number;
  totalSize: number;
  truncated: boolean;
  shareTitle: string;
}

export function setIndexState(id: string, patch: Partial<IndexState>): void {
  if (Object.keys(patch).length === 0) return;
  db.update(mediaLibrary).set(patch).where(eq(mediaLibrary.id, id)).run();
}

export function getIndexGen(id: string): { gen: number; retryAt: number | null; status: LibraryIndexStatus } | null {
  const row = db
    .select({ gen: mediaLibrary.indexGen, retryAt: mediaLibrary.indexRetryAt, status: mediaLibrary.indexStatus })
    .from(mediaLibrary)
    .where(eq(mediaLibrary.id, id))
    .get();
  return row ? { gen: row.gen, retryAt: row.retryAt ?? null, status: coerceIndexStatus(row.status) } : null;
}

/** 现在该抄的来源（在抄的、排队的，暂停到点了的才算），先来的在前；轮到谁由工人按轮流的规矩挑 */
export function dueToIndex(nowSec: number): MediaLibraryEntry[] {
  const due = or(isNull(mediaLibrary.indexRetryAt), lte(mediaLibrary.indexRetryAt, nowSec));
  return db
    .select()
    .from(mediaLibrary)
    .where(and(inArray(mediaLibrary.indexStatus, ["indexing", "pending"]), due))
    .orderBy(mediaLibrary.createdAt)
    .all()
    .map(deserialize);
}

/** 最早什么时候有暂停的来源到点（工人空闲时按它定下次醒来） */
export function nextIndexRetryAt(): number | null {
  const rows = db
    .select({ at: mediaLibrary.indexRetryAt })
    .from(mediaLibrary)
    .where(inArray(mediaLibrary.indexStatus, ["pending", "indexing"]))
    .all();
  const times = rows.map((r) => r.at).filter((t): t is number => t != null);
  return times.length ? Math.min(...times) : null;
}

/** 还在排队或在抄的来源数：搜索结果据此说「可能不全」 */
export function countIndexing(): number {
  return db
    .select({ id: mediaLibrary.id })
    .from(mediaLibrary)
    .where(inArray(mediaLibrary.indexStatus, ["pending", "indexing"]))
    .all().length;
}

export function remove(id: string): void {
  db.delete(mediaLibrary).where(eq(mediaLibrary.id, id)).run();
  // 单元级联删了：海报墙视图整个作废
  notifyLibraryChange({ kind: "all" });
}

export function getById(id: string): MediaLibraryEntry | null {
  const row = db.select().from(mediaLibrary).where(eq(mediaLibrary.id, id)).get();
  return row ? deserialize(row) : null;
}

export function getByShareCode(shareCode: string): MediaLibraryEntry | null {
  const row = db
    .select()
    .from(mediaLibrary)
    .where(and(eq(mediaLibrary.shareCode, shareCode), eq(mediaLibrary.sharePath, "")))
    .get();
  return row ? deserialize(row) : null;
}

export function getByShareCodeAndPath(shareCode: string, sharePath: string): MediaLibraryEntry | null {
  const row = db
    .select()
    .from(mediaLibrary)
    .where(and(eq(mediaLibrary.shareCode, shareCode), eq(mediaLibrary.sharePath, sharePath)))
    .get();
  return row ? deserialize(row) : null;
}

/** 同一个分享收的所有来源（整包、子目录） */
export function listByShareCode(shareCode: string): MediaLibraryEntry[] {
  return db.select().from(mediaLibrary).where(eq(mediaLibrary.shareCode, shareCode)).all().map(deserialize);
}

export function getAll(): MediaLibraryEntry[] {
  const rows = db.select().from(mediaLibrary).orderBy(desc(mediaLibrary.updatedAt)).all();
  return rows.map(deserialize);
}

/** 来源列表：带上所在分享的死活 */
export function listWithHealth(): MediaLibraryEntry[] {
  const rows = db
    .select({ entry: mediaLibrary, share: libraryShares })
    .from(mediaLibrary)
    .leftJoin(libraryShares, eq(libraryShares.shareCode, mediaLibrary.shareCode))
    .orderBy(desc(mediaLibrary.updatedAt))
    .all();
  return rows.map((r) => ({ ...deserialize(r.entry), health: healthOf(r.share) }));
}
