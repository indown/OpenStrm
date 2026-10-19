/**
 * 识别：一个作品单元 → TMDB 上的哪一部。证据优先级从高到低：
 *   识别词直指 → 用户记忆（organize_matches）→ 目录名里的 id 标签 → 本地 nfo（和 nfo 自己写的标题核对）→ 影库条目
 *   → 目录名 / 文件名解析后搜索打分。
 *
 * 打分：标题（归一化后对 title / original_title / 别名）相等 +3；年份相等 +2、差一年 +1；类型和解析一致 +1；
 * popularity 只做同分排序。置信度：来自 id 证据或「标题相等且年份相等」是 high；标题相等但年份缺 / 差一年、
 * 或首选领先第二名 ≥ 3 分是 medium；其余有结果是 low；没结果 none。
 *
 * TMDB 请求都过 TmdbClient：进程内 + 库里两层缓存，节流在 services/tmdb.ts；设置页能一键清空（purgeTmdbCache）。
 */
import type { OrganizeCandidate, OrganizeConfidence, OrganizeMatch, OrganizeMatchMemory, OrganizeMediaType } from "@openstrm/shared";
import { clearTmdbCache, readTmdbCache, writeTmdbCache } from "../../db/repositories/organize.js";
import { stripInvisible } from "../../lib/text.js";
import { getDetails, getSeasonEpisodes, searchMovie, searchMulti, searchTv, throttleTmdb, type TmdbDetails, type TmdbEpisode, type TmdbSearchResult } from "../tmdb.js";
import { normalizeTitle } from "./parse-name.js";
import type { DirectSpec } from "./rules.js";
import type { Unit } from "./units.js";

/* ------------------------------- TMDB 客户端（带缓存） ------------------------------- */

export interface TmdbApi {
  search(query: string, kind: OrganizeMediaType | "multi", year?: string): Promise<TmdbSearchResult[]>;
  details(kind: OrganizeMediaType, id: number): Promise<TmdbDetails | null>;
  season(tvId: number, season: number): Promise<TmdbEpisode[]>;
}

const SEARCH_TTL = 24 * 3600;
const DETAILS_TTL = 7 * 24 * 3600;
const SEASON_TTL = 24 * 3600;

/** 清空过几次：活得久的客户端（收藏夹那个单例）看到它变了，就把自己的进程内 memo 丢掉 */
let generation = 0;

/**
 * 设置页「清空 TMDB 缓存」：库里的行整个删掉，各客户端的进程内 memo 一并作废。
 * TMDB 上改了译名 / 海报，不用等详情那 7 天过期。返回删掉的行数
 */
export function purgeTmdbCache(): number {
  generation += 1;
  return clearTmdbCache();
}

export interface TmdbClientOptions {
  /**
   * 刷新 TMDB 信息：详情和季集跳过库里已有的值、直接问 TMDB（拉到的照常写回；同一个客户端里 memo 照用，
   * 一部剧的几个季目录只拉一次）。搜索不受影响：目录名是按旧名起的，旧名反而更容易对上
   */
  fresh?: boolean;
}

export class TmdbClient implements TmdbApi {
  private readonly memo = new Map<string, unknown>();
  private seen = generation;
  private readonly fresh: boolean;

  constructor(
    private readonly apiKey: string,
    private readonly language: string,
    opts: TmdbClientOptions = {},
  ) {
    this.fresh = opts.fresh === true;
  }

  /** skipStore：不看库里的（memo 还是看：同一个客户端里拉过的就是新的） */
  private async cached<T>(key: string, ttl: number, fetcher: () => Promise<T>, skipStore = false): Promise<T> {
    if (this.seen !== generation) {
      this.memo.clear();
      this.seen = generation;
    }
    const k = `${key}:${this.language}`;
    if (this.memo.has(k)) return this.memo.get(k) as T;
    const hit = skipStore ? null : readTmdbCache<T>(k, ttl);
    if (hit !== null) {
      this.memo.set(k, hit);
      return hit;
    }
    await throttleTmdb();
    const value = await fetcher();
    this.memo.set(k, value);
    writeTmdbCache(k, value);
    return value;
  }

  search(query: string, kind: OrganizeMediaType | "multi", year?: string): Promise<TmdbSearchResult[]> {
    const q = query.trim();
    if (!q) return Promise.resolve([]);
    // 键里带版本：搜索结果的缓存形状变过（2026-09-11 加了 originalTitle，2026-09-29 加了 popularity），旧条目让它自然过期
    const key = `search:v3:${kind}:${q.toLowerCase()}:${year ?? ""}`;
    return this.cached(key, SEARCH_TTL, () => {
      if (kind === "movie") return searchMovie(this.apiKey, q, year, this.language);
      if (kind === "tv") return searchTv(this.apiKey, q, year, this.language);
      return searchMulti(this.apiKey, q, this.language);
    });
  }

  details(kind: OrganizeMediaType, id: number): Promise<TmdbDetails | null> {
    return this.cached(`details:${kind}:${id}`, DETAILS_TTL, () => getDetails(this.apiKey, kind, id, this.language), this.fresh);
  }

  season(tvId: number, season: number): Promise<TmdbEpisode[]> {
    return this.cached(`season:${tvId}:${season}`, SEASON_TTL, () => getSeasonEpisodes(this.apiKey, tvId, season, this.language), this.fresh);
  }
}

/* ------------------------------- 打分 ------------------------------- */

interface Scored {
  item: TmdbSearchResult;
  score: number;
  titleEqual: boolean;
  /** 只对上了冒号前的主标题（整个标题、原名都没对上） */
  mainOnly: boolean;
  yearEqual: boolean;
  /** 对上的是第几个标题候选（越靠前越具体）；没对上是候选个数 */
  titleIndex: number;
  /** 对上的那个候选（归一化过的） */
  matched: string;
}

/** 冒号前的主标题：「碟中谍5：神秘国度」→ 碟中谍5（中文续集常这么起名，文件名里多半只写主标题） */
const mainTitleOf = (t: string): string => t.split(/[：:]/)[0];

function scoreCandidate(item: TmdbSearchResult, titles: string[], year: string | undefined, kindHint: Unit["kindHint"]): Scored {
  const norm = titles.map(normalizeTitle);
  // 搜索结果的 title 是本地化的（zh-CN 下是译名），文件名里多半是原名：两个都对
  const full = [item.title, item.originalTitle ?? ""].map(normalizeTitle).filter(Boolean);
  // 主标题只拿第一个候选对：后面补的首尾词常是演员名、系列名，「李小龙」会对上《李小龙：遗失的访谈》、「蝙蝠侠」对上《蝙蝠侠：漫长的万圣节》
  const main = [item.title, item.originalTitle ?? ""].map((t) => normalizeTitle(mainTitleOf(t))).filter(Boolean);
  const hits = new Set<string>();
  let hit = -1;
  let fullHit = false;
  norm.forEach((t, i) => {
    const isFull = t !== "" && full.includes(t);
    if (!isFull && !(i === 0 && t !== "" && main.includes(t))) return;
    hits.add(t);
    if (hit === -1) hit = i;
    if (isFull) fullHit = true;
  });
  const titleEqual = hit !== -1;
  let score = 0;
  if (titleEqual) score += 3;
  else if (norm.some((t) => t.length >= 2 && full.some((it) => it.includes(t) || t.includes(it)))) score += 1;
  // 中文名、英文名（不同的候选）都对上同一部：几乎不会错，压得过年份差一年（跨年上映：「撞车 2004」↔ 2005，「爱我 2024」↔ 2025，
  // 同名同年的冷门片只对上英文名）
  if (hits.size >= 2) score += 2;
  let yearEqual = false;
  if (year && item.year) {
    const d = Math.abs(Number(year) - Number(item.year));
    if (d === 0) {
      score += 2;
      yearEqual = true;
    } else if (d === 1) score += 1;
    else score -= 1;
  }
  if (kindHint !== "unknown" && item.mediaType === kindHint) score += 1;
  return { item, score, titleEqual, mainOnly: titleEqual && !fullHit, yearEqual, titleIndex: hit === -1 ? norm.length : hit, matched: hit === -1 ? "" : norm[hit] };
}

/**
 * 同分的先后：只对上主标题的让给整个标题对上的（《龙之家族：幕后特辑》让给原名就叫 House of the Dragon 的那部），
 * 除非它对上的候选更具体（「碟中谍5」对《碟中谍5：神秘国度》，另一部只对上「碟中谍」）；再按对上的候选先后
 */
function tieOrder(a: Scored, b: Scored): number {
  if (a.titleEqual && b.titleEqual && a.mainOnly !== b.mainOnly) {
    const [main, other] = a.mainOnly ? [a, b] : [b, a];
    const mainFirst = main.matched !== other.matched && main.matched.includes(other.matched);
    return (main === a) === mainFirst ? -1 : 1;
  }
  return a.titleIndex - b.titleIndex;
}

/**
 * 领先不到一分的里面，有标题一样对得上而且热门得多（比排在它前面的都热门 5 倍以上）的：换成它。
 * 同名的冷门短片、纪录片常常年份更「准」（影展年 / 上映年差一年），分数就压过了真正那部（还可能不止一部）。
 * 对上的候选没第一名的具体时不换：「碟中谍5」对上的第五部不让给只对上「碟中谍」的第一部
 */
function preferPopular(scored: Scored[]): void {
  const top = scored[0];
  if (!top) return;
  const pop = (s: Scored) => s.item.popularity ?? 0;
  let best = -1;
  for (let i = 1; i < scored.length && scored[i].score >= top.score - 1; i++) {
    const s = scored[i];
    if (s.titleEqual && s.titleIndex <= top.titleIndex && (best === -1 || pop(s) > pop(scored[best]))) best = i;
  }
  if (best === -1 || pop(scored[best]) < 5 * Math.max(0.5, ...scored.slice(0, best).map(pop))) return;
  scored.unshift(...scored.splice(best, 1));
}

function toCandidate(s: Scored): OrganizeCandidate {
  return {
    tmdbId: s.item.id,
    mediaType: s.item.mediaType === "movie" ? "movie" : "tv",
    title: s.item.title,
    year: s.item.year,
    posterUrl: s.item.posterUrl,
    overview: s.item.overview,
    score: s.score,
  };
}

/* ------------------------------- 识别 ------------------------------- */

const RE_ID_TAG = /[[{]\s*(tmdbid|tmdb)\s*[=-]\s*(\d+)\s*[\]}]/i;

/** 目录名里已经写了 id 标签（Emby `[tmdbid=1]`、Jellyfin `[tmdbid-1]`、Plex `{tmdb-1}`）：最硬的证据 */
export function idTagFromName(name: string, kindHint: Unit["kindHint"]): KnownId | null {
  const m = RE_ID_TAG.exec(stripInvisible(name));
  if (!m) return null;
  return { tmdbId: Number(m[2]), mediaType: kindHint === "movie" ? "movie" : "tv", source: "目录名里的 tmdbid 标签" };
}

/** 一条 tmdbid 证据：目录名 id 标签 / 本地 nfo / 影库条目 / 手动指定 */
export interface KnownId {
  tmdbId: number;
  mediaType: OrganizeMediaType;
  source: string;
  /** 证据自己写的作品标题（nfo 的 title / originaltitle / showtitle）：TMDB 详情的译名 / 原名 / 别名都对不上就不用 */
  titles?: string[];
  /** 没写标题时拿单元的标题核对（分集 nfo 里的 <tmdbid> 不一定是剧的） */
  strict?: boolean;
}

export interface IdEvidence {
  direct?: DirectSpec;
  /** 追更给的提示（这条追更上次整理同一个目录的结果，见 hints.ts）：识别词直指之后、记忆之前 */
  follow?: { tmdbId: number; mediaType: OrganizeMediaType; source: string } | null;
  memory?: OrganizeMatchMemory | null;
  /** 目录名 id 标签 / 本地 nfo / 影库条目里的 tmdbid：按顺序试，第一条核对得上的用 */
  known?: KnownId | Array<KnownId | null> | null;
}

export interface IdentifyOptions {
  unit: Unit;
  evidence: IdEvidence;
  libraryType?: "movie" | "tv" | "mixed";
  /** 拉季集标题（开了集标题才要） */
  episodeTitles: boolean;
  /** 搜前几个标题候选（默认 3）：影库补了中文候选，要多搜两个才轮得到文件名里的英文 */
  maxTitles?: number;
  /** 标题一样还要年份对上才停止往后搜（影库：候选里有演员名、品牌前缀这种可能撞上同名条目的） */
  strictStop?: boolean;
}

export interface IdentifyResult {
  match: OrganizeMatch | null;
  /** `season:episode` → 集标题 */
  episodeTitles: Map<string, string>;
  /** 识别过程里要告诉用户的（nfo 的 id 对不上没采用之类） */
  notes: string[];
}

async function fromDetails(tmdb: TmdbApi, kind: OrganizeMediaType, id: number, confidence: OrganizeConfidence, reason: string, candidates: OrganizeCandidate[] = []): Promise<OrganizeMatch | null> {
  const d = await tmdb.details(kind, id);
  if (!d) return null;
  return {
    mediaType: kind,
    tmdbId: d.id,
    title: d.title || d.originalTitle,
    originalTitle: d.originalTitle,
    enTitle: d.enTitle,
    year: d.year,
    posterUrl: d.posterUrl,
    imdbId: d.imdbId || undefined,
    confidence,
    reason,
    genreIds: d.genreIds,
    countries: d.countries,
    originalLanguage: d.originalLanguage,
    seasons: d.seasons,
    candidates,
  };
}

/**
 * 按候选标题依次搜（最多 max 个）；带年份先搜，没结果再不带；搜到标题一样的就停。
 * strictStop：还要年份也对上（结果没年份的不算）才停——候选里混着演员名、品牌前缀时，同名的纪录片别把后面真正的片名挡掉
 */
async function searchAll(
  tmdb: TmdbApi,
  titles: string[],
  year: string | undefined,
  kind: OrganizeMediaType | "multi",
  max = 3,
  strictStop = false,
): Promise<TmdbSearchResult[]> {
  const seen = new Set<string>();
  const out: TmdbSearchResult[] = [];
  const add = (list: TmdbSearchResult[]) => {
    for (const r of list) {
      const k = `${r.mediaType}:${r.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  };
  for (const t of titles.slice(0, max)) {
    if (year && kind !== "multi") add(await tmdb.search(t, kind, year));
    if (out.length === 0 || !year) add(await tmdb.search(t, kind));
    // 年份要完全对上：差一年的（跨年上映）接着搜，打分时中文名英文名都对上的、热门得多的会把它挑回来（见 scoreCandidate、preferPopular）
    const yearOk = (r: TmdbSearchResult) => !strictStop || !year || r.year === year;
    if (out.some((r) => normalizeTitle(r.title) === normalizeTitle(t) && yearOk(r))) break;
  }
  return out.filter((r) => r.mediaType === "movie" || r.mediaType === "tv");
}

export async function identifyUnit(opts: IdentifyOptions, tmdb: TmdbApi): Promise<IdentifyResult> {
  const { unit, evidence } = opts;
  const episodeTitles = new Map<string, string>();
  const notes: string[] = [];
  let match: OrganizeMatch | null = null;

  const direct = evidence.direct ?? unit.direct;
  if (direct) {
    const kind = direct.mediaType ?? (unit.kindHint === "movie" ? "movie" : "tv");
    match = await fromDetails(tmdb, kind, direct.tmdbId, "high", "识别词直接指定");
  }
  if (!match && evidence.follow) {
    match = await fromDetails(tmdb, evidence.follow.mediaType, evidence.follow.tmdbId, "high", `沿用${evidence.follow.source}`);
  }
  if (!match && evidence.memory) {
    match = await fromDetails(tmdb, evidence.memory.mediaType, evidence.memory.tmdbId, "high", "上次确认过的识别结果");
  }
  for (const k of Array.isArray(evidence.known) ? evidence.known : [evidence.known]) {
    if (match) break;
    if (!k) continue;
    // 本地 nfo 多半是上传者的刮削器写的：写了标题（没写就用单元的标题）就和 TMDB 详情核对，对不上说明 id 串了（演员 / 分集的）或者刮削器认错了
    const claims = k.titles?.length ? k.titles : k.strict ? unit.parsed.titles : [];
    if (claims.length > 0) {
      const d = await tmdb.details(k.mediaType, k.tmdbId);
      if (!d) {
        notes.push(`${k.source}（${k.tmdbId}）在 TMDB 上找不到，没采用`);
        continue;
      }
      const names = new Set([d.title, d.originalTitle, d.enTitle ?? "", ...d.aliases].map(normalizeTitle).filter(Boolean));
      if (!claims.some((t) => names.has(normalizeTitle(t)))) {
        notes.push(`${k.source}（${k.tmdbId}）在 TMDB 上是「${d.title || d.originalTitle}」，和${k.titles?.length ? " nfo 里写的标题" : "目录名"}对不上，没采用`);
        continue;
      }
    }
    match = await fromDetails(tmdb, k.mediaType, k.tmdbId, "high", k.source);
    if (!match) notes.push(`${k.source}（${k.tmdbId}）在 TMDB 上找不到，没采用`);
  }

  if (!match) {
    const titles = unit.parsed.titles.length > 0 ? unit.parsed.titles : unit.parsed.title ? [unit.parsed.title] : [];
    if (titles.length === 0) return { match: null, episodeTitles, notes };
    const year = unit.parsed.year;
    const kindHint: Unit["kindHint"] = unit.kindHint !== "unknown" ? unit.kindHint : opts.libraryType && opts.libraryType !== "mixed" ? opts.libraryType : "unknown";
    const searchKind: OrganizeMediaType | "multi" = kindHint === "unknown" ? "multi" : kindHint;
    const max = opts.maxTitles ?? 3;
    const strict = opts.strictStop === true;
    let results = await searchAll(tmdb, titles, year, searchKind, max, strict);
    // 剧集库里搜不到就放宽到 multi（电影 / 剧集分错了的情况）
    if (results.length === 0 && searchKind !== "multi") results = await searchAll(tmdb, titles, year, "multi", max, strict);
    if (results.length === 0) {
      // 最后一搏：去掉最后一个词再搜（标题尾巴带了没认出的噪音）
      const tokens = titles[0].split(/\s+/);
      if (tokens.length > 2) results = await searchAll(tmdb, [tokens.slice(0, -1).join(" ")], year, "multi");
    }
    if (results.length === 0) return { match: null, episodeTitles, notes };

    // 同分的见 tieOrder；再同就按 TMDB 给的顺序
    const scored = results.map((r) => scoreCandidate(r, titles, year, kindHint)).sort((a, b) => b.score - a.score || tieOrder(a, b));
    preferPopular(scored);
    const kindOf = (s: Scored): OrganizeMediaType => (s.item.mediaType === "movie" ? "movie" : "tv");
    let pick = scored[0];
    const second = scored[1];
    let confidence: OrganizeConfidence = "low";
    let reason = "只是搜索结果里最像的";
    if (pick.titleEqual && pick.yearEqual) {
      confidence = "high";
      reason = "标题和年份都对上";
    } else if (pick.titleEqual && (!year || !pick.item.year || Math.abs(Number(year) - Number(pick.item.year)) === 1)) {
      confidence = "medium";
      reason = year ? "标题对上，年份差一年" : "标题对上，文件名里没有年份";
    } else if (!second || pick.score - second.score >= 3) {
      confidence = pick.titleEqual ? "medium" : "low";
      reason = pick.titleEqual ? "标题对上，年份对不上" : "搜索结果里明显领先";
    }
    if (!pick.titleEqual || pick.mainOnly) {
      // 标题和原名都没对上（文件名用的是别的语言的译名）：拿前五名的详情看别名，谁的别名命中就选谁；详情有缓存，不多花请求。
      // 只对上主标题的（「龙之家族」对上《龙之家族：幕后特辑》）也看一眼：别的没对上标题的，别名整个是第一个候选（《权力的游戏前传：龙族》
      // 在台湾叫龙之家族）更可信；标题对上了的已经比过（热度、具体程度）不再翻出来
      const norm = pick.mainOnly ? titles.slice(0, pick.titleIndex + 1).map(normalizeTitle) : titles.map(normalizeTitle);
      for (const s of scored.slice(0, 5)) {
        if (pick.mainOnly && s.titleEqual) continue;
        const d = await tmdb.details(kindOf(s), s.item.id);
        if (!d) continue;
        const aliases = [d.title, d.originalTitle, d.enTitle ?? "", ...d.aliases].map(normalizeTitle);
        if (!norm.some((t) => aliases.includes(t)) || (year && year !== d.year)) continue;
        pick = s;
        confidence = year ? "high" : "medium";
        reason = year ? "别名和年份都对上" : "别名对上，文件名里没有年份";
        break;
      }
    }
    match = await fromDetails(tmdb, kindOf(pick), pick.item.id, confidence, reason, scored.slice(0, 8).map(toCandidate));
  }

  if (match && match.mediaType === "tv" && opts.episodeTitles) {
    const seasonsNeeded = new Set<number>();
    for (const f of unit.files) {
      if (f.kind !== "video") continue;
      const s = f.parsed.season ?? f.seasonFromDir ?? unit.parsed.season ?? 1;
      seasonsNeeded.add(s);
    }
    for (const s of seasonsNeeded) {
      try {
        for (const e of await tmdb.season(match.tmdbId, s)) if (e.name) episodeTitles.set(`${s}:${e.episode}`, e.name);
      } catch {
        /* 集标题只是锦上添花，拉不到就不写 */
      }
    }
  }
  return { match, episodeTitles, notes };
}
