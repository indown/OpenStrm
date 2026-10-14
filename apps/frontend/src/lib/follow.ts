import type { ShareFollowOrganized, ShareFollowSummary } from "@openstrm/shared";

/** 追更检查间隔的预设（分钟）。上下限由后端夹（30 分钟 ~ 7 天） */
export const FOLLOW_INTERVALS = [
  { value: 60, label: "每 1 小时" },
  { value: 180, label: "每 3 小时" },
  { value: 360, label: "每 6 小时" },
  { value: 720, label: "每 12 小时" },
  { value: 1440, label: "每天" },
] as const;

export const DEFAULT_FOLLOW_INTERVAL = 360;

export function intervalLabel(minutes: number): string {
  const hit = FOLLOW_INTERVALS.find((o) => o.value === minutes);
  if (hit) return hit.label;
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

/** 一条整理沿用拆成几段：片名 (年)、第 N 季、集偏移；补空的季是第 1 季就不提 */
export function organizedParts(o: ShareFollowOrganized): string[] {
  const season = o.season ?? (o.seasonFallback !== null && o.seasonFallback !== 1 ? o.seasonFallback : null);
  return [
    `${o.title}${o.year ? ` (${o.year})` : ""}`,
    season !== null ? `第 ${season} 季` : "",
    o.episodeOffset ? `集偏移 ${o.episodeOffset > 0 ? "+" : ""}${o.episodeOffset}` : "",
  ].filter(Boolean);
}

/** 一条整理沿用的一句话：「我和僵尸有个约会 (1998) · 第 2 季 · 集偏移 +12」 */
export const organizedLabel = (o: ShareFollowOrganized): string => organizedParts(o).join(" · ");

/** 追更范围的一句话："整个目录" 或目录名列表 */
export function scopeLabel(f: Pick<ShareFollowSummary, "scope">): string {
  const scope = f.scope ?? [];
  if (scope.length === 0 || scope.includes("")) return "整个目录";
  return scope.join("、");
}
