/**
 * 影库的「作品」视图：同一个 tmdbId 的单元合成一张卡（几个版本 / 几季），没认出的单元自己一张。
 * 已失效分享里的单元不进海报墙（转存不了），作品弹框的版本列表里照样列出来、标上。
 */
import type {
  LibraryConfidence,
  LibrarySeriesGroup,
  LibraryUnit,
  LibraryWork,
  LibraryWorkDetail,
  LibraryWorksResult,
  LibraryWorksSort,
  LibraryWorksView,
} from "@openstrm/shared";
import { getNode } from "../../db/repositories/library-nodes.js";
import { getShare } from "../../db/repositories/library-shares.js";
import * as units from "../../db/repositories/library-units.js";
import { worksView } from "../../db/repositories/library-works-view.js";
import { getById, healthOf } from "../../db/repositories/media-library.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { parseShareRef } from "../drive/registry.js";
import { normalizeTitle } from "../organize/parse-name.js";
import { titleTags } from "../pansou/tags.js";
import { ownedOfUnit, ownedOfWork, type LocalOwned } from "./owned.js";
import { crumbsForNode } from "./search.js";

const CONF: LibraryConfidence[] = ["none", "low", "medium", "high"];

function groupToWork(g: units.WorkGroup): LibraryWork {
  return {
    key: units.workKey(g.mediaType, g.tmdbId),
    tmdbId: g.tmdbId,
    mediaType: g.mediaType,
    title: g.title,
    year: g.year,
    posterUrl: g.posterUrl,
    confidence: CONF[g.conf] ?? "none",
    versions: g.versions,
    shares: g.shares,
    videoCount: g.videoCount,
    size: g.size,
    seasons: g.seasons,
    addedAt: g.addedAt,
    ...(g.genres.length ? { genres: g.genres } : {}),
    ...(g.countries.length ? { countries: g.countries } : {}),
  };
}

function unitToWork(u: units.UnitRow): LibraryWork {
  return {
    key: units.unitWorkKey(u.sourceId, u.unitKey),
    tmdbId: null,
    mediaType: null,
    title: u.parsedTitle || u.rawName,
    year: u.parsedYear,
    posterUrl: "",
    confidence: "none",
    versions: 1,
    shares: 1,
    videoCount: u.videoCount,
    size: u.size,
    seasons: u.seasons,
    addedAt: u.createdAt,
  };
}

/* ------------------------------- 海报墙 ------------------------------- */

/** 复用一个比较器：每次比较都 localeCompare 会各建一个 locale 比较器，几万部排一次要两三秒 */
const collator = new Intl.Collator("zh-CN", { numeric: true });
const byTitle = (a: LibraryWork, b: LibraryWork) => collator.compare(a.title, b.title);
const yearOf = (w: LibraryWork) => Number(w.year) || 0;

/** 三种排序：最近入库、年份（新的在前，没年份的最后）、名称；同一档再按名称 */
export const WORK_COMPARATORS: Record<LibraryWorksSort, (a: LibraryWork, b: LibraryWork) => number> = {
  recent: (a, b) => b.addedAt - a.addedAt || byTitle(a, b),
  year: (a, b) => yearOf(b) - yearOf(a) || byTitle(a, b),
  title: byTitle,
};

export interface WorksQuery {
  view: LibraryWorksView;
  sort: LibraryWorksSort;
  offset: number;
  limit: number;
  /** 名字里有（正式名、原名、英文名；没认出的看目录名），大小写、标点、全角半角不计较 */
  keyword?: string;
  /** `2024` 或者 `2020-2024` */
  year?: string;
  /** TMDB 类型编号（任一对上）：genres.ts 的 genreIdsOf 从「科幻」换来 */
  genres?: number[];
  /** 国家 / 地区代码（任一对上）：countryCodesOf 从「韩国」换来 */
  countries?: string[];
}

/** `2024` / `2020-2024` / `2024-2020`：认不出返回 null（不筛） */
export function yearRange(text: string | undefined): [number, number] | null {
  const m = /^\s*(\d{4})\s*(?:[-~–至到]\s*(\d{4}))?\s*$/.exec(text ?? "");
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return a <= b ? [a, b] : [b, a];
}

/**
 * 视图映射成 LibraryWork 之后的那一层，按视图的 generation 缓存：认出的、没认出的各一个数组，每种排序各一份排好的
 * （用到才排），按名字筛用的归一化名字（用到才建）。几万部时映射加排序几十毫秒，只在视图变了（识别进行中每次轮询都会变）
 * 才重做；一次请求剩下的只是筛选和切片。
 */
interface Derived {
  generation: number;
  identified: LibraryWork[];
  unidentified: LibraryWork[];
  sorted: Map<string, LibraryWork[]>;
  names: Map<string, string[]> | null;
  counts: LibraryWorksResult["counts"];
}

let derived: Derived | null = null;

function derivedOf(): Derived {
  const v = worksView();
  if (derived?.generation === v.generation) return derived;
  const identified = [...v.groups.values()].map(groupToWork);
  const unidentified = [...v.unidentified.values()].map(unitToWork);
  derived = {
    generation: v.generation,
    identified,
    unidentified,
    sorted: new Map(),
    names: null,
    counts: {
      all: identified.length,
      movie: identified.filter((w) => w.mediaType === "movie").length,
      tv: identified.filter((w) => w.mediaType === "tv").length,
      low: identified.filter((w) => w.confidence === "low").length,
      none: unidentified.length,
      pending: v.counts.pending,
    },
  };
  return derived;
}

function sortedOf(d: Derived, pool: "identified" | "unidentified", sort: LibraryWorksSort): LibraryWork[] {
  const key = `${pool}:${sort}`;
  let list = d.sorted.get(key);
  if (!list) {
    list = [...d[pool]].sort(WORK_COMPARATORS[sort]);
    d.sorted.set(key, list);
  }
  return list;
}

/** 按名字筛用的：正式名、原名、英文名归一化；没认出的只有目录名 */
function namesOf(d: Derived): Map<string, string[]> {
  if (d.names) return d.names;
  const names = new Map<string, string[]>();
  for (const [key, g] of worksView().groups) names.set(key, [g.title, g.originalTitle, g.enTitle].map(normalizeTitle).filter(Boolean));
  for (const w of d.unidentified) names.set(w.key, [normalizeTitle(w.title)].filter(Boolean));
  d.names = names;
  return names;
}

/** 给出去的是副本（数组也复制）：缓存里的对象不能被 owned 标记或者调用方改到 */
const withOwned = (w: LibraryWork, owned?: Set<string>): LibraryWork => ({
  ...w,
  seasons: [...w.seasons],
  ...(w.genres ? { genres: [...w.genres] } : {}),
  ...(w.countries ? { countries: [...w.countries] } : {}),
  ...(owned?.has(w.key) ? { owned: true } : {}),
});

/**
 * 海报墙：在缓存好的视图上筛、切页（排序是预排好的，筛选不打乱顺序）。
 * owned：已经有了的作品键（ownedWorkKeys），给了就在给出去的每部上标 owned
 */
export function listWorks(q: WorksQuery, owned?: Set<string>): LibraryWorksResult {
  const d = derivedOf();
  let list: LibraryWork[];
  switch (q.view) {
    case "movie":
      list = sortedOf(d, "identified", q.sort).filter((w) => w.mediaType === "movie");
      break;
    case "tv":
      list = sortedOf(d, "identified", q.sort).filter((w) => w.mediaType === "tv");
      break;
    case "low":
      list = sortedOf(d, "identified", q.sort).filter((w) => w.confidence === "low");
      break;
    case "none":
      list = sortedOf(d, "unidentified", q.sort);
      break;
    default:
      list = sortedOf(d, "identified", q.sort);
  }
  const kw = normalizeTitle(q.keyword ?? "");
  if (kw) {
    const names = namesOf(d);
    list = list.filter((w) => (names.get(w.key) ?? []).some((n) => n.includes(kw)));
  }
  const years = yearRange(q.year);
  if (years) list = list.filter((w) => Number(w.year) >= years[0] && Number(w.year) <= years[1]);
  if (q.genres?.length) list = list.filter((w) => w.genres?.some((g) => q.genres!.includes(g)));
  if (q.countries?.length) list = list.filter((w) => w.countries?.some((c) => q.countries!.includes(c)));
  return {
    works: list.slice(q.offset, q.offset + q.limit).map((w) => withOwned(w, owned)),
    total: list.length,
    counts: { ...d.counts },
    tmdbConfigured: !!readAppSettings().tmdb?.apiKey?.trim(),
  };
}

/**
 * 「片名 年份」「片名 (2011)」→ 片名 + 年份：年份在最后、前面隔着空格或括号、不晚于明后年才算
 * （「2012」「银翼杀手2049」「Blade Runner 2049」这种片名本身不拆）
 */
export function splitTitleYear(text: string): { name: string; year?: string } {
  const m = /^(.*?\S)[\s(（]+((?:19|20)\d{2})[)）]?\s*$/.exec(text.trim());
  return m && Number(m[2]) <= new Date().getFullYear() + 2 ? { name: m[1].trim(), year: m[2] } : { name: text.trim() };
}

export interface WorkLookup {
  query: string;
  /** 对上的那一部；对不上、或者说不准是哪部时是 null */
  work: LibraryWork | null;
  /** 名字对得上好几部（重名、翻拍）：前几部，让人挑 */
  maybe: LibraryWork[];
}

/**
 * 片单：一串片名逐个找收藏夹里认出来的作品。名字整个对上（正式名、原名、英文名）的优先；没有整个对上的，
 * 只有一部名字包含它（或者它包含那部的名字）也算；给了年份要对上。owned 同 listWorks
 */
export function lookupWorks(titles: string[], owned?: Set<string>): WorkLookup[] {
  const d = derivedOf();
  const names = namesOf(d);
  const works = d.identified.map((w) => ({ w, names: names.get(w.key) ?? [] }));
  return titles.map((query) => {
    const { name, year } = splitTitleYear(query);
    const n = normalizeTitle(name);
    const pool = year ? works.filter((x) => x.w.year === year) : works;
    const exact = n ? pool.filter((x) => x.names.includes(n)) : [];
    const hits = exact.length || !n ? exact : pool.filter((x) => x.names.some((m) => m.includes(n) || (m.length >= 2 && n.includes(m))));
    return hits.length === 1 ? { query, work: withOwned(hits[0].w, owned), maybe: [] } : { query, work: null, maybe: hits.slice(0, 3).map((x) => withOwned(x.w, owned)) };
  });
}

/** 一个单元连同它在哪个分享、分享死活、打开 / 转存要的东西 */
export function unitView(u: units.UnitRow): LibraryUnit | null {
  const source = getById(u.sourceId);
  if (!source) return null;
  const node = getNode(u.sourceId, u.nodeId);
  const kind = parseShareRef(source.shareUrl)?.kind;
  const nameTags = titleTags(u.rawName);
  const item = (n: NonNullable<typeof node>) => ({ id: n.nodeId, name: n.name, isDir: n.isDir, parentId: n.parentId || "0", ...(n.token ? { token: n.token } : {}) });
  const saveItems = u.ownsDir
    ? node
      ? [item(node)]
      : []
    : u.fileIds.map((id) => getNode(u.sourceId, id)).filter((n): n is NonNullable<typeof node> => n !== null).map(item);
  return {
    sourceId: u.sourceId,
    unitKey: u.unitKey,
    nodeId: u.nodeId,
    parentId: node?.parentId ?? "",
    path: u.path,
    crumbs: crumbsForNode(u.sourceId, u.nodeId),
    rawName: u.rawName,
    ownsDir: u.ownsDir,
    fileIds: u.fileIds,
    saveItems,
    parsedTitle: u.parsedTitle,
    parsedYear: u.parsedYear,
    kindHint: u.kindHint,
    seasons: u.seasons,
    videoCount: u.videoCount,
    size: u.size,
    sampleFile: u.sampleFile,
    // 季另外列（seasons）：样例文件名里的「第 1 季」只是其中一季，别当成整个单元的
    tags: (nameTags.length > 0 || !u.sampleFile ? nameTags : titleTags(u.sampleFile)).filter((t) => !/^第 .+ 季$/.test(t)),
    status: u.status,
    work:
      u.tmdbId != null && u.mediaType && (u.status === "done" || u.status === "manual")
        ? {
            tmdbId: u.tmdbId,
            mediaType: u.mediaType,
            title: u.title,
            year: u.year,
            posterUrl: u.posterUrl,
            confidence: u.status === "manual" ? "high" : u.confidence,
            originalTitle: u.originalTitle,
            enTitle: u.enTitle,
            reason: u.status === "manual" ? "手动指定" : u.reason,
          }
        : null,
    candidates: u.candidates,
    shareKind: kind === "quark" ? "quark" : "115",
    shareCode: source.shareCode,
    shareUrl: source.shareUrl,
    shareTitle: source.shareTitle || source.title,
    ...(node?.token ? { token: node.token } : {}),
    health: healthOf(getShare(source.shareCode)),
    identifiedAt: u.identifiedAt,
    error: u.error,
  };
}

/** 单元转存的东西放在分享里哪个目录下：有自己目录的是上一级，散放的文件就是它自己 */
const folderOf = (u: LibraryUnit) => (u.ownsDir ? u.crumbs.slice(0, -1) : u.crumbs).at(-1)?.name || u.shareTitle;

/**
 * 一部剧的几季一季一个目录、分开放在同一个目录下（「纸牌屋 全6季」里一季一个目录，各是一个单元）：能一起转存的那几组。
 * 按目录分组（同一个分享里常有两套：旧版本、洗版各 6 季）；每个都要认得出是第几季、季不能重叠（重叠的是同一季的不同版本，
 * 挑一个存就行）；转存的条目不能重名（115 会把它们平铺进同一个目录）；分享失效的不算
 */
export function seriesGroupsOf(mediaType: "movie" | "tv" | null, list: LibraryUnit[]): LibrarySeriesGroup[] {
  if (mediaType !== "tv") return [];
  const byFolder = new Map<string, LibraryUnit[]>();
  for (const u of list) {
    if (u.health.status === "expired" || u.saveItems.length === 0) continue;
    const key = JSON.stringify([u.sourceId, u.saveItems[0].parentId]);
    byFolder.set(key, [...(byFolder.get(key) ?? []), u]);
  }
  const out: LibrarySeriesGroup[] = [];
  for (const group of byFolder.values()) {
    if (group.length < 2 || group.some((u) => u.seasons.length === 0)) continue;
    const seasons = group.flatMap((u) => u.seasons);
    const names = group.flatMap((u) => u.saveItems.map((i) => i.name));
    if (new Set(seasons).size !== seasons.length || new Set(names).size !== names.length) continue;
    const sorted = [...group].sort((a, b) => a.seasons[0] - b.seasons[0]);
    out.push({ folder: folderOf(sorted[0]), seasons: [...seasons].sort((a, b) => a - b), units: sorted.map((u) => `${u.sourceId}:${u.unitKey}`) });
  }
  return out;
}

/**
 * 作品弹框：`movie:123` / `tv:456` 是这部作品的所有单元；`unit:<来源>:<单元键>` 是那一个没认出的。
 * local：本地已有的作品索引（localOwned），没算好时给 null，owned 就只有从收藏夹存过的
 */
export function workDetail(key: string, local: LocalOwned | null = null): LibraryWorkDetail | null {
  const m = /^(movie|tv):(\d+)$/.exec(key);
  if (m) {
    const list = units.unitsOfWork(m[1] as "movie" | "tv", Number(m[2]));
    if (list.length === 0) return null;
    const views = list.map(unitView).filter((v): v is LibraryUnit => v !== null);
    const best = [...list].sort((a, b) => rankOf(b) - rankOf(a))[0];
    const work: LibraryWork = {
      key,
      tmdbId: Number(m[2]),
      mediaType: m[1] as "movie" | "tv",
      title: best.title,
      year: best.year,
      posterUrl: best.posterUrl,
      confidence: CONF[rankOf(best)] ?? "none",
      versions: list.length,
      shares: new Set(list.map((u) => u.sourceId)).size,
      videoCount: list.reduce((s, u) => s + u.videoCount, 0),
      size: Math.max(...list.map((u) => u.size)),
      seasons: [...new Set(list.flatMap((u) => u.seasons))].sort((a, b) => a - b),
      addedAt: Math.max(...list.map((u) => u.createdAt)),
      ...detailsOfUnits(list),
    };
    const owned = ownedOfWork(work.mediaType!, work.tmdbId!, local);
    if (owned.length) work.owned = true;
    return { work, units: views, owned, seriesGroups: seriesGroupsOf(work.mediaType, views) };
  }
  const u = /^unit:([^:]+):(.+)$/.exec(key);
  if (!u) return null;
  const row = units.getUnit(u[1], u[2]);
  if (!row) return null;
  const view = unitView(row);
  if (!view) return null;
  const owned = ownedOfUnit(row);
  return { work: { ...unitToWork(row), ...(owned.length ? { owned: true } : {}) }, units: [view], owned, seriesGroups: [] };
}

/** 作品的类型、国家 / 地区：几个单元是同一部，取第一个补上了的 */
function detailsOfUnits(list: units.UnitRow[]): Pick<LibraryWork, "genres" | "countries"> {
  const u = list.find((x) => x.genres !== null);
  if (!u) return {};
  return { ...(u.genres?.length ? { genres: u.genres } : {}), ...(u.countries?.length ? { countries: u.countries } : {}) };
}

function rankOf(u: units.UnitRow): number {
  if (u.status === "manual") return 3;
  return CONF.indexOf(u.confidence);
}
