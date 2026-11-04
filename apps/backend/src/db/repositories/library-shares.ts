/**
 * 影库里的分享死活（按分享码）。同一个分享收了几次（整包、子目录）共用一行；最后一个来源删掉时这一行也删。
 */
import { and, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../client.js";
import { libraryShares, mediaLibrary } from "../schema.js";
import { notifyLibraryChange } from "./library-changes.js";

export type LibraryShareRow = typeof libraryShares.$inferSelect;

/** 有来源时建一行（已有就不动） */
export function ensureShare(shareCode: string, kind: string): void {
  db.insert(libraryShares).values({ shareCode, kind }).onConflictDoNothing().run();
}

export function getShare(shareCode: string): LibraryShareRow | null {
  return db.select().from(libraryShares).where(eq(libraryShares.shareCode, shareCode)).get() ?? null;
}

export function updateShare(shareCode: string, patch: Partial<Omit<LibraryShareRow, "shareCode">>): void {
  if (Object.keys(patch).length === 0) return;
  const wasExpired = patch.status !== undefined ? getShare(shareCode)?.status === "expired" : undefined;
  const { changes } = db.update(libraryShares).set(patch).where(eq(libraryShares.shareCode, shareCode)).run();
  // 分享进出失效：里面的单元整批进出海报墙，视图整个作废（没这一行的什么都没改，不作废）
  if (changes > 0 && patch.status !== undefined && wasExpired !== (patch.status === "expired")) notifyLibraryChange({ kind: "all" });
}

/** 这个分享码在影库里有没有来源：分享观察者只记影库里有的 */
export function isLibraryShare(shareCode: string): boolean {
  return getShare(shareCode) !== null;
}

/** 没有来源了就删掉这一行 */
export function deleteShareIfUnused(shareCode: string): void {
  const used = db.select({ id: mediaLibrary.id }).from(mediaLibrary).where(eq(mediaLibrary.shareCode, shareCode)).get();
  if (!used) db.delete(libraryShares).where(eq(libraryShares.shareCode, shareCode)).run();
}

export function listShares(): LibraryShareRow[] {
  return db.select().from(libraryShares).all();
}

/**
 * 该查的分享：疑似失效到了复查时间的，和超过 patrolBefore 没查过的（已失效的不再查，等用户换链接）
 */
export function listDueChecks(nowSec: number, patrolBeforeSec: number | null): LibraryShareRow[] {
  const dueSuspect = and(eq(libraryShares.status, "suspect"), isNotNull(libraryShares.nextCheckAt), lte(libraryShares.nextCheckAt, nowSec));
  const stale =
    patrolBeforeSec == null
      ? sql`0`
      : and(ne(libraryShares.status, "expired"), or(isNull(libraryShares.checkedAt), lte(libraryShares.checkedAt, patrolBeforeSec)));
  return db
    .select()
    .from(libraryShares)
    .where(or(dueSuspect, stale))
    .orderBy(libraryShares.checkedAt)
    .all();
}

/** 已失效的分享码 */
export function listExpiredCodes(): string[] {
  return db
    .select({ code: libraryShares.shareCode })
    .from(libraryShares)
    .where(eq(libraryShares.status, "expired"))
    .all()
    .map((r) => r.code);
}
