import { and, sql, eq, inArray, desc, lt } from "drizzle-orm";
import { db } from "../client.js";
import { settings, pathCache, lifeEvents, driveSnapshots } from "../schema.js";
import type { PathCacheRow, LifeEventRow } from "../schema.js";

/* ------------------------------------------------------------------ *
 * 内部 KV：直接借用 settings 表，但不带 `app.` 前缀。
 * readAppSettings/patchAppSettings 只认 `app.%`，所以这里的键既不会
 * 出现在设置接口里，也不会被整体覆写设置时误删。
 * ------------------------------------------------------------------ */

export function readKv<T>(key: string): T | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function writeKv(key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, value: JSON.stringify(value), updatedAt: sql`(unixepoch())` })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(value), updatedAt: sql`(unixepoch())` },
    })
    .run();
}

export function deleteKv(key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}

/* ------------------------------- path_cache ------------------------------- */

export interface PathCacheInput {
  fileId: string;
  parentId: string;
  name: string;
  path: string;
  isDir: boolean;
  accountName: string;
}

export function upsertPathCache(rows: PathCacheInput[]): void {
  if (rows.length === 0) return;
  const values = rows.map((r) => ({
    fileId: r.fileId,
    parentId: r.parentId,
    name: r.name,
    path: r.path,
    isDir: r.isDir ? 1 : 0,
    accountName: r.accountName,
    updatedAt: sql`(unixepoch())`,
  }));
  // 分批，避免超过 SQLite 999 个绑定参数的上限
  const CHUNK = 100;
  db.transaction((tx) => {
    for (let i = 0; i < values.length; i += CHUNK) {
      tx.insert(pathCache)
        .values(values.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: pathCache.fileId,
          set: {
            parentId: sql`excluded.parent_id`,
            name: sql`excluded.name`,
            path: sql`excluded.path`,
            isDir: sql`excluded.is_dir`,
            accountName: sql`excluded.account_name`,
            updatedAt: sql`(unixepoch())`,
          },
        })
        .run();
    }
  });
}

export function getPathCacheRow(fileId: string): PathCacheRow | undefined {
  return db.select().from(pathCache).where(eq(pathCache.fileId, fileId)).get();
}

/** 按账号 + 盘内绝对路径找文件（不含目录）：302 换直链时拿 file_id 直接要 pickcode，省掉逐级列目录 */
export function findPathCacheFile(accountName: string, path: string): PathCacheRow | undefined {
  return db
    .select()
    .from(pathCache)
    .where(and(eq(pathCache.accountName, accountName), eq(pathCache.path, path), eq(pathCache.isDir, 0)))
    .get();
}

export function deletePathCache(fileIds: string[]): void {
  if (fileIds.length === 0) return;
  db.delete(pathCache).where(inArray(pathCache.fileId, fileIds)).run();
}

/** 目录改名/移动后，把该目录自身及其所有后代的 path 前缀整体重写 */
export function repathSubtree(oldPath: string, newPath: string): number {
  if (!oldPath || !newPath || oldPath === newPath) return 0;
  const res = db
    .update(pathCache)
    .set({
      path: sql`${newPath} || substr(${pathCache.path}, ${oldPath.length + 1})`,
      updatedAt: sql`(unixepoch())`,
    })
    .where(subtreeOf(oldPath))
    .run();
  return res.changes ?? 0;
}

/**
 * 自身 + 所有后代（后代一定以 `dir/` 开头）。
 * 写成范围查询而不是 LIKE 'dir/%'：LIKE 在 SQLite 里走不了索引，每次目录移动/删除都要全表扫
 * 一遍 path_cache（整个网盘的条目数）。'0' 是 '/' 的下一个字符，`dir/…` 全部落在 [dir/, dir0) 里。
 */
function subtreeOf(dir: string) {
  return sql`(${pathCache.path} = ${dir} OR (${pathCache.path} >= ${dir + "/"} AND ${pathCache.path} < ${dir + "0"}))`;
}

/** 删除目录时清掉整棵子树的缓存 */
export function dropSubtree(path: string): void {
  if (!path) return;
  db.delete(pathCache).where(subtreeOf(path)).run();
}

export function countPathCache(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(pathCache).get();
  return row?.n ?? 0;
}

/* ------------------------------- life_events ------------------------------ */

export interface LifeEventInput {
  id: string;
  accountName: string;
  type: number;
  kind?: string;
  path?: string;
  oldPath?: string;
  fileId: string;
  parentId: string;
  fileName: string;
  fileCategory: number;
  fileSize: number;
  sha1: string;
  pickCode: string;
  updateTime: number;
  createTime: number;
}

export function upsertLifeEvents(rows: LifeEventInput[]): void {
  if (rows.length === 0) return;
  const CHUNK = 60;
  db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      tx.insert(lifeEvents)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoNothing({ target: lifeEvents.id })
        .run();
    }
  });
}

export function markLifeEvent(id: string, status: string, detail = ""): void {
  db.update(lifeEvents)
    .set({ status, detail: detail.slice(0, 500), handledAt: Math.floor(Date.now() / 1000) })
    .where(eq(lifeEvents.id, id))
    .run();
}

export function listRecentLifeEvents(limit = 50): LifeEventRow[] {
  return db.select().from(lifeEvents).orderBy(desc(lifeEvents.updateTime)).limit(limit).all();
}

export function countLifeEvents(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(lifeEvents).get();
  return row?.n ?? 0;
}

/** 同步任务在跑时监控先记下、等同步结束再补的事件的状态 */
export const LIFE_EVENT_DEFERRED = "deferred";

/**
 * 事件表里已经有这个 id、而且已经接手了（处理成功 / 跳过，或者记下了等着补）时返回 true，用于跨重启去重。
 * 记下待补的也算：115 重拉到同一条不能再处理一遍，补的那边会按先后处理它
 */
export function isLifeEventHandled(id: string): boolean {
  const row = db
    .select({ status: lifeEvents.status })
    .from(lifeEvents)
    .where(eq(lifeEvents.id, id))
    .get();
  return row?.status === "done" || row?.status === "skipped" || row?.status === LIFE_EVENT_DEFERRED;
}

/** 这个账号记下待补的事件，按记下的先后（rowid） */
export function listDeferredLifeEvents(accountName: string): LifeEventRow[] {
  return db
    .select()
    .from(lifeEvents)
    .where(and(eq(lifeEvents.accountName, accountName), eq(lifeEvents.status, LIFE_EVENT_DEFERRED)))
    .orderBy(sql`rowid`)
    .all();
}

/** 记下待补的事件条数；不给账号就是全部 */
export function countDeferredLifeEvents(accountName?: string): number {
  const deferred = eq(lifeEvents.status, LIFE_EVENT_DEFERRED);
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(lifeEvents)
    .where(accountName === undefined ? deferred : and(eq(lifeEvents.accountName, accountName), deferred))
    .get();
  return row?.n ?? 0;
}

/* -------------------------------- 留存清理 -------------------------------- */

/**
 * 删掉 115 侧 update_time 早于 cutoff（unix 秒）的事件，返回条数。
 * 记下待补的也一样删：同步跑不了这么久，30 天还没补上的（监控停了一个月、账号已经删了）早就没意义了，下一次全量同步会把本地对齐
 */
export function deleteLifeEventsBefore(cutoffSec: number): number {
  return db.delete(lifeEvents).where(lt(lifeEvents.updateTime, cutoffSec)).run().changes;
}

/** 删掉自 cutoff（unix 秒）以来没被任何目录列举刷新过的路径缓存，返回条数 */
export function deletePathCacheNotTouchedSince(cutoffSec: number): number {
  return db.delete(pathCache).where(lt(pathCache.updatedAt, cutoffSec)).run().changes;
}

/* ------------------------------- drive_snapshots ------------------------------- */

export interface DriveSnapshot<T = unknown, M = unknown> {
  entries: T[];
  /** unix 秒 */
  scannedAt: number;
  /** 快照源自己的附加信息（夸克：根目录的指纹、上次整棵对比的时间）；没写过（老的行是 {}）或读不出来是 null */
  meta: M | null;
}

function parseMeta<M>(raw: string): M | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 ? (v as M) : null;
  } catch {
    return null;
  }
}

export function readDriveSnapshot<T = unknown, M = unknown>(accountName: string, rootPath: string): DriveSnapshot<T, M> | null {
  const row = db
    .select()
    .from(driveSnapshots)
    .where(and(eq(driveSnapshots.accountName, accountName), eq(driveSnapshots.rootPath, rootPath)))
    .get();
  if (!row) return null;
  try {
    return { entries: JSON.parse(row.entries) as T[], scannedAt: row.scannedAt, meta: parseMeta<M>(row.meta) };
  } catch {
    return null;
  }
}

/** meta 不给就写 {}（下一轮读出来是 null） */
export function writeDriveSnapshot(accountName: string, rootPath: string, entries: unknown[], scannedAt: number, meta?: object): void {
  const values = { entries: JSON.stringify(entries), scannedAt, meta: JSON.stringify(meta ?? {}) };
  db.insert(driveSnapshots)
    .values({ accountName, rootPath, ...values })
    .onConflictDoUpdate({ target: [driveSnapshots.accountName, driveSnapshots.rootPath], set: values })
    .run();
}

/** 不指定账号就全清 */
export function deleteDriveSnapshots(accountName?: string): void {
  if (accountName === undefined) db.delete(driveSnapshots).run();
  else db.delete(driveSnapshots).where(eq(driveSnapshots.accountName, accountName)).run();
}

export function countDriveSnapshots(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(driveSnapshots).get();
  return row?.n ?? 0;
}

