import { and, asc, eq, getTableColumns, lte, notInArray, sql } from "drizzle-orm";
import type { ShareFollow, ShareFollowEntry, ShareFollowOrganized, ShareFollowRun, ShareFollowStatus, ShareFollowSummary } from "@openstrm/shared";
import { db } from "../client.js";
import { shareFollows } from "../schema.js";

type Row = typeof shareFollows.$inferSelect;

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const STATUSES: ShareFollowStatus[] = ["idle", "checking", "error", "expired", "stale"];

function coerceStatus(v: string): ShareFollowStatus {
  return (STATUSES as string[]).includes(v) ? (v as ShareFollowStatus) : "idle";
}

function deserialize(row: Row): ShareFollow {
  const scope = parseJson<unknown>(row.scope, [""]);
  return {
    id: row.id,
    name: row.name,
    libraryId: row.libraryId ?? null,
    shareUrl: row.shareUrl,
    shareCode: row.shareCode,
    receiveCode: row.receiveCode,
    watchCid: row.watchCid,
    watchPath: row.watchPath,
    scope: Array.isArray(scope) ? scope.filter((s): s is string => typeof s === "string") : [""],
    taskId: row.taskId,
    subPath: row.subPath,
    enabled: row.enabled,
    intervalMinutes: row.intervalMinutes,
    status: coerceStatus(row.status),
    lastError: row.lastError,
    errorStreak: row.errorStreak,
    lastCheckedAt: row.lastCheckedAt ?? null,
    lastChangeAt: row.lastChangeAt ?? null,
    nextCheckAt: row.nextCheckAt,
    known: parseJson<ShareFollowEntry[]>(row.known, []),
    recent: parseJson<ShareFollowRun[]>(row.recent, []),
    organized: parseJson<ShareFollowOrganized[]>(row.organized, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 落库的列；id / createdAt 不在这里，插入和更新各自决定 */
function columns(f: ShareFollow) {
  return {
    name: f.name,
    libraryId: f.libraryId,
    shareUrl: f.shareUrl,
    shareCode: f.shareCode,
    receiveCode: f.receiveCode,
    watchCid: f.watchCid,
    watchPath: f.watchPath,
    scope: JSON.stringify(f.scope),
    taskId: f.taskId,
    subPath: f.subPath,
    enabled: f.enabled,
    intervalMinutes: f.intervalMinutes,
    status: f.status,
    lastError: f.lastError,
    errorStreak: f.errorStreak,
    lastCheckedAt: f.lastCheckedAt,
    lastChangeAt: f.lastChangeAt,
    nextCheckAt: f.nextCheckAt,
    known: JSON.stringify(f.known),
    recent: JSON.stringify(f.recent),
    organized: JSON.stringify(f.organized),
  };
}

export function toSummary(f: ShareFollow): ShareFollowSummary {
  const { known, ...rest } = f;
  return { ...rest, knownCount: known.length };
}

export function listShareFollows(): ShareFollow[] {
  return db.select().from(shareFollows).orderBy(asc(shareFollows.createdAt)).all().map(deserialize);
}

/** 列表页用：不把每条几百项的快照读出来再扔掉（known 这一列不选），条数让 SQLite 数 */
export function listShareFollowSummaries(): ShareFollowSummary[] {
  const { known, ...columns } = getTableColumns(shareFollows);
  const rows = db
    .select({ ...columns, knownCount: sql<number>`json_array_length(${known})` })
    .from(shareFollows)
    .orderBy(asc(shareFollows.createdAt))
    .all();
  return rows.map(({ knownCount, ...row }) => {
    const { known: _known, ...rest } = deserialize({ ...row, known: "[]" });
    return { ...rest, knownCount: Number(knownCount) || 0 };
  });
}

/** 资源搜索标「已在追更」用：只要认分享的这几列 */
export function listShareFollowRefs(): Array<Pick<ShareFollow, "shareUrl" | "shareCode" | "taskId" | "enabled">> {
  return db
    .select({ shareUrl: shareFollows.shareUrl, shareCode: shareFollows.shareCode, taskId: shareFollows.taskId, enabled: shareFollows.enabled })
    .from(shareFollows)
    .all();
}

export function getShareFollow(id: string): ShareFollow | null {
  const row = db.select().from(shareFollows).where(eq(shareFollows.id, id)).get();
  return row ? deserialize(row) : null;
}

export function findShareFollow(shareCode: string, watchCid: string): ShareFollow | null {
  const row = db
    .select()
    .from(shareFollows)
    .where(and(eq(shareFollows.shareCode, shareCode), eq(shareFollows.watchCid, watchCid)))
    .get();
  return row ? deserialize(row) : null;
}

/** 到期待检查的：开着、且 next_check_at 已过；先到期的先来 */
export function listDueShareFollows(now: number): ShareFollow[] {
  return db
    .select()
    .from(shareFollows)
    .where(and(eq(shareFollows.enabled, true), lte(shareFollows.nextCheckAt, now)))
    .orderBy(asc(shareFollows.nextCheckAt))
    .all()
    .map(deserialize);
}

export function countEnabledShareFollows(): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(shareFollows)
    .where(eq(shareFollows.enabled, true))
    .get();
  return Number(row?.n ?? 0);
}

/**
 * (shareCode, watchCid) 重复会抛唯一索引冲突，调用方先用 findShareFollow 查。
 * created_at / updated_at 用调用方给的：service 有自己的时钟（测试会注入），不能和库的 unixepoch() 混用
 */
export function insertShareFollow(f: ShareFollow): void {
  db.insert(shareFollows).values({ id: f.id, ...columns(f), createdAt: f.createdAt, updatedAt: f.updatedAt }).run();
}

/** 合并给出的字段；id / createdAt 不可改。不存在返回 null */
export function updateShareFollow(id: string, patch: Partial<ShareFollow>): ShareFollow | null {
  // 读改写放进事务：检查循环写状态和界面改设置可能同时到
  return db.transaction((tx) => {
    const row = tx.select().from(shareFollows).where(eq(shareFollows.id, id)).get();
    if (!row) return null;
    const current = deserialize(row);
    const updatedAt = Math.floor(Date.now() / 1000);
    const merged: ShareFollow = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt };
    tx.update(shareFollows)
      .set({ ...columns(merged), updatedAt })
      .where(eq(shareFollows.id, id))
      .run();
    return merged;
  });
}

export function deleteShareFollow(id: string): boolean {
  return db.delete(shareFollows).where(eq(shareFollows.id, id)).run().changes > 0;
}

/** 整体替换，只给测试恢复快照用 */
export function replaceShareFollows(list: ShareFollow[]): void {
  db.transaction((tx) => {
    const ids = list.map((f) => f.id);
    if (ids.length === 0) tx.delete(shareFollows).run();
    else tx.delete(shareFollows).where(notInArray(shareFollows.id, ids)).run();
    for (const f of list) {
      tx.insert(shareFollows)
        .values({ id: f.id, ...columns(f), createdAt: f.createdAt, updatedAt: f.updatedAt })
        .onConflictDoUpdate({ target: shareFollows.id, set: { ...columns(f), updatedAt: f.updatedAt } })
        .run();
    }
  });
}
