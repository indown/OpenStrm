/**
 * 把范围里的文件分成「作品单元」：一部电影 / 一部剧（含所有季）是一个单元。纯函数。
 *
 *   - 直接含视频文件的目录是候选；目录名是 Season 1 / S01 / 第一季 / Specials 时单元根是上一级；
 *     范围直接选在季目录上时也一样（单元根越过范围到剧目录，文件还是只有范围里的）；
 *     花絮目录（extras / featurettes / 花絮）里的文件归上一级，标 inExtrasDir。
 *   - 一个候选目录里的视频解析出多个不同标题（电影堆、散集堆）就按标题 + 年份拆成多个单元。
 *   - 单元级标题以目录名为准（目录名通常是干净的「剧名 + 年份」），目录名解析不出标题再用文件名里最常见的。
 *   - 识别词先套在每个名字上；直指 tmdbid 的规则命中就带在单元上。
 *   - 标题末尾不补零的数字（`某剧10`）在季目录里、或同名的兄弟已经有集数时当集数；整个标题就是数字的（`129 4K.mp4`）
 *     在季目录里、或上级就是这部作品的目录时当集数（`promoteEpisodeNumbers`）。
 */
import type { MediaProbeTags, OrganizeFileKind } from "@openstrm/shared";
import { stripInvisible } from "../../lib/text.js";
import { isArtDirName, isEditionOnlyName, isExtrasDirName, normalizeTitle, numericTitle, parseMediaName, seasonDirNumber, trailingNumber, type ParsedName, type TrailingNumber } from "./parse-name.js";
import { applyRules, type DirectSpec, type ParsedRule } from "./rules.js";

/** 范围里的一项，路径相对任务 originPath，不带前导 / */
export interface ScopeEntry {
  path: string;
  isDir: boolean;
  id?: string;
  size?: number;
}

export interface UnitFile {
  path: string;
  name: string;
  stem: string;
  /** 小写、带点 */
  ext: string;
  kind: OrganizeFileKind;
  parsed: ParsedName;
  id?: string;
  size?: number;
  /** 所在季目录的季号（Season 02 → 2，Specials → 0）；不在季目录里就没有 */
  seasonFromDir?: number;
  inExtrasDir: boolean;
  /** 艺术图目录（extrafanart / extrathumbs / .actors）里的文件：这个目录的名字，整理时整个跟进作品目录 */
  artDir?: string;
  /** 识别词直指 */
  direct?: DirectSpec;
  /** 探测出来的标签（缓存里有、或这次预览里探过）：文件名里没有对应标签时模板回退用 */
  probe?: MediaProbeTags;
}

export interface Unit {
  key: string;
  /** 单元根目录，相对任务 originPath；"" 是任务根 */
  rootPath: string;
  rawName: string;
  parsed: ParsedName;
  kindHint: "movie" | "tv" | "unknown";
  files: UnitFile[];
  direct?: DirectSpec;
  /** 识别词命中的是目录名（不是某个文件名）：它给的季管整个单元（见 plan.ts 的 resolveEpisode） */
  dirDirect?: DirectSpec;
  /** 多个视频都没有集数、标题又一样时的视频个数：先按同一部电影的多个版本猜，规划时 TMDB 没认成剧集才提示 */
  multiVersion?: number;
  /**
   * 单元根是这部作品自己的目录（不是任务根、不是从大目录里拆出来的；范围根的话目录名就是这部作品）：
   * 里面认不出的图片 / nfo 原名跟进作品目录
   */
  ownsDir: boolean;
}

export interface BuildUnitsOptions {
  /** 范围目录，相对任务 originPath；"" 是任务根。给了 scopes 就以 scopes 为准 */
  scopePath: string;
  /**
   * 手动选的多个范围：每个范围照单一范围的规则来（范围本身是季目录时单元根越到上一级、范围根的名字不可靠），
   * 文件按包含它的最深的那个范围算；两个季目录范围落到同一部剧会并成一个单元
   */
  scopes?: string[];
  /** 任务根目录的名字（originPath 的最后一段）：单元根落在任务根时当目录名，它本身是季目录时季号也从这来 */
  taskRootName: string;
  videoExts: Set<string>;
  rules: ParsedRule[];
  libraryType?: "movie" | "tv" | "mixed";
}

export const SUBTITLE_EXTS = new Set([".srt", ".ass", ".ssa", ".sub", ".vtt", ".sup", ".idx"]);
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tbn", ".gif"]);
export const AUDIO_EXTS = new Set([".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus", ".wma", ".aac", ".ape", ".dsf"]);

const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
};
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function fileKindOf(name: string, videoExts: Set<string>): OrganizeFileKind {
  const ext = extOf(name);
  if (!ext) return "other";
  if (SUBTITLE_EXTS.has(ext)) return "subtitle";
  if (ext === ".nfo") return "nfo";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "other";
  if (videoExts.has(ext)) return "video";
  return "other";
}

/** 名字先去掉看不见的字符、过识别词，再解析 */
function parseWithRules(name: string, rules: ParsedRule[], subtitle = false): { parsed: ParsedName; direct?: DirectSpec } {
  const r = applyRules(stripInvisible(name), rules);
  const parsed = parseMediaName(r.name, { subtitle });
  return { parsed, direct: r.direct };
}

/** 文件名里的片名（套识别词、归一过，去掉空的）：和分单元时的解析一个口径，追更记整理结果、核对提示时用 */
export function titlesOfName(name: string, rules: ParsedRule[]): string[] {
  const ext = extOf(name);
  return parseWithRules(ext ? name.slice(0, -ext.length) : name, rules).parsed.titles.map(normalizeTitle).filter(Boolean);
}

/**
 * 从文件所在目录往上找单元根：季目录 / 花絮目录 / 艺术图目录归上一级，最多走到 boundary
 * （范围目录；范围本身是季目录时是它的上一级，见 buildUnits）
 */
function unitRootFor(dir: string, boundary: string, taskRootName: string): { root: string; seasonFromDir?: number; inExtrasDir: boolean; artDir?: string } {
  let cur = dir;
  let seasonFromDir: number | undefined;
  let inExtrasDir = false;
  let artDir: string | undefined;
  for (let hops = 0; hops < 3 && cur !== boundary && cur.length >= boundary.length; hops++) {
    const name = baseOf(cur);
    if (isArtDirName(name)) {
      artDir ??= name;
      cur = dirOf(cur);
      continue;
    }
    if (isExtrasDirName(name)) {
      inExtrasDir = true;
      cur = dirOf(cur);
      continue;
    }
    const season = seasonDirNumber(name);
    if (season !== null) {
      seasonFromDir ??= season;
      cur = dirOf(cur);
      continue;
    }
    break;
  }
  // 往上不能越出边界
  if (cur.length < boundary.length) cur = boundary;
  // 任务根本身就是季目录（任务直接建在 `某剧/Season 2` 上）：上不去了，季号照样认
  if (cur === "" && seasonFromDir === undefined) seasonFromDir = seasonDirNumber(taskRootName) ?? undefined;
  return { root: cur, seasonFromDir, inExtrasDir, artDir };
}

function titleKey(p: ParsedName): string {
  return `${p.title.toLowerCase()}|${p.year ?? ""}`;
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

const hasEpisodeMarker = (p: ParsedName): boolean =>
  p.episode !== undefined || p.absolute !== undefined || p.season !== undefined || !!p.isSpecial || !!p.date;
const hasEpisodeNumber = (p: ParsedName): boolean => p.episode !== undefined || p.absolute !== undefined || !!p.isSpecial || !!p.date;

/** 作品单元的上下文：这个目录的名字能不能当标题（任务根、名字是年份的不给），和任务的库类型 */
interface PromoteContext {
  /** 上级目录解析出来的标题；这个目录的名字不能当标题时不给 */
  dirTitle?: string;
  libraryType: BuildUnitsOptions["libraryType"];
}

/**
 * 标题末尾的数字当集数：`我和僵尸有个约会01 … 33`（01–09 解析时已认出，10 以后单看名字不敢定）、`某剧1 … 某剧30`。
 * 看同一个单元根下的上下文：文件在季目录里；或者去掉数字后和已经有集数的兄弟同名；或者剧集库里有两个以上这样的同名兄弟。
 * 电影系列（`叶问1 … 叶问4`）三样都不沾，照旧当标题按作品拆开
 */
function promoteTrailingEpisodes(files: UnitFile[], libraryType: BuildUnitsOptions["libraryType"]): void {
  const pending: Array<{ file: UnitFile; t: TrailingNumber; key: string }> = [];
  for (const file of files) {
    if ((file.kind !== "video" && file.kind !== "subtitle") || file.inExtrasDir || file.parsed.isExtra || hasEpisodeNumber(file.parsed)) continue;
    const t = trailingNumber(file.parsed);
    if (t) pending.push({ file, t, key: normalizeTitle(t.titles[0]) });
  }
  if (pending.length === 0) return;
  const numbered = new Set(files.filter((f) => f.kind === "video" && hasEpisodeNumber(f.parsed)).map((f) => normalizeTitle(f.parsed.title)));
  const siblings = new Map<string, number>();
  for (const p of pending) if (p.file.kind === "video") siblings.set(p.key, (siblings.get(p.key) ?? 0) + 1);
  for (const { file, t, key } of pending) {
    const episodic = file.seasonFromDir !== undefined || numbered.has(key) || (libraryType === "tv" && (siblings.get(key) ?? 0) >= 2);
    if (episodic) file.parsed = { ...file.parsed, title: t.titles[0], titles: t.titles, absolute: t.number, cutoff: "episode" };
  }
}

/**
 * 整个标题就是数字的当集数：`遮天/129 4K.mp4`——文件名只有集数，片名在目录名上。数字后面没有别的词时解析就认了（`129.mp4`），
 * 粘着画质 / 来源这些技术词的到这里按上下文定：文件在季目录里，或者上级目录的名字能当标题、又不是这个数字本身
 * （`1917 (2019)/1917 4K.mkv` 是电影，不动）。电影库不给。
 */
function promoteNumericTitles(files: UnitFile[], ctx: PromoteContext): void {
  for (const file of files) {
    if ((file.kind !== "video" && file.kind !== "subtitle") || file.inExtrasDir || file.parsed.isExtra) continue;
    const n = numericTitle(file.parsed);
    if (n === null) continue;
    const ownWork = !!ctx.dirTitle && ctx.libraryType !== "movie" && normalizeTitle(ctx.dirTitle) !== normalizeTitle(file.parsed.title);
    if (file.seasonFromDir !== undefined || ownWork) file.parsed = { ...file.parsed, title: "", titles: [], absolute: n, cutoff: "episode" };
  }
}

/** 名字里的数字到底是不是集数，要看同一个目录里的上下文，解析阶段定不了：见上面两个 */
function promoteEpisodeNumbers(files: UnitFile[], ctx: PromoteContext): void {
  promoteNumericTitles(files, ctx);
  promoteTrailingEpisodes(files, ctx.libraryType);
}

type RootedFile = { file: UnitFile; root: string };

export function buildUnits(entries: ScopeEntry[], opts: BuildUnitsOptions): Unit[] {
  const scopes = (opts.scopes?.length ? opts.scopes : [opts.scopePath]).map((s) => s.replace(/^\/+|\/+$/g, ""));
  const scopeRoots = new Set(scopes);
  // 文件所在的范围：包含它的最深的那个
  const scopeOf = (p: string) => scopes.filter((s) => s === "" || p === s || p.startsWith(`${s}/`)).sort((a, b) => b.length - a.length)[0] ?? "";
  // 范围直接选在季目录上（`某剧/Season 2`）：和平时一样季目录归上一级——单元根越过范围到剧目录（标题、id 标签、记忆都按剧目录认），
  // 文件还是只有范围里的
  const boundaryOf = (scope: string) => (scope && seasonDirNumber(baseOf(scope)) !== null ? dirOf(scope) : scope);
  const rooted: RootedFile[] = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const name = baseOf(e.path);
    const ext = extOf(name);
    if (ext === ".part" || ext === ".tmp" || ext === ".aria2" || name.startsWith(".")) continue;
    const kind = fileKindOf(name, opts.videoExts);
    const stem = ext ? name.slice(0, -ext.length) : name;
    const { parsed, direct } = parseWithRules(stem, opts.rules, kind === "subtitle");
    // sample 当花絮：不参与认作品 / 排集数，整理时和花絮一个去向。丢掉的话预览里看不到它，旧目录也因为它删不掉
    if (parsed.isSample) parsed.isExtra = true;
    const { root, seasonFromDir, inExtrasDir, artDir } = unitRootFor(dirOf(e.path), boundaryOf(scopeOf(e.path)), opts.taskRootName);
    rooted.push({ root, file: { path: e.path, name, stem, ext, kind, parsed, id: e.id, size: e.size, seasonFromDir, inExtrasDir, artDir, direct } });
  }

  // 按候选根分组
  const byRoot = new Map<string, UnitFile[]>();
  for (const { root, file } of rooted) {
    const list = byRoot.get(root) ?? [];
    list.push(file);
    byRoot.set(root, list);
  }

  const units: Unit[] = [];
  for (const [root, list] of byRoot) {
    const rootName = root ? baseOf(root) : opts.taskRootName;
    const rootParsed = parseWithRules(rootName, opts.rules);
    // 目录名能不能当片名：空的、只是年份、只是个版本词（`导演剪辑版`——真有一部电影叫这名字）都不行
    const dirTitleOk = rootParsed.parsed.title.length > 0 && !/^(19|20)\d{2}$/.test(rootParsed.parsed.title) && !isEditionOnlyName(rootName);
    // 任务根的名字（`tv`、`media`）不是作品名，纯数字文件名在那里不当集数
    promoteEpisodeNumbers(list, { dirTitle: dirTitleOk && root ? rootParsed.parsed.title : undefined, libraryType: opts.libraryType });
    const videos = list.filter((f) => f.kind === "video" && !f.inExtrasDir && !f.parsed.isExtra);
    if (videos.length === 0) continue; // 只有字幕 / 图片的目录不成单元

    // 目录里视频的标题分布：目录名能当标题、且文件标题一致（或文件根本没标题）→ 一个单元；否则按文件标题拆
    const keys = videos.map((v) => titleKey(v.parsed));
    const distinct = new Set(keys.filter((k) => !k.startsWith("|")));
    const common = mostCommon(keys.filter((k) => !k.startsWith("|")));
    const commonShare = common ? keys.filter((k) => k === common).length / videos.length : 0;
    const anyMarker = videos.some((v) => hasEpisodeMarker(v.parsed) || v.seasonFromDir !== undefined);
    // 范围目录本身（任务根 / 用户选的那一层）名字不可靠（tv、movie、inbox…），散在里面的文件只看文件标题：
    // 标题一致才算一个作品，否则按标题拆开；里面的目录名可靠时，有集标记或多数文件同名就当一个作品
    const atScopeRoot = scopeRoots.has(root);
    const single = atScopeRoot ? distinct.size <= 1 : dirTitleOk ? distinct.size <= 1 || commonShare >= 0.6 || anyMarker : distinct.size <= 1;

    if (single) {
      const fileParsed = videos.find((v) => titleKey(v.parsed) === common)?.parsed ?? videos[0].parsed;
      // 范围根用文件的标题；任务根（""）的名字是任务目录名，文件没标题也不能拿它去搜；用户选的那一层文件没标题时才退回目录名
      const useFiles = !dirTitleOk || root === "" || (atScopeRoot && !!common);
      const parsed: ParsedName = useFiles ? { ...fileParsed } : { ...rootParsed.parsed };
      // 范围直接选在「某剧 第二季」上、文件名又带片名：标题用文件的，文件没写季就用目录名里的季（不然规划成第 1 季）
      if (useFiles && root !== "" && dirTitleOk && parsed.season === undefined && rootParsed.parsed.season !== undefined) parsed.season = rootParsed.parsed.season;
      // 另一边的标题也留作搜索候选（目录叫「怒呛人生」、文件叫 BEEF，两个都该试）
      const extra = (useFiles ? (dirTitleOk ? rootParsed.parsed.titles : []) : fileParsed.titles).filter((t) => t && !parsed.titles.includes(t));
      parsed.titles = [...parsed.titles, ...extra];
      // 这个目录是不是这部作品自己的（里面认不出的图片 / nfo 原名跟进作品目录）：任务根不算；范围根（tv、inbox 这种）要目录名就是这部作品
      const ownsDir = root !== "" && (!atScopeRoot || (dirTitleOk && rootParsed.parsed.titles.some((t) => fileParsed.titles.some((f) => normalizeTitle(f) === normalizeTitle(t)))));
      const unit = makeUnit(root, rootName, parsed, list, rootParsed.direct, opts, ownsDir);
      if (rootParsed.direct) unit.dirDirect = rootParsed.direct;
      units.push(unit);
      continue;
    }
    // 拆：每个标题一个单元；非视频文件按同名前缀跟着视频走，跟不上的不进任何单元（原地不动）
    const groups = new Map<string, UnitFile[]>();
    for (const v of videos) {
      const k = titleKey(v.parsed);
      const g = groups.get(k) ?? [];
      g.push(v);
      groups.set(k, g);
    }
    const others = list.filter((f) => !videos.includes(f));
    for (const [k, vids] of groups) {
      const mine = others.filter((o) => vids.some((v) => o.stem.startsWith(v.stem) || titleKey(o.parsed) === k));
      const sample = vids[0];
      units.push(makeUnit(root, sample.parsed.title || rootName, sample.parsed, [...vids, ...mine], sample.direct, opts, false, `${root}|${k}`));
    }
  }

  units.sort((a, b) => a.rootPath.localeCompare(b.rootPath) || a.key.localeCompare(b.key));
  return units;
}

function makeUnit(
  root: string,
  rawName: string,
  parsed: ParsedName,
  files: UnitFile[],
  direct: DirectSpec | undefined,
  opts: BuildUnitsOptions,
  ownsDir: boolean,
  key = root || "(root)",
): Unit {
  const videos = files.filter((f) => f.kind === "video" && !f.inExtrasDir && !f.parsed.isExtra);
  let multiVersion: number | undefined;
  const fileDirect = files.map((f) => f.direct).find(Boolean);
  const anyMarker = videos.some((v) => hasEpisodeMarker(v.parsed) || v.seasonFromDir !== undefined) || parsed.season !== undefined;
  let kindHint: Unit["kindHint"] = "unknown";
  const libDirect = direct?.mediaType ?? fileDirect?.mediaType;
  if (libDirect) kindHint = libDirect;
  else if (anyMarker) kindHint = "tv";
  else if (videos.length === 1) kindHint = "movie";
  else if (videos.length > 1) {
    // 多个视频、都没有集标记：同名不同画质是多版本电影；名字各不相同又拆不开就说不清
    const stems = new Set(videos.map((v) => titleKey(v.parsed)));
    kindHint = stems.size === 1 ? "movie" : "unknown";
    if (stems.size === 1) multiVersion = videos.length;
  }
  if (kindHint === "unknown" && opts.libraryType && opts.libraryType !== "mixed") kindHint = opts.libraryType;
  // 年份：目录名没有就用文件里最常见的
  const year = parsed.year ?? mostCommon(videos.map((v) => v.parsed.year).filter((y): y is string => !!y));
  const unitParsed: ParsedName = { ...parsed, year };
  if (!unitParsed.title) {
    const t = mostCommon(videos.map((v) => v.parsed.title).filter(Boolean));
    if (t) {
      const sample = videos.find((v) => v.parsed.title === t)!;
      unitParsed.title = t;
      unitParsed.titles = sample.parsed.titles;
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { key, rootPath: root, rawName, parsed: unitParsed, kindHint, files, direct: direct ?? fileDirect, multiVersion, ownsDir };
}
