/**
 * strm 管理页 / 任务页背景用的海报：本地目录能拿到什么就用什么，尽量不碰外网。
 *
 *   ① local 目录里现成的图片：刮削器写的 poster / folder / cover，或者跟 strm 同名的那张
 *              （默认 downloadExtensions 带 .jpg/.png，图片跟着片子从网盘下过来，名字就是片名）
 *   ② tmdb  目录名里的 id 标签（整理后的默认命名就带 `[tmdbid=1]`；任务根也看它自己的名字）→ TMDB 详情缓存
 *   ③ tmdb  目录里的 tvshow.nfo / movie.nfo 给出 tmdbId → 同上
 *   ④ run   这个库整理过的记录：organize_units.match 自带海报地址
 *
 * 四级都是离线的。全试过还没有、手里又有 tmdbId 的，最后才去 TMDB 现查（没配 key 就跳过）：
 * strm 页当场查；任务页那面墙不在请求里查，放到后台补（postersAcrossTasks）。
 * 背景图是锦上添花，任何一步出错都只是这个目录没海报，不许往上抛。
 *
 * id 标签不说是剧还是电影，而 TMDB 的电影 id 和剧 id 是两套编号：猜错类型拿到的是另一部作品的海报。
 * 所以类型按目录结构猜（有季目录、或者 strm 名字带 SxxEyy 才算剧），再拿目录名里的年份核对详情，对不上就换一种。
 */
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { OrganizeMatch, OrganizeMediaType, StrmPoster, StrmPosterRef, StrmPosterResult, TaskDefinition } from "@openstrm/shared";
import { listRuns, listUnits, peekTmdbCache } from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { mapLimit } from "../../lib/async.js";
import { messageOf } from "../../lib/errors.js";
import { readTextCapped } from "../../lib/fs.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { resolveInDataDir } from "../../paths.js";
import { idTagFromName, TmdbClient } from "../organize/identify.js";
import { readNfoFacts } from "../organize/nfo.js";
import { isArtDirName, isExtrasDirName, seasonDirNumber } from "../organize/parse-name.js";
import type { TmdbDetails } from "../tmdb.js";
import { episodeKey } from "./inspect.js";
import { nestedForeignRoots, resolveManagedPath, sameRootSiblings } from "./manage.js";

const log = moduleLogger("strm-poster");

export const POSTER_LIMITS = {
  /** 一次最多解析这么多目录 */
  PATHS: 48,
  /** /api/strm/image 给图的上限。比它大的本地图当没有：占着位置、浏览器又取不到，还挡住了别的来源 */
  MAX_IMAGE_BYTES: 16 * 1024 * 1024,
  /** 找 tmdbid 读这么多字节就够 */
  NFO_BYTES: 256 * 1024,
  /** 第 ④ 级每个任务往回翻几次整理记录 */
  RUNS: 10,
} as const;

/** 能当背景图的扩展名 → Content-Type */
const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** 目录级艺术图的文件名（不带扩展名），按优先级：Emby 写 poster，Jellyfin 写 folder，刮削器还会留 cover / default */
const POSTER_STEMS = ["poster", "folder", "cover", "default"];

/**
 * 跟视频同名的图片里，只有这些后缀是竖版海报，按优先级。
 * 空串是裸的同名图（`片名.jpg`）——网盘里图片就叫这个名，跟着片子一起下过来。
 * 刻意不收 -thumb / -fanart / -landscape / -banner：那些是横版或者透明挂件，铺成海报墙会变形。
 */
const POSTER_SUFFIXES = ["-poster", "-cover", "-folder", "-keyart", ""];

/** 作品级 nfo 和它说的类型，按优先级 */
const NFO_KINDS: ReadonlyArray<readonly [string, OrganizeMediaType]> = [
  ["tvshow.nfo", "tv"],
  ["movie.nfo", "movie"],
];

/** 和 organize/identify.ts 的 TmdbClient 用同一个缓存键，两边共享一份详情缓存 */
const DETAILS_TTL = 7 * 24 * 3600;
const detailsKey = (kind: OrganizeMediaType, id: number, language: string): string => `details:${kind}:${id}:${language}`;

const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

function tmdbSettings(): { apiKey: string; language: string } {
  const settings = readAppSettings();
  return { apiKey: settings.tmdb?.apiKey?.trim() ?? "", language: settings.tmdb?.language || "zh-CN" };
}

/* ------------------------------- 库 ------------------------------- */

/**
 * 一个本地目录（任务根）。几个任务共用同一个本地目录时它们是同一个库：整理记录合在一起查，
 * 库类型只在它们说法一致时才当先验——不然谁排在任务表前面就听谁的，另一个任务的作品会被当成错的类型去查。
 */
interface Library {
  /** 用它定位路径：共用本地目录的几个任务任取一个，根是同一个 */
  task: TaskDefinition;
  taskIds: string[];
  libraryType?: OrganizeMediaType;
  /** 整理记录的索引，懒加载：一次计算里只解析一遍 */
  runs?: Map<string, OrganizeMatch>;
  /** 同上，不管有没有海报（收藏夹判断「已经有了」只要 tmdbId） */
  matches?: Map<string, OrganizeMatch>;
}

function libraryOf(task: TaskDefinition, tasks: TaskDefinition[]): Library {
  const members = [task, ...sameRootSiblings(task, tasks)];
  const types = new Set(members.map((t) => t.organize?.libraryType));
  const only = types.size === 1 ? [...types][0] : undefined;
  return { task, taskIds: members.map((t) => t.id), libraryType: only === "movie" || only === "tv" ? only : undefined };
}

/**
 * 最近几次整理记录里，按整理后的作品目录索引识别结果；新的记录先占。
 * unit.dstRoot 是相对任务 originPath 的，本地 strm 目录相对 targetPath 是同一串，可以直接对上。
 */
function runIndex(lib: Library, needPoster = true): Map<string, OrganizeMatch> {
  const hit = needPoster ? lib.runs : lib.matches;
  if (hit) return hit;
  const runs = lib.taskIds.flatMap((taskId) => listRuns({ taskId, limit: POSTER_LIMITS.RUNS }));
  runs.sort((a, b) => b.createdAt - a.createdAt);
  const out = new Map<string, OrganizeMatch>();
  for (const run of runs) {
    for (const unit of listUnits(run.id)) {
      if (!unit.dstRoot || !unit.match || (needPoster && !unit.match.posterUrl)) continue;
      if (!out.has(unit.dstRoot)) out.set(unit.dstRoot, unit.match);
    }
  }
  if (needPoster) lib.runs = out;
  else lib.matches = out;
  return out;
}

/* ------------------------------- ① 本地图片 ------------------------------- */

/**
 * 目录里能当海报的图片，两条规则：
 *
 *   1. 目录级艺术图 poster / folder / cover —— 刮削器写的，最确定；
 *   2. 跟某个 strm 同名的图。**这才是本工具自己的产物**：网盘里的图片就叫片名，
 *      跟着片子一起下过来（默认 downloadExtensions 带 .jpg/.png），整理时又跟着视频改名
 *      —— 和 organize/plan.ts 认「跟某个视频同名的附属文件」是同一条规则。
 *
 * 规则 2 里裸的同名图（`片名.jpg`）只在目录只有一个 strm 时才认。一个季目录里
 * 每集都有 `SxxExx.jpg`，那是集的剧照不是作品海报，认了会把整季的背景变成第一集的截图；
 * 带明确海报后缀的（`片名-poster.jpg`）没这个歧义，几个 strm 都认。
 */
function localPosterName(names: string[]): string | null {
  const lower = new Map<string, string>();
  for (const n of names) lower.set(n.toLowerCase(), n);

  for (const stem of POSTER_STEMS) {
    for (const ext of Object.keys(IMAGE_TYPES)) {
      const hit = lower.get(`${stem}${ext}`);
      if (hit) return hit;
    }
  }

  const strmStems = names.filter((n) => n.toLowerCase().endsWith(".strm")).map((n) => n.slice(0, -5).toLowerCase());
  const onlyOne = strmStems.length === 1;
  for (const suffix of POSTER_SUFFIXES) {
    if (suffix === "" && !onlyOne) continue;
    for (const stem of strmStems) {
      for (const ext of Object.keys(IMAGE_TYPES)) {
        const hit = lower.get(`${stem}${suffix}${ext}`);
        if (hit) return hit;
      }
    }
  }
  return null;
}

async function fileSize(full: string): Promise<number | null> {
  try {
    return (await fsp.stat(full)).size;
  } catch {
    return null;
  }
}

/* ------------------------------- ②③ tmdbId ------------------------------- */

/** 一个目录的 tmdbId 线索：目录名的 id 标签或者作品 nfo */
interface Clue {
  tmdbId: number;
  /** 按可能性排的类型；nfo 说了是哪种就只有那一种 */
  kinds: OrganizeMediaType[];
  /** 目录名里的年份：拿来核对详情，猜错类型时两边的年份多半对不上 */
  year?: string;
}

/** 目录名里括号括着的年份（`片名 (2010) [tmdbid=1]`），取最后一个；`2024 (2021)` 这种片名本身是数字的也取得对 */
function yearOfName(name: string): string | undefined {
  let year: string | undefined;
  for (const m of name.matchAll(/\((\d{4})\)/g)) year = m[1];
  return year;
}

/**
 * 有季目录（和整理用同一套规则：Season 1 / S01 / 第二季 / SP / 番外）、或者 strm 名字带 SxxEyy 的算剧，其余当电影。
 * 不能「有子目录就当剧」：@eaDir、.actors、Subs、整理挪出来的 extras 都会让电影被当成剧。
 */
function looksLikeShow(entries: Dirent[]): boolean {
  return entries.some((e) =>
    e.isDirectory() ? seasonDirNumber(e.name) !== null : e.name.toLowerCase().endsWith(".strm") && episodeKey(e.name) !== null,
  );
}

async function nfoClue(dir: string, entries: Dirent[]): Promise<Omit<Clue, "year"> | null> {
  const lower = new Map<string, string>();
  for (const e of entries) if (!e.isDirectory()) lower.set(e.name.toLowerCase(), e.name);
  for (const [want, kind] of NFO_KINDS) {
    const hit = lower.get(want);
    if (!hit) continue;
    try {
      const xml = await readTextCapped(path.join(dir, hit), POSTER_LIMITS.NFO_BYTES);
      const facts = xml ? readNfoFacts(xml) : null;
      if (facts?.tmdbId) return { tmdbId: facts.tmdbId, kinds: [kind] };
    } catch {
      /* 读不动就算了 */
    }
  }
  return null;
}

async function clueOf(lib: Library, dir: string, entries: Dirent[]): Promise<Clue | null> {
  // 用磁盘上的名字：任务根（rel 为空）的 id 标签在它自己的名字上
  const name = path.basename(dir);
  const year = yearOfName(name);
  const tag = idTagFromName(name, "tv");
  if (tag) {
    const guess = lib.libraryType ?? (looksLikeShow(entries) ? "tv" : "movie");
    return { tmdbId: tag.tmdbId, kinds: guess === "tv" ? ["tv", "movie"] : ["movie", "tv"], year };
  }
  const nfo = await nfoClue(dir, entries);
  return nfo ? { ...nfo, year } : null;
}

const yearOk = (want: string | undefined, got: string | undefined): boolean =>
  !want || !got || Math.abs(Number(want) - Number(got)) <= 1;

type CachedDetails = Pick<TmdbDetails, "posterUrl" | "title" | "year">;

const tmdbPoster = (clue: Clue, d: CachedDetails): StrmPoster => ({
  source: "tmdb",
  url: d.posterUrl,
  title: d.title,
  year: d.year,
  tmdbId: clue.tmdbId,
});

/**
 * 只查详情缓存。缓存着「没有这个 id」、有详情没海报、年份对不上（多半是另一种类型的同号作品）的，
 * 这种类型算问过了；unknownKinds 是还没问过、值得联网问的类型。
 */
function fromCache(clue: Clue, language: string): { poster?: StrmPoster; unknownKinds: OrganizeMediaType[] } {
  const unknownKinds: OrganizeMediaType[] = [];
  for (const kind of clue.kinds) {
    const hit = peekTmdbCache<CachedDetails>(detailsKey(kind, clue.tmdbId, language), DETAILS_TTL);
    if (!hit) {
      unknownKinds.push(kind);
      continue;
    }
    if (hit.value?.posterUrl && yearOk(clue.year, hit.value.year)) return { poster: tmdbPoster(clue, hit.value), unknownKinds: [] };
  }
  return { unknownKinds };
}

/**
 * 按线索去 TMDB 现查：没问过的类型挨个试，年份对不上就换下一种，每问一次扣一次 quota。
 * 结果（包括「没有」）都由 TmdbClient 写进详情缓存，下次不用再问；同一个 client 里重复的 id 只问一次。
 * failed：连不上 / 出错（不是「TMDB 说没有」）。
 */
async function fetchClue(
  client: TmdbClient,
  clue: Clue,
  kinds: OrganizeMediaType[],
  quota: { left: number },
): Promise<{ poster?: StrmPoster; failed: boolean }> {
  for (const kind of kinds) {
    if (quota.left <= 0) break;
    quota.left--;
    let details: TmdbDetails | null;
    try {
      details = await client.details(kind, clue.tmdbId);
    } catch (err) {
      log.debug(`TMDB 详情拿不到（${kind} ${clue.tmdbId}）：${messageOf(err)}`);
      return { failed: true };
    }
    if (details?.posterUrl && yearOk(clue.year, details.year)) return { poster: tmdbPoster(clue, details), failed: false };
  }
  return { failed: false };
}

/* ------------------------------- 离线解析 ------------------------------- */

interface DirResult {
  rel: string;
  /** 离线拿到的图；pending 也在时它是暂时的（整理记录的图，和 id 线索说的不是同一部） */
  poster?: StrmPoster;
  /** 有 id、离线没拿到图、还有没问过的类型：等联网 */
  pending?: { clue: Clue; kinds: OrganizeMediaType[] };
  /** 有没有任何线索（本地图 / id 标签 / nfo / 整理记录），不管最后拿没拿到图 */
  known: boolean;
}

interface OfflineOptions {
  /** 本地图超过这么大，先看别的离线来源有没有小图，都没有才用它（任务页那面墙用） */
  localMaxBytes?: number;
}

/** 这一批目录（相对任务根）各自离线能拿到什么，按传进来的顺序 */
async function resolveOffline(lib: Library, rels: string[], opts: OfflineOptions, language: string): Promise<DirResult[]> {
  return mapLimit(rels, 8, async (rel): Promise<DirResult> => {
    let dir: string;
    try {
      dir = (await resolveManagedPath(lib.task, rel)).full;
    } catch {
      return { rel, known: false }; // 路径不合法：当这个目录没有海报
    }
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return { rel, known: false };
    }

    // ① 本地图
    let big: StrmPoster | undefined;
    const local = localPosterName(entries.map((e) => e.name));
    if (local) {
      const size = await fileSize(path.join(dir, local));
      const poster: StrmPoster = { source: "local", url: joinRel(rel, local) };
      if (size !== null && size <= POSTER_LIMITS.MAX_IMAGE_BYTES) {
        if (!opts.localMaxBytes || size <= opts.localMaxBytes) return { rel, poster, known: true };
        big = poster;
      }
    }
    // 换成了别的小图：本地那张留作后备，浏览器连不上外链时前端退回去用它
    const orBig = (poster: StrmPoster): StrmPoster => (big ? { ...poster, fallback: big.url } : poster);

    // ②③ id 线索 → 详情缓存
    const clue = await clueOf(lib, dir, entries);
    let unknownKinds: OrganizeMediaType[] = [];
    if (clue) {
      const cached = fromCache(clue, language);
      if (cached.poster) return { rel, poster: orBig(cached.poster), known: true };
      unknownKinds = cached.unknownKinds;
    }
    const pending = clue && unknownKinds.length > 0 ? { clue, kinds: unknownKinds } : undefined;

    // ④ 整理记录。和 id 线索说的是同一部才算数；说的是别的作品，就先顶着，联网问到线索的图再换
    const m = runIndex(lib).get(rel);
    if (m) {
      const poster = orBig({ source: "run", url: m.posterUrl, title: m.title, year: m.year, tmdbId: m.tmdbId });
      return !clue || m.tmdbId === clue.tmdbId ? { rel, poster, known: true } : { rel, poster, pending, known: true };
    }

    // 太大的本地图：离线没有别的图，还是用它——不为了换一张小图去联网
    if (big) return { rel, poster: big, known: true };
    return { rel, pending, known: !!clue || !!local };
  });
}

/* ------------------------------- strm 页 ------------------------------- */

export interface ResolvePostersOptions {
  /** 只用离线的几级，不联网：strm 页数「多少个目录认出来了」的那几批、网格视图的第一遍用 */
  offline?: boolean;
  /**
   * 本地图太大（超过 WALL_LIMITS.LOCAL_MAX_BYTES）、离线又有外链小图的，换成小图，本地那张留作后备——和任务页那面墙同一条规矩。
   * 网格视图一屏二十几张图，刮削器存的原图一张一两 MB；背景的单张糊图不带它（铺满全屏，大图反而好）
   */
  compact?: boolean;
}

/**
 * 一批目录（相对任务根）各自的海报，以及哪些有线索、哪些还值得联网问。拿不到海报的不出现在 posters 里。
 * 超过 POSTER_LIMITS.PATHS 的部分直接丢掉——界面一屏也放不下那么多。
 */
export async function resolvePosters(task: TaskDefinition, rels: string[], opts: ResolvePostersOptions = {}): Promise<StrmPosterResult> {
  const wanted = [...new Set(rels)].slice(0, POSTER_LIMITS.PATHS);
  const lib = libraryOf(task, listTasks());
  const { apiKey, language } = tmdbSettings();
  const results = await resolveOffline(lib, wanted, opts.compact ? { localMaxBytes: WALL_LIMITS.LOCAL_MAX_BYTES } : {}, language);

  let unreachable = false;
  if (!opts.offline && apiKey) {
    const client = new TmdbClient(apiKey, language);
    const quota = { left: Number.POSITIVE_INFINITY };
    // 串行：TMDB 那边本来就是限速的
    for (const r of results) {
      if (!r.pending) continue;
      const got = await fetchClue(client, r.pending.clue, r.pending.kinds, quota);
      if (got.poster) r.poster = got.poster;
      // 连不上：别让剩下的每一个都再等一回超时
      if (got.failed) {
        unreachable = true;
        break;
      }
      // 问到了答案（有图，或者 TMDB 说没有，都记进了缓存）：不用再问
      r.pending = undefined;
    }
  }

  return {
    posters: Object.fromEntries(results.flatMap((r) => (r.poster ? [[r.rel, r.poster] as const] : []))),
    known: results.filter((r) => r.known).map((r) => r.rel),
    // 没配 key 的问了也没处问，不报
    pending: apiKey ? results.filter((r) => r.pending).map((r) => r.rel) : [],
    ...(unreachable ? { unreachable: true as const } : {}),
  };
}

/* ------------------------------- 全库（任务页背景） ------------------------------- */

export const WALL_LIMITS = {
  /** 最多给这么多张：一面墙十来列、每列三四张，再多只是重复拉图 */
  POSTERS: 48,
  /** 找作品目录一共最多读这么多个目录（所有库合计） */
  READS: 3000,
  /** 一共最多 stat 这么多个目录（排新旧要修改时间） */
  STATS: 20_000,
  /** 按修改时间排好的候选最多看这么多个，每 POSTER_LIMITS.PATHS 个一轮，凑够 POSTERS 张就停 */
  CANDIDATES: 144,
  /** 本地图超过这么大，离线有小图就换小图：任务页是落地页，一面墙四十几张，刮削器存的原图一张一两 MB */
  LOCAL_MAX_BYTES: 512 * 1024,
  /** 后台补图每一轮最多问 TMDB 这么多次 */
  NETWORK: 12,
  /** 一轮问下来全是连不上：歇这么久再补 */
  NETWORK_BACKOFF_MS: 30 * 60_000,
  /** 算好的结果留这么久；过期了先给旧的，后台重算 */
  TTL_MS: 5 * 60_000,
} as const;

/** 系统和 NAS 自己的目录：不是作品，也不会装着作品 */
const SYSTEM_DIRS = new Set(["@eadir", "#recycle", "#snapshot", "@recycle", "@recently-snapshot", "lost+found", "$recycle.bin", "system volume information"]);

/** 不进的目录：系统目录；隐藏目录媒体服务器也不扫，但名字带 id 标签的（整理出来的作品）照算 */
function isJunkDir(name: string): boolean {
  if (SYSTEM_DIRS.has(name.toLowerCase())) return true;
  return name.startsWith(".") && !idTagFromName(name, "tv");
}

/** 直接说明「这一层是一部作品」的文件：strm、作品 nfo、目录级海报 */
function isWorkFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".strm") || NFO_KINDS.some(([n]) => n === lower)) return true;
  const ext = path.extname(lower);
  return Object.hasOwn(IMAGE_TYPES, ext) && POSTER_STEMS.includes(lower.slice(0, -ext.length));
}

interface Owner {
  lib: Library;
  root: string;
  /** 嵌在这个根里面的别的任务根（相对这个根）：由它们自己的任务去走 */
  foreign: Set<string>;
}

interface WallCandidate {
  owner: Owner;
  rel: string;
  mtimeMs: number;
}

const fullOf = (root: string, rel: string): string => (rel ? path.join(root, ...rel.split("/")) : root);

async function mtimeOf(full: string): Promise<number | null> {
  try {
    return (await fsp.stat(full)).mtimeMs;
  } catch {
    return null;
  }
}

/** 几个任务共用一个本地目录的只算一个库 */
function ownersOf(tasks: TaskDefinition[]): Owner[] {
  const owners: Owner[] = [];
  const roots = new Set<string>();
  for (const task of tasks) {
    const root = resolveInDataDir(task.targetPath);
    if (!root || roots.has(root)) continue;
    roots.add(root);
    owners.push({ lib: libraryOf(task, tasks), root, foreign: new Set(nestedForeignRoots(task, tasks)) });
  }
  return owners;
}

/**
 * 所有库里的作品目录。宽度优先一层一层走，每一层按修改时间新的先读：读目录的额度（READS）用完时，
 * 丢掉的是旧的那头；几个库在同一层里一起排、共用一份额度，谁也不会被排在前面的那个饿死。
 *
 *   - 目录名带 id 标签：名字已经说明是一部作品，不用读它；
 *   - 下面有季目录：这是一部剧，季目录不用再读，剧里别的子目录（版本、没认出来的季）也算它的；
 *   - 直接放着 strm / 作品 nfo / 目录级海报：这一层是一部作品，但还要接着看它的子目录——
 *     分类目录里散放一个 strm、或者放一张合集封面的，底下的作品不能跟着丢；花絮 / 艺术图目录不看；
 *   - 其余（分类目录）接着往下；系统目录和隐藏目录不进；
 *   - 目录名自带 id 标签的任务根（只同步了一部作品）就是那一部，不再往下。
 */
async function findWorks(owners: Owner[], limits: { READS: number; STATS: number; MTIME?: boolean } = WALL_LIMITS): Promise<WallCandidate[]> {
  // 不排新旧的（收藏夹扫全部作品目录）不 stat：NAS 的机械盘上几十万次 stat 很慢
  const stamp = limits.MTIME === false ? async () => 0 : mtimeOf;
  const works = new Map<string, WallCandidate>();
  const add = (owner: Owner, rel: string, mtimeMs: number) => {
    const key = JSON.stringify([owner.root, rel]);
    if (!works.has(key)) works.set(key, { owner, rel, mtimeMs });
  };

  let stats = 0;
  let level: WallCandidate[] = [];
  for (const owner of owners) {
    stats++;
    const mtimeMs = await mtimeOf(owner.root);
    if (mtimeMs !== null) level.push({ owner, rel: "", mtimeMs });
  }

  let reads = 0;
  while (level.length > 0 && reads < limits.READS) {
    level.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const batch = level.slice(0, limits.READS - reads);
    reads += batch.length;
    const next: WallCandidate[] = [];
    await mapLimit(batch, 4, async (dir) => {
      const { owner, rel } = dir;
      if (rel === "" && idTagFromName(path.basename(owner.root), "tv")) {
        add(owner, "", dir.mtimeMs);
        return;
      }
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(fullOf(owner.root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      // 符号链接不跟：isDirectory() 对它是 false，也就不会顺着链接跑出任务目录或者绕成环
      const subdirs = entries.filter((e) => e.isDirectory() && !isJunkDir(e.name) && !owner.foreign.has(joinRel(rel, e.name)));
      if (subdirs.some((e) => seasonDirNumber(e.name) !== null)) {
        add(owner, rel, dir.mtimeMs);
        return;
      }
      const holds = entries.some((e) => !e.isDirectory() && isWorkFile(e.name));
      if (holds) add(owner, rel, dir.mtimeMs);
      const rest = holds ? subdirs.filter((e) => !isExtrasDirName(e.name) && !isArtDirName(e.name)) : subdirs;
      const picked = rest.slice(0, Math.max(0, limits.STATS - stats));
      stats += picked.length;
      const stamped = await mapLimit(picked, 16, async (e) => ({ e, mtimeMs: await stamp(fullOf(owner.root, joinRel(rel, e.name))) }));
      for (const { e, mtimeMs } of stamped) {
        if (mtimeMs === null) continue;
        const sub = joinRel(rel, e.name);
        if (idTagFromName(e.name, "tv")) add(owner, sub, mtimeMs);
        else next.push({ owner, rel: sub, mtimeMs });
      }
    });
    level = next;
  }
  return [...works.values()];
}

/* ------------------------------- 本地已有的作品（收藏夹用） ------------------------------- */

/** 本地 strm 目录里认得出是哪一部的作品目录 */
export interface LocalWork {
  taskId: string;
  /** 作品目录，相对任务的本地 strm 目录 */
  rel: string;
  mediaType: OrganizeMediaType;
  tmdbId: number;
  /** 剧：有哪几季（季目录，或者直接放着的 strm 名字里的 SxxEyy） */
  seasons: number[];
}

/** 要全，不是抽一批：读目录的额度比海报墙大得多；不排新旧，不用 stat */
export const LOCAL_WORKS_LIMITS = { READS: 20_000, STATS: 200_000, MTIME: false } as const;

/**
 * 各任务的本地目录里认得出 tmdbId 的作品目录（收藏夹判断「已经有了」）：目录名的 id 标签、作品 nfo、整理记录，
 * 都是离线的。没整理过、目录名里也没有 id 的认不出——所以「没标」不等于没有
 */
export async function scanLocalWorks(tasks: TaskDefinition[] = listTasks()): Promise<LocalWork[]> {
  const works = await findWorks(ownersOf(tasks), LOCAL_WORKS_LIMITS);
  const out: LocalWork[] = [];
  await mapLimit(works, 8, async (w) => {
    const full = fullOf(w.owner.root, w.rel);
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(full, { withFileTypes: true });
    } catch {
      return;
    }
    const clue = await clueOf(w.owner.lib, full, entries);
    const run = clue ? undefined : runIndex(w.owner.lib, false).get(w.rel);
    const tmdbId = clue?.tmdbId ?? run?.tmdbId;
    const mediaType = clue?.kinds[0] ?? run?.mediaType;
    if (!tmdbId || !mediaType) return;
    const seasons = new Set<number>();
    for (const e of entries) {
      const n = e.isDirectory() ? seasonDirNumber(e.name) : e.name.toLowerCase().endsWith(".strm") ? (episodeKey(e.name)?.season ?? null) : null;
      if (n !== null) seasons.add(n);
    }
    out.push({ taskId: w.owner.lib.task.id, rel: w.rel, mediaType, tmdbId, seasons: [...seasons].sort((a, b) => a - b) });
  });
  return out;
}

interface WallPending {
  clue: Clue;
  kinds: OrganizeMediaType[];
}

/**
 * 所有任务的本地目录里抽一批作品海报，只用离线的几级：找作品目录 → 按修改时间新的在前 →
 * 一轮 POSTER_LIMITS.PATHS 个，凑够 WALL_LIMITS.POSTERS 张或者候选看完就停。同一张图只留一次。
 * 顺带交出排得进墙、还等着联网的那些线索（新的在前），留给后台去补。
 */
async function collectAcrossTasks(tasks: TaskDefinition[]): Promise<{ posters: StrmPosterRef[]; pending: WallPending[] }> {
  const works = await findWorks(ownersOf(tasks));
  works.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
  const { language } = tmdbSettings();

  const posters: StrmPosterRef[] = [];
  const pending: WallPending[] = [];
  const seen = new Set<string>();
  const pool = works.slice(0, WALL_LIMITS.CANDIDATES);
  for (let i = 0; i < pool.length && posters.length < WALL_LIMITS.POSTERS; i += POSTER_LIMITS.PATHS) {
    const chunk = pool.slice(i, i + POSTER_LIMITS.PATHS);
    const results = new Map<WallCandidate, DirResult>();
    for (const owner of new Set(chunk.map((c) => c.owner))) {
      const mine = chunk.filter((c) => c.owner === owner);
      const got = await resolveOffline(owner.lib, mine.map((c) => c.rel), { localMaxBytes: WALL_LIMITS.LOCAL_MAX_BYTES }, language);
      mine.forEach((c, j) => results.set(c, got[j]));
    }
    for (const c of chunk) {
      const r = results.get(c);
      if (r?.pending) pending.push(r.pending);
      if (!r?.poster) continue;
      // local 的地址是相对任务根的，要带上库才唯一；外链本身就唯一
      const key = r.poster.source === "local" ? JSON.stringify([c.owner.root, r.poster.url]) : r.poster.url;
      if (seen.has(key)) continue;
      seen.add(key);
      posters.push({ ...r.poster, taskId: c.owner.lib.task.id, path: c.rel });
      if (posters.length >= WALL_LIMITS.POSTERS) break;
    }
  }
  log.debug(`全库海报：${works.length} 个作品目录，拿到 ${posters.length} 张，${pending.length} 个等联网`);
  return { posters, pending };
}

interface WallState {
  key: string;
  /** 算好的时间；还在算是 0 */
  doneAt: number;
  value: Promise<StrmPosterRef[]>;
}

let wall: WallState | null = null;
let refreshing: Promise<void> | null = null;
let warming: Promise<void> | null = null;
let backoffUntil = 0;

/** 结果取决于这些：任务（id、本地目录、库类型）和 TMDB 的语言、有没有 key */
function wallKey(tasks: TaskDefinition[]): string {
  const { apiKey, language } = tmdbSettings();
  const parts = tasks.map((t) => JSON.stringify([t.id, t.targetPath, t.organize?.libraryType ?? ""])).sort();
  return JSON.stringify([language, Boolean(apiKey), parts]);
}

async function computeWall(tasks: TaskDefinition[]): Promise<StrmPosterRef[]> {
  const { posters, pending } = await collectAcrossTasks(tasks);
  warmLater(pending);
  return posters;
}

/**
 * 任务页背景：所有任务的本地目录里抽一批作品海报，新的在前。只用离线的几级，所以不会被 TMDB 拖住；
 * 缺的在后台补（warmLater），补到了重算一遍，下一次打开就有。
 *
 * 结果在内存里留 TTL_MS（从算好的时候算）；过期了先给旧的、后台重算；任务表或者 TMDB 设置变了就当场重算。
 */
export function postersAcrossTasks(tasks: TaskDefinition[]): Promise<StrmPosterRef[]> {
  const key = wallKey(tasks);
  if (wall?.key === key) {
    if (wall.doneAt !== 0 && Date.now() - wall.doneAt >= WALL_LIMITS.TTL_MS) refreshWall();
    return wall.value;
  }
  const entry: WallState = { key, doneAt: 0, value: computeWall(tasks) };
  wall = entry;
  entry.value.then(
    () => {
      entry.doneAt = Date.now();
    },
    () => {
      // 按说不会抛（每一步都兜住了）；真抛了也别把失败留着
      if (wall === entry) wall = null;
    },
  );
  return entry.value;
}

/** 后台重算一遍（过期了、或者从 TMDB 补到了东西）：算好了再换上，算的时候照样给旧的 */
function refreshWall(): void {
  if (refreshing) return;
  const tasks = listTasks();
  const key = wallKey(tasks);
  refreshing = computeWall(tasks)
    .then((posters) => {
      wall = { key, doneAt: Date.now(), value: Promise.resolve(posters) };
    })
    .catch((err: unknown) => log.debug(`全库海报重算失败：${messageOf(err)}`))
    .finally(() => {
      refreshing = null;
    });
}

/**
 * 后台去 TMDB 补海报：墙上排得进去、有 id、缓存里又没有的，新的先问，一轮最多 NETWORK 次。
 * 问到了东西（有图，或者确认没有——都会记进缓存）就重算一遍墙；重算出来还缺就再来一轮，直到问完。
 * 一轮下来全是连不上：歇 NETWORK_BACKOFF_MS。
 */
function warmLater(pending: WallPending[]): void {
  if (warming || pending.length === 0 || Date.now() < backoffUntil) return;
  const { apiKey, language } = tmdbSettings();
  if (!apiKey) return;
  warming = (async () => {
    const client = new TmdbClient(apiKey, language);
    const quota = { left: WALL_LIMITS.NETWORK };
    const asked = new Set<string>();
    let answered = 0;
    let failed = 0;
    for (const p of pending) {
      if (quota.left <= 0) break;
      const id = JSON.stringify([p.clue.tmdbId, p.kinds]);
      if (asked.has(id)) continue;
      asked.add(id);
      const got = await fetchClue(client, p.clue, p.kinds, quota);
      if (got.failed) failed++;
      else answered++;
    }
    if (answered === 0 && failed > 0) backoffUntil = Date.now() + WALL_LIMITS.NETWORK_BACKOFF_MS;
    return answered > 0;
  })()
    .then((progress) => {
      if (progress) refreshWall();
    })
    .catch((err: unknown) => log.debug(`全库海报补图失败：${messageOf(err)}`))
    .finally(() => {
      warming = null;
    });
}

/** 仅供测试：清掉全库海报的缓存和后台状态 */
export function resetPostersAcrossTasks(): void {
  wall = null;
  refreshing = null;
  warming = null;
  backoffUntil = 0;
}

/** 仅供测试：等后台的补图和重算都停下来 */
export async function settlePostersAcrossTasks(): Promise<void> {
  while (warming || refreshing) await (warming ?? refreshing);
}

/* ------------------------------- 本地图片接口 ------------------------------- */

export interface StrmImageFile {
  full: string;
  contentType: string;
  size: number;
  mtimeMs: number;
}

/** 本地图片：只放行图片扩展名，路径照旧过 resolveManagedPath 的越界 / 符号链接检查 */
export async function statImage(task: TaskDefinition, rel: string): Promise<StrmImageFile> {
  const mp = await resolveManagedPath(task, rel, { mustExist: true });
  const contentType = IMAGE_TYPES[path.extname(mp.rel).toLowerCase()];
  if (!contentType) throw new HttpError(400, "只能读图片");
  const st = await fsp.stat(mp.full);
  if (!st.isFile()) throw new HttpError(400, `不是文件：${mp.rel}`);
  if (st.size > POSTER_LIMITS.MAX_IMAGE_BYTES) throw new HttpError(413, "图片太大");
  return { full: mp.full, contentType, size: st.size, mtimeMs: st.mtimeMs };
}
