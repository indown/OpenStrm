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

export function getMediaProbes(accountName: string, keys: string[]): Map<string, MediaProbeRow> {
  const out = new Map<string, MediaProbeRow>();
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    const rows = db
      .select()
      .from(mediaProbes)
      .where(and(eq(mediaProbes.accountName, accountName), inArray(mediaProbes.key, chunk)))
      .all();
    for (const r of rows) {
      out.set(r.key, { accountName: r.accountName, key: r.key, path: r.path, size: r.size, status: r.status === "ok" ? "ok" : "failed", data: r.status === "ok" ? parseData(r.data) : null, error: r.error, probedAt: r.probedAt });
    }
  }
  return out;
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
