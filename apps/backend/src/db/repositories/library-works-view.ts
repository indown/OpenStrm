/**
 * 海报墙视图：作品分组、没认出的单元、各状态计数、每来源统计，全量建一次留在内存里，之后按单元增量维护。
 *
 * 为什么不每次请求现算：几万单元时一次 GROUP BY 加建对象要几百毫秒到几秒，而且是同步的；页面在有单元待认时
 * 每 5 秒轮询一次，Node 单线程，别的页面的请求全排在它后面（方案 .claude/plans/library-works-cache.md）。
 * 为什么按单元增量而不是一变就整个重建：识别工人每秒认一两个，轮询正好发生在识别进行中，整个重建等于没缓存。
 *
 * 单个单元变了（认出、换匹配、忽略、重认、补类型）：涉及的一两个作品分组用带条件的同一条 GROUP BY 重查
 * （走 tmdb 索引，毫秒级），没认出的那一条按单元键重查，计数按前后分类加减，这个来源的统计按来源重查。
 * 批量变动（重切、删来源、分享进出失效、全部重认）：整个丢掉，下次读再建。
 */
import { moduleLogger } from "../../lib/logger.js";
import { onLibraryChange, type LibraryChange, type UnitKeyState } from "./library-changes.js";
import { unidentifiedUnits, unitStatusCounts, unitSummaries, unitWorkKey, workGroups, workKey, type SourceUnitSummary, type UnitRow, type WorkGroup } from "./library-units.js";

const log = moduleLogger("library-works-view");

export type StatusCounts = ReturnType<typeof unitStatusCounts>;

export interface WorksView {
  /** 每次变动加一：上层按它缓存派生的东西（映射成 LibraryWork、排好序的数组） */
  generation: number;
  /** 作品键（workKey：`movie:123` / `tv:456`）→ 分组 */
  groups: Map<string, WorkGroup>;
  /** 作品键（unitWorkKey：`unit:<来源>:<单元键>`，和海报墙上这张卡的 key 一样）→ 认过但没认出的单元 */
  unidentified: Map<string, UnitRow>;
  counts: StatusCounts;
  /** 来源 id → 单元统计（忽略的不算；只有忽略的来源没有这一项） */
  summaries: Map<string, SourceUnitSummary>;
}

let view: WorksView | null = null;
let generation = 0;

/** 视图：第一次读时全量建，之后增量维护。读到的对象别改（上层按 generation 缓存派生结果） */
export function worksView(): WorksView {
  if (view) return view;
  const groups = new Map(workGroups().map((g) => [workKey(g.mediaType, g.tmdbId), g] as const));
  const unidentified = new Map(unidentifiedUnits().map((u) => [unitWorkKey(u.sourceId, u.unitKey), u] as const));
  view = { generation: ++generation, groups, unidentified, counts: unitStatusCounts(), summaries: unitSummaries() };
  return view;
}

/** 整个作废，下次读再建（批量变动、测试） */
export function invalidateWorksView(): void {
  view = null;
}

/** 启动后预热：重启后第一次打开收藏夹不用再等全量聚合 */
export function warmWorksView(): void {
  worksView();
}

/** 仅供测试：视图建好了没有 */
export function __test_viewBuilt(): boolean {
  return view !== null;
}

function classify(s: UnitKeyState | null): keyof StatusCounts | null {
  if (!s) return null;
  if (s.status === "pending") return "pending";
  if (s.status === "ignored") return "ignored";
  return s.tmdbId != null ? "identified" : "none";
}

/** 认过但没认出：会出现在「没认出」里的状态 */
const maybeUnidentified = (s: UnitKeyState | null): boolean => s !== null && s.status === "done" && s.tmdbId == null;

/** 一部作品的分组按库里现在的样子重查（没有符合条件的单元了就从视图里拿掉） */
function refreshGroup(v: WorksView, mediaType: "movie" | "tv", tmdbId: number): void {
  const key = workKey(mediaType, tmdbId);
  const g = workGroups({ mediaType, tmdbId })[0];
  if (g) v.groups.set(key, g);
  else v.groups.delete(key);
}

function applyUnitChange(v: WorksView, c: Extract<LibraryChange, { kind: "unit" }>): void {
  // 分组：写前写后指到的作品都重查一遍（换匹配是从一部换到另一部，两边都要动）
  const seen = new Set<string>();
  for (const s of [c.before, c.after]) {
    if (!s || s.tmdbId == null || !s.mediaType) continue;
    const key = workKey(s.mediaType, s.tmdbId);
    if (seen.has(key)) continue;
    seen.add(key);
    refreshGroup(v, s.mediaType, s.tmdbId);
  }
  // 没认出的那一条：前后都不可能在里面就不用查
  const ukey = unitWorkKey(c.sourceId, c.unitKey);
  if (maybeUnidentified(c.before) || maybeUnidentified(c.after)) {
    const row = unidentifiedUnits({ sourceId: c.sourceId, unitKey: c.unitKey })[0];
    if (row) v.unidentified.set(ukey, row);
    else v.unidentified.delete(ukey);
  } else {
    v.unidentified.delete(ukey);
  }
  const before = classify(c.before);
  const after = classify(c.after);
  if (before) v.counts[before]--;
  if (after) v.counts[after]++;
  const summary = unitSummaries(c.sourceId).get(c.sourceId);
  if (summary) v.summaries.set(c.sourceId, summary);
  else v.summaries.delete(c.sourceId);
  v.generation = ++generation;
}

onLibraryChange((change) => {
  if (!view) return;
  if (change.kind === "all") {
    invalidateWorksView();
    return;
  }
  try {
    if (change.kind === "group") {
      refreshGroup(view, change.mediaType, change.tmdbId);
      view.generation = ++generation;
    } else {
      applyUnitChange(view, change);
    }
  } catch (err) {
    // 增量没跟上（库报错之类）：丢掉重建，下次读照样是对的。记一笔：一直这样的话每次写都会退化成全量重建，得能从日志看出来
    log.warn({ err, change }, "海报墙视图增量更新失败，整个作废重建");
    invalidateWorksView();
  }
});
