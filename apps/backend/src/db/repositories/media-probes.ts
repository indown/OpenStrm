/** 网盘视频的探测结果缓存（services/media/probe.ts）：按账号 + 文件 id（没 id 的按绝对路径）记，大小变了才重探 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../client.js";
import { mediaProbes } from "../schema.js";
import type { MediaProbe } from "../../services/media/probe.js";

export interface MediaProbeRow {
  accountName: string;
  key: string;
  path: string;
  size: number;
  status: "ok" | "failed";
  data: MediaProbe | null;
  error: string;
  probedAt: number;
}

function parseData(text: string): MediaProbe | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && "audio" in (v as object) ? (v as MediaProbe) : null;
  } catch {
    return null;
  }
}

const toRow = (r: typeof mediaProbes.$inferSelect): MediaProbeRow => ({
  accountName: r.accountName,
  key: r.key,
  path: r.path,
  size: r.size,
  status: r.status === "ok" ? "ok" : "failed",
  data: r.status === "ok" ? parseData(r.data) : null,
  error: r.error,
  probedAt: r.probedAt,
});

export function getMediaProbes(accountName: string, keys: string[]): Map<string, MediaProbeRow> {
  const out = new Map<string, MediaProbeRow>();
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    const rows = db
      .select()
      .from(mediaProbes)
      .where(and(eq(mediaProbes.accountName, accountName), inArray(mediaProbes.key, chunk)))
      .all();
    for (const r of rows) out.set(r.key, toRow(r));
  }
  return out;
}

/** 按网盘绝对路径找（strm 页用，走 account + path 的索引）。同一路径可能有两行（按 id 记的 + Emby 回填的），都回 */
export function getMediaProbesByPaths(accountName: string, paths: string[]): MediaProbeRow[] {
  const out: MediaProbeRow[] = [];
  for (let i = 0; i < paths.length; i += 400) {
    const chunk = paths.slice(i, i + 400);
    const rows = db
      .select()
      .from(mediaProbes)
      .where(and(eq(mediaProbes.accountName, accountName), inArray(mediaProbes.path, chunk)))
      .all();
    for (const r of rows) out.push(toRow(r));
  }
  return out;
}

/**
 * 文件被整理挪了位置 / 改了名（或撤销退回）：缓存行的 path 跟着改，strm 页按新路径才找得到。
 * 按路径记的行（Emby 回填的，键是 `path:` + 路径，见 probe.ts 的 probeKey）键也一起换，目标处已经有一行就让挪过来的盖掉；
 * 按文件 id 记的行只改 path。返回改了几行
 */
export function repathMediaProbes(accountName: string, moves: ReadonlyArray<{ from: string; to: string }>): number {
  let n = 0;
  if (moves.length === 0) return n;
  db.transaction((tx) => {
    for (const m of moves) {
      if (m.from === m.to) continue;
      const rows = tx
        .select()
        .from(mediaProbes)
        .where(and(eq(mediaProbes.accountName, accountName), eq(mediaProbes.path, m.from)))
        .all();
      for (const r of rows) {
        if (r.key === `path:${m.from}`) {
          tx.delete(mediaProbes).where(and(eq(mediaProbes.accountName, accountName), eq(mediaProbes.key, r.key))).run();
          tx.insert(mediaProbes)
            .values({ ...r, key: `path:${m.to}`, path: m.to })
            .onConflictDoUpdate({ target: [mediaProbes.accountName, mediaProbes.key], set: { path: m.to, size: r.size, status: r.status, data: r.data, error: r.error, probedAt: r.probedAt } })
            .run();
        } else {
          tx.update(mediaProbes).set({ path: m.to }).where(and(eq(mediaProbes.accountName, accountName), eq(mediaProbes.key, r.key))).run();
        }
        n++;
      }
    }
  });
  return n;
}

export function putMediaProbe(row: MediaProbeRow): void {
  const values = { accountName: row.accountName, key: row.key, path: row.path, size: row.size, status: row.status, data: JSON.stringify(row.data ?? {}), error: row.error, probedAt: row.probedAt };
  db.insert(mediaProbes)
    .values(values)
    .onConflictDoUpdate({ target: [mediaProbes.accountName, mediaProbes.key], set: values })
    .run();
}

export function countMediaProbes(): number {
  return db.select().from(mediaProbes).all().length;
}

/** 仅供测试 */
export function __test_resetMediaProbes(): void {
  db.delete(mediaProbes).run();
}
