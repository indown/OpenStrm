/**
 * 追更和整理之间的两头交接（追更那边的记录见 follow/service.ts 的 learnFollowOrganized）：
 *
 *   - 用：追更把新文件交给整理时带上识别提示（OrganizeHint，按上次整理同一个目录的结果给）。hintFor 判断一个单元能不能照着用：
 *     视频全被同一条提示覆盖、写了片名的都对得上才用，不然照常识别，说一句为什么。
 *   - 记：整理执行完，organizedVideos 把这次挪过 / 改过名的视频连同所在单元的匹配、季、偏移交给追更，追更按自己的快照认出哪些是它转存来的。
 */
import type { OrganizeHint, OrganizeItem, OrganizeMediaType, OrganizeUnit, TaskDefinition } from "@openstrm/shared";
import { normalizeTitle, parseMediaName, seasonDirNumber } from "./parse-name.js";
import type { ParsedRule } from "./rules.js";
import { baseOf, dirOf, relOf } from "./run-state.js";
import { titlesOfName, type Unit } from "./units.js";

/** 识别理由、单元说明里的来源：「追更「某剧」上次的整理」 */
export const hintSource = (h: Pick<OrganizeHint, "label">): string => `追更「${h.label}」上次的整理`;

const sameHint = (a: OrganizeHint, b: OrganizeHint): boolean =>
  a.mediaType === b.mediaType && a.tmdbId === b.tmdbId && a.season === b.season && a.seasonFallback === b.seasonFallback && a.episodeOffset === b.episodeOffset;

/**
 * 这个单元能不能照提示认：视频全被提示覆盖、是同一条、文件名写了片名的都在提示的片名里（提示没记片名就不核对）。
 * 有带提示的视频、但用不了：hint 是 null，note 说为什么；一个都没带就什么都不说
 */
export function hintFor(unit: Unit, hints: readonly OrganizeHint[]): { hint: OrganizeHint | null; note?: string } {
  if (hints.length === 0) return { hint: null };
  const byPath = new Map(hints.map((h) => [h.path, h]));
  const videos = unit.files.filter((f) => f.kind === "video" && !f.inExtrasDir && !f.parsed.isExtra);
  const covered = videos.map((v) => byPath.get(v.path));
  const first = covered.find((h): h is OrganizeHint => !!h);
  if (!first) return { hint: null };
  const source = hintSource(first);
  if (covered.some((h) => !h)) return { hint: null, note: `这部作品里还有不是追更「${first.label}」这次带来的文件，没沿用${source}` };
  if (covered.some((h) => !sameHint(h!, first))) return { hint: null, note: `这批文件带的追更提示不一样，没沿用${source}` };
  const titles = new Set(first.titles);
  const off = titles.size > 0 ? videos.find((v) => v.parsed.titles.length > 0 && !v.parsed.titles.some((t) => titles.has(normalizeTitle(t)))) : undefined;
  if (off) return { hint: null, note: `「${off.name}」的片名和${source}对不上，没沿用` };
  return { hint: first };
}

/** 整理执行收尾交给追更的一个视频（路径相对任务 originPath） */
export interface OrganizedVideo {
  src: string;
  dst: string;
  /** 目标文件名 / 目标目录解析出的季，看不出是 null */
  season: number | null;
  /** 原文件名里的片名（套过识别词、归一过） */
  titles: string[];
  unit: { mediaType: OrganizeMediaType; tmdbId: number; title: string; year: string; seasonOverride: number | null; episodeOffset: number; dstRoot: string };
}

/** 整理好的路径落在第几季：先看文件名（模板默认带 SxxEyy），再看所在目录（Season 02） */
function seasonOfPath(path: string): number | null {
  const name = baseOf(path);
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return parseMediaName(stem).season ?? seasonDirNumber(baseOf(dirOf(path))) ?? null;
}

/** 这次真挪过 / 改过名的视频，带上所在单元的识别结果（单元没匹配、没有作品目录的不算） */
export function organizedVideos(task: TaskDefinition, units: OrganizeUnit[], items: OrganizeItem[], rules: ParsedRule[]): OrganizedVideo[] {
  const byKey = new Map(units.map((u) => [u.key, u]));
  const out: OrganizedVideo[] = [];
  for (const it of items) {
    if (it.kind !== "video" || it.status !== "done" || (it.action !== "rename" && it.action !== "move")) continue;
    const u = byKey.get(it.unitKey);
    if (!u?.match || !u.dstRoot) continue;
    const src = relOf(task, it.srcPath);
    const dst = relOf(task, it.dstPath);
    out.push({
      src,
      dst,
      season: seasonOfPath(dst),
      titles: titlesOfName(baseOf(src), rules),
      unit: { mediaType: u.match.mediaType, tmdbId: u.match.tmdbId, title: u.titleOverride || u.match.title, year: u.yearOverride || u.match.year, seasonOverride: u.seasonOverride, episodeOffset: u.episodeOffset, dstRoot: u.dstRoot },
    });
  }
  return out;
}
