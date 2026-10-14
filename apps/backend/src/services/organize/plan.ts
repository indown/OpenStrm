/**
 * 规划：单元 + 识别结果 + 模板 → 每个文件的目标路径和动作。纯函数，不碰网盘。
 *
 *   keep      源 == 目标，不动
 *   rename    同一父目录只改名
 *   move      跨目录（可能同时改名）
 *   mkdir     目标目录不存在
 *   rmdir     执行后腾空的源目录（可关）
 *   conflict  目标已存在且不是同一节点 / 两个源指向同一目标 / 目标落进别的任务（附属文件——字幕 / nfo / 图片 / 花絮 / 认不出类型的——撞名不算，留在原处）
 *   skip      没识别、没集数、找不到对应视频的字幕；附属文件的目标被占、或它跟着的视频没挪
 *
 * 冲突项可以选怎么办（`resolutions`）：改名保留（加区分后缀）、自己填名字、挪进任务根下的重复文件目录、
 * 删掉这一份、覆盖（删掉目标那份再挪过去）；跟着的字幕 / nfo 一起走。不选就留在原处。
 * 办法都只在真撞上的时候才用：没冲突的文件按模板算出来的名字走，选过的办法不起作用（run.ts 重新规划后会把它清掉）
 * 删除只在冲突上明确选了才有（人或智能体选，执行要人点头或者删除档），落成单独的 delete 项——执行后撤销退不回来
 *
 * 路径：输入输出都是相对任务 originPath 的路径；run.ts 落库时再拼成网盘绝对路径。
 */
import type { OrganizeAction, OrganizeConflictChoice, OrganizeConflictResolution, OrganizeFileKind, OrganizeMatch } from "@openstrm/shared";
import { DUPLICATES_DIR, duplicatePathFor } from "../strm/staging.js";
import { isNamedAfter, normalizeTitle, trailingNumber } from "./parse-name.js";
import type { ResolvedOrganizeSettings } from "./settings.js";
import { pickCategory } from "./settings.js";
import { episodeToken, idTagFor, pad2, pad3, renderTemplate, type TemplateVars } from "./template.js";
import type { Unit, UnitFile } from "./units.js";

export interface PlannedItem {
  unitKey: string;
  kind: OrganizeFileKind;
  action: OrganizeAction;
  /** 相对任务 originPath */
  srcPath: string;
  dstPath: string;
  nodeId: string;
  reason: string;
  /** 附属文件（字幕 / nfo / 图片 / 花絮 / 认不出类型的）跟着哪些视频：一个都没落到计划的位置（冲突 / 跳过）就不挪。规划期用，不落库 */
  follows?: string[];
  /** 附属文件：目标被占了就留在原处（skip），不算冲突、不卡自动整理。规划期用，不落库 */
  soft?: boolean;
  /** 给这一项选的冲突处理；撞上了才用得着。规划期用，不落库 */
  resolve?: OrganizeConflictChoice;
  /** 改名保留时依次试的目标（先按画质 / 来源这些标签区分，再 (2)(3)）。规划期用，不落库 */
  variants?: string[];
  /** 自己填名字时填的文件名（已补好扩展名）：撞上了才换成它，目录照旧是整理算出来的。规划期用，不落库 */
  customName?: string;
  /** 选的办法这一轮真用上了（撞上了、按它换了目标或标了删除）：没用上的办法 run.ts 会从单元上清掉。规划期用，不落库 */
  resolved?: boolean;
}


export interface UnitPlan {
  unitKey: string;
  /** 整理后的作品根目录（相对任务 originPath）；没匹配上为空 */
  dstRoot: string;
  items: PlannedItem[];
  notes: string[];
}

export interface UnitPlanInput {
  unit: Unit;
  match: OrganizeMatch | null;
  seasonOverride: number | null;
  episodeOffset: number;
  /** 补空值（记住的识别、追更上次的整理）：见 EpisodeFill */
  fill?: EpisodeFill | null;
  /** `season:episode` → 集标题（开了集标题才有） */
  episodeTitles?: Map<string, string>;
  selected: boolean;
  /** 用户单独取消勾选的文件（相对任务 originPath）：跳过，跟着它们的字幕 / nfo 一起留下 */
  excluded?: ReadonlySet<string>;
  /** 用户给冲突项选的处理（相对任务 originPath）：撞上了按它来，没选就留在原处 */
  resolutions?: ReadonlyMap<string, OrganizeConflictResolution>;
}

/** 单独取消勾选的文件跳过时的原因 */
export const EXCLUDED_REASON = "没勾选这个文件";

export interface PlanContext {
  settings: ResolvedOrganizeSettings;
  libraryType?: "movie" | "tv" | "mixed";
}

const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/*
 * 没跟某个视频同名的 nfo / 图片放哪（名字都不动）：
 *   - 作品级（tvshow.nfo、movie.nfo、剧根的 seasonXX-poster.jpg 这类季图片）→ 作品目录；
 *   - 目录级图片（poster / fanart / banner …）和 season.nfo：在剧 / 电影目录里是作品的 → 作品目录，在季目录里是这一季的 → 新季目录。
 */
const RE_WORK_FILE = /^(?:tvshow|movie)\d*\.[a-z0-9]+$/i;
const RE_SEASON_NFO = /^season\.nfo$/i;
const ART_KINDS = "poster|fanart|banner|logo|clearart|clearlogo|thumb|landscape|backdrop|background|folder|disc|discart|cover|keyart|characterart";
const RE_FOLDER_ART = new RegExp(`^(?:${ART_KINDS})\\d*\\.[a-z0-9]+$`, "i");
const RE_SEASON_ART = new RegExp(`^season(?:\\d+|-all|-specials)(?:-(?:${ART_KINDS}))?\\.[a-z0-9]+$`, "i");

function actionFor(src: string, dst: string): OrganizeAction {
  if (src === dst) return "keep";
  return dirOf(src) === dirOf(dst) ? "rename" : "move";
}

interface SeasonEpisode {
  season: number;
  episode: number;
  episodeEnd?: number;
  /** 没有季标记的集数（给模板的 {absolute}） */
  absolute?: number;
  note?: string;
  /** 补空值真用上了（见 EpisodeFill）：单元说明里要提一句 */
  filled?: true;
}

/**
 * 补空值：季只给自己什么季都没给的文件（文件名、识别词、季目录、目录名都没有），集偏移只给文件名没写季的文件（原样编号）。
 * 记住的识别、追更上次的整理都是这个口径：作品目录以后还会收别的季，整理好的文件再整理也不能再套一次；人定的季 / 偏移照旧强制
 */
export interface EpisodeFill {
  season: number | null;
  episodeOffset: number;
  /** 哪来的，写进单元说明：「按记住的识别」「沿用追更「X」上次的整理」 */
  from: string;
}

/** 去掉尾巴数字后的标题是不是这部剧：对单元自己的标题候选和 TMDB 的译名 / 原名 / 英文名 */
function isSameWork(titles: string[], unit: Unit, match: OrganizeMatch): boolean {
  const known = new Set([...unit.parsed.titles, match.title, match.originalTitle, match.enTitle ?? ""].map(normalizeTitle).filter(Boolean));
  return titles.some((t) => known.has(normalizeTitle(t)));
}

/**
 * 一集在哪一季第几集：文件自己的 S01E01 最可信；只有绝对集数时结合季目录 / TMDB 每季集数折算；
 * 名字里只有标题末尾的数字（`回家的诱惑69`）、去掉数字正好是这部剧的名字时，数字当绝对集数。
 * 用户给的季覆盖和集偏移最后套上。
 * 识别词直指（`{[tmdbid=…;s=2]}`）只在直指的就是认出来的这部作品时才算：命中文件名的，s / e 只管这一个文件、压过别的；
 * 命中目录名的，s 管整个单元（特别篇除外），折算绝对集数也按它，人在预览里改的季优先
 */
export function resolveEpisode(
  file: UnitFile,
  unit: Unit,
  match: OrganizeMatch,
  seasonOverride: number | null,
  episodeOffset: number,
  fill?: EpisodeFill | null,
): SeasonEpisode | null {
  const p = file.parsed;
  const pin = file.direct && file.direct.tmdbId === match.tmdbId ? file.direct : undefined;
  const ruleSeason = pin?.season === undefined && unit.dirDirect && unit.dirDirect.tmdbId === match.tmdbId ? unit.dirDirect.season : undefined;
  const own = pin?.season ?? p.season ?? ruleSeason ?? file.seasonFromDir ?? unit.parsed.season;
  const fillSeason = own === undefined && fill && fill.season !== null ? fill.season : undefined;
  let season: number | undefined = own ?? fillSeason;
  let episode: number | undefined = pin?.episode ?? p.episode;
  let episodeEnd: number | undefined = pin?.episode !== undefined ? undefined : p.episodeEnd;
  let absolute = p.absolute;
  const absoluteEnd = p.absoluteEnd;
  let note: string | undefined;
  if (p.isSpecial && p.season === undefined && pin?.season === undefined) season = 0;
  if (episode === undefined && absolute === undefined && !p.isSpecial) {
    // 单元阶段没敢认的尾巴数字（只有这一个文件、没有季目录也没有兄弟可比）：TMDB 已经认成剧集，它就是集数
    const t = trailingNumber(p);
    if (t && isSameWork(t.titles, unit, match)) absolute = t.number;
  }
  if (episode === undefined && absolute !== undefined) {
    episode = absolute;
    episodeEnd = absoluteEnd;
    const seasons = (match.seasons ?? []).filter((s) => s.season > 0).sort((a, b) => a.season - b.season);
    const inSeason = seasons.find((s) => s.season === (season ?? 1));
    // 绝对集数超过了这一季的集数：按前几季累加折算（只在没有明确季目录、或季目录里的号码明显超出时）
    if (inSeason && episode > inSeason.episodeCount && seasons.length > 1) {
      let remain = episode;
      let hit: { season: number; ep: number } | null = null;
      for (const s of seasons) {
        if (remain <= s.episodeCount) {
          hit = { season: s.season, ep: remain };
          break;
        }
        remain -= s.episodeCount;
      }
      if (hit && (season === undefined || file.seasonFromDir === undefined || hit.season === season)) {
        note = `第 ${episode} 集超过 S${pad2(season ?? 1)} 的 ${inSeason.episodeCount} 集，按绝对集数折算成 S${pad2(hit.season)}E${pad2(hit.ep)}`;
        season = hit.season;
        episode = hit.ep;
        if (episodeEnd !== undefined) episodeEnd = hit.ep + (absoluteEnd! - absolute);
      }
    }
  }
  if (episode === undefined) return null;
  if (pin?.season === undefined) {
    if (seasonOverride !== null) season = seasonOverride;
    else if (ruleSeason !== undefined && !p.isSpecial) season = ruleSeason;
  }
  if (season === undefined) season = p.isSpecial ? 0 : 1;
  // 识别词钉死了集数的不再偏移
  const fillOffset = fill && pin?.episode === undefined && p.season === undefined ? fill.episodeOffset : 0;
  if (pin?.episode === undefined) {
    episode += episodeOffset + fillOffset;
    if (episodeEnd !== undefined) episodeEnd += episodeOffset + fillOffset;
  }
  if (episode < 0) return null;
  // 补空的季是 1 和没补一样，不算用上
  const filled = (fillSeason !== undefined && fillSeason !== 1 && season === fillSeason && seasonOverride === null) || fillOffset !== 0;
  return { season, episode, episodeEnd, absolute, note, ...(filled ? { filled: true as const } : {}) };
}

/** 补空值用上了：「按记住的识别：2 个没写季的文件放第 2 季、集数 +12」 */
function fillNote(fill: EpisodeFill, count: number): string {
  const what = [fill.season !== null && fill.season !== 1 ? `放第 ${fill.season} 季` : "", fill.episodeOffset ? `集数 ${fill.episodeOffset > 0 ? "+" : ""}${fill.episodeOffset}` : ""].filter(Boolean);
  return `${fill.from}：${count} 个没写季的文件${what.join("、")}`;
}

function fileVars(file: UnitFile): TemplateVars {
  const t = file.parsed.tags;
  return {
    edition: file.parsed.edition,
    resolution: t.resolution,
    source: t.source,
    videoCodec: t.videoCodec,
    audio: t.audio,
    hdr: t.hdr,
    group: t.group,
    part: file.parsed.part !== undefined ? `part${file.parsed.part}` : "",
    ext: file.ext.replace(/^\./, ""),
    originalName: file.stem,
  };
}

/**
 * 改名保留时依次试的目标名：先拿这个文件自己的版本标签区分（`凡人修仙传 - S01E135 - 2160p.mp4`，Emby 认这种多版本写法），
 * 标签都用上了还撞就 `(2)`、`(3)`。目标名里已经有的标签不再重复加
 */
function renameVariants(dst: string, file: UnitFile): string[] {
  const dir = dirOf(dst);
  const name = baseOf(dst);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  const lower = stem.toLowerCase();
  const t = file.parsed.tags;
  const tags = [t.resolution, t.source, t.hdr, t.videoCodec, t.audio, t.group, file.parsed.edition].filter((x): x is string => !!x && !lower.includes(x.toLowerCase()));
  const out: string[] = [];
  let suffix = "";
  for (const tag of tags) {
    suffix += ` - ${tag}`;
    out.push(join(dir, `${stem}${suffix}${ext}`));
  }
  for (let i = 2; i <= 9; i++) out.push(join(dir, `${stem}${suffix} (${i})${ext}`));
  return out;
}

/** 这个路径本身，加上撞了名再往后排的 `(2)`…`(9)`：挪进重复文件目录时那边也可能已经有同名的 */
function numberedVariants(path: string): string[] {
  const m = /\.[^./]+$/.exec(path);
  const ext = m ? m[0] : "";
  const stem = ext ? path.slice(0, -ext.length) : path;
  return [path, ...Array.from({ length: 8 }, (_, i) => `${stem} (${i + 2})${ext}`)];
}

/** 字幕的目标：视频主名 + 语言 + 标记 + 扩展名 */
function subtitleName(videoDst: string, sub: UnitFile): string {
  const stem = videoDst.replace(/\.[^./]+$/, "");
  const parts = [stem];
  if (sub.parsed.subtitleLang) parts.push(sub.parsed.subtitleLang);
  if (sub.parsed.forced) parts.push("forced");
  if (sub.parsed.sdh) parts.push("sdh");
  return `${parts.join(".")}${sub.ext}`;
}

export function planUnit(input: UnitPlanInput, ctx: PlanContext): UnitPlan {
  const { unit, match } = input;
  const notes: string[] = [];
  // 单元阶段按「同名的多个版本」猜成了电影；TMDB 认成剧集时这句话就不对了
  if (unit.multiVersion && match?.mediaType !== "tv") notes.push(`${unit.multiVersion} 个视频没有集数标记，按同一部电影的多个版本处理`);
  const items: PlannedItem[] = [];
  const resolutions = input.resolutions;
  /** 冲突上自己填的目标文件名（没带扩展名就沿用原来的）：撞上了 finalizeItems 才换成它，目录还是整理算出来的 */
  const customNameOf = (file: UnitFile): string | undefined => {
    const r = resolutions?.get(file.path);
    const name = r?.how === "custom" ? r.name?.trim() : undefined;
    if (!name) return undefined;
    return name.toLowerCase().endsWith(file.ext) ? name : `${name}${file.ext}`;
  };
  const push = (file: UnitFile, dst: string | null, reason = "", forced?: OrganizeAction, extra?: Pick<PlannedItem, "follows" | "soft">) => {
    const action = forced ?? (dst === null ? "skip" : actionFor(file.path, dst));
    const resolve = resolutions?.get(file.path)?.how;
    const variants = resolve === "rename" && dst ? renameVariants(dst, file) : undefined;
    const customName = resolve === "custom" ? customNameOf(file) : undefined;
    items.push({ unitKey: unit.key, kind: file.kind, action, srcPath: file.path, dstPath: dst ?? file.path, nodeId: file.id ?? "", reason, resolve, variants, customName, ...extra });
  };

  if (!match) {
    for (const f of unit.files) push(f, null, "没有识别出作品");
    return { unitKey: unit.key, dstRoot: "", items, notes };
  }
  if (!input.selected) {
    for (const f of unit.files) push(f, null, "未勾选");
    return { unitKey: unit.key, dstRoot: "", items, notes };
  }

  const s = ctx.settings;
  const category = s.categories.enabled
    ? pickCategory(match.mediaType === "movie" ? s.categories.movie : s.categories.tv, {
        genreIds: match.genreIds,
        countries: match.countries,
        originalLanguage: match.originalLanguage,
      })
    : "";
  const common: TemplateVars = {
    category,
    title: match.title,
    originalTitle: match.originalTitle,
    enTitle: match.enTitle,
    year: match.year,
    tmdbId: match.tmdbId,
    imdbId: match.imdbId,
    idTag: idTagFor(s.idTag, match.tmdbId),
  };
  const template = match.mediaType === "movie" ? s.templates.movie : s.templates.tv;

  // 先规划视频：每个视频的目标路径；作品根目录 = 模板里含 {title} / {idTag} 的那一层及其之上的层
  const videoDst = new Map<UnitFile, string>();
  const videoKey = new Map<UnitFile, string>();
  const rootTemplate = (() => {
    const segs = template.split("/");
    const idx = segs.findIndex((seg) => /\{(title|originalTitle|enTitle|idTag|tmdbId)\}/.test(seg));
    return idx === -1 ? "" : segs.slice(0, idx + 1).join("/");
  })();
  const dstRoot = rootTemplate ? renderTemplate(rootTemplate, common, { colon: s.colon }).path : "";

  const excluded = input.excluded ?? new Set<string>();
  let filledCount = 0;
  for (const f of unit.files) {
    if (f.kind !== "video" || f.inExtrasDir || f.parsed.isExtra) continue;
    if (excluded.has(f.path)) {
      push(f, null, EXCLUDED_REASON);
      continue;
    }
    let vars: TemplateVars = { ...common, ...fileVars(f) };
    if (match.mediaType === "tv") {
      const se = resolveEpisode(f, unit, match, input.seasonOverride, input.episodeOffset, input.fill);
      if (!se) {
        push(f, null, "看不出是第几集");
        continue;
      }
      if (se.note) notes.push(`${f.name}：${se.note}`);
      if (se.filled) filledCount++;
      const key = `${se.season}:${se.episode}`;
      vars = {
        ...vars,
        season: se.season,
        season00: pad2(se.season),
        episode: episodeToken(se.episode, se.episodeEnd, 0),
        episode00: episodeToken(se.episode, se.episodeEnd, 2),
        absolute: se.absolute,
        absolute000: se.absolute !== undefined ? pad3(se.absolute) : "",
        episodeTitle: input.episodeTitles?.get(key) ?? "",
      };
      videoKey.set(f, key);
    }
    const r = renderTemplate(template, vars, { colon: s.colon });
    if (r.errors.length > 0 || !r.path) {
      push(f, null, `模板有问题：${r.errors.join("；") || "空路径"}`);
      continue;
    }
    videoDst.set(f, r.path);
    push(f, r.path);
  }

  // 同一单元里两个视频算出同一个目标（画质标签一样的多版本）：后面的标冲突。
  // 用户给这一份选过办法（改名保留 / 删掉…）就先留着目标，让 finalizeItems 按他选的安排
  const seen = new Map<string, UnitFile>();
  for (const [f, dst] of videoDst) {
    const first = seen.get(dst);
    if (first) {
      if (resolutions?.has(f.path)) continue;
      const it = items.find((i) => i.srcPath === f.path)!;
      it.action = "conflict";
      it.reason = `和 ${first.name} 算出同一个目标名，请改模板加上 {source} / {group} 之类的区分`;
      videoDst.delete(f);
    } else seen.set(dst, f);
  }

  if (filledCount > 0 && input.fill) notes.push(fillNote(input.fill, filledCount));

  const videos = [...videoDst.keys()];
  // 单元里所有的正片（排没排上都算）：字幕在它们里面找主人
  const unitVideos = unit.files.filter((v) => v.kind === "video" && !v.inExtrasDir && !v.parsed.isExtra);
  const allVideos = videos.map((v) => v.path);
  // 单元根是这部作品自己的目录：分单元时就认出来了的，或者（不是从大目录里拆出来的）目录名就是识别出来的片名——
  // 「中文目录名 + 英文文件名」分单元时对不上，TMDB 认出来之后才知道是一回事
  const ownsDir = unit.ownsDir || (!!unit.rootPath && !unit.key.includes("|") && isNamedAfter(baseOf(unit.rootPath), [match.title, match.originalTitle, match.enTitle]));
  // 季目录 → 里面的视频要去的新季目录（取最多的那个）：季目录里的 poster.jpg / season.nfo 跟过去
  const bySeasonDir = new Map<string, UnitFile[]>();
  for (const v of videos) {
    if (v.seasonFromDir === undefined) continue;
    const src = dirOf(v.path);
    bySeasonDir.set(src, [...(bySeasonDir.get(src) ?? []), v]);
  }
  const seasonDsts = new Map<string, { dir: string; videos: string[] }>();
  for (const [src, vs] of bySeasonDir) {
    const counts = new Map<string, number>();
    for (const v of vs) {
      const d = dirOf(videoDst.get(v)!);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const [dir] = [...counts].sort((a, b) => b[1] - a[1])[0];
    seasonDsts.set(src, { dir, videos: vs.map((v) => v.path) });
  }
  /** 没跟某个视频同名的 nfo / 图片放哪、跟着哪些视频；放不了返回跳过的原因 */
  const placeOf = (f: UnitFile): { dst: string; follows: string[] } | string => {
    if (f.artDir) return { dst: join(join(dstRoot, f.artDir), f.name), follows: allVideos };
    if (RE_WORK_FILE.test(f.name) || RE_SEASON_ART.test(f.name)) return { dst: join(dstRoot, f.name), follows: allVideos };
    if (RE_FOLDER_ART.test(f.name) || RE_SEASON_NFO.test(f.name)) {
      if (f.seasonFromDir === undefined) return { dst: join(dstRoot, f.name), follows: allVideos };
      const season = seasonDsts.get(dirOf(f.path));
      return season ? { dst: join(season.dir, f.name), follows: season.videos } : "这个季目录里没有要整理的视频";
    }
    // 名字认不出的：作品自己的目录里原名跟进作品目录；从大目录里拆出来的 / 散在范围根的不知道归谁，不动
    return ownsDir ? { dst: join(dstRoot, f.name), follows: allVideos } : "找不到对应的视频";
  };

  for (const f of unit.files) {
    if (f.kind === "video" && videoDst.has(f)) continue;
    if (f.kind === "video" && items.some((i) => i.srcPath === f.path)) continue; // 已经 skip / conflict 了
    if (excluded.has(f.path)) {
      push(f, null, EXCLUDED_REASON);
      continue;
    }

    // 「跟着走」只管作品目录外面的：已经在作品目录里的花絮 / 杂项不重新摆（整理过的库再跑不折腾；
    // `片名 (2024)-trailer.mkv`、`Featurettes/` 这种媒体服务器本来就认的放法也不动）
    const inWork = !!dstRoot && f.path.startsWith(`${dstRoot}/`);

    // 花絮（sample 也算）：跟着正片进作品目录下的 extras/，平铺、原名（媒体服务器不认 extras 里再套目录）；设置成留在原处就不动。
    // 算附属：正片一个都没挪它也不挪，目标被占就留下、不算冲突
    if (f.inExtrasDir || f.parsed.isExtra) {
      if (s.extras === "move" && dstRoot && !inWork) push(f, join(join(dstRoot, "extras"), f.name), "按花絮处理", undefined, { follows: allVideos, soft: true });
      else push(f, f.path, "花絮不动", "keep");
      continue;
    }
    if (f.kind === "subtitle") {
      // 主人在单元的全部视频里找（按集数、按同名前缀；单元本来就只有一个视频时就是它）。主人没排上（看不出集数、撞名、没勾）
      // 就跟着留下——不能退到「唯一排上的那个视频」，那会把别的视频的字幕配给它
      let owner: UnitFile | undefined;
      if (match.mediaType === "tv") {
        const se = resolveEpisode(f, unit, match, input.seasonOverride, input.episodeOffset, input.fill);
        if (se) owner = videos.find((v) => videoKey.get(v) === `${se.season}:${se.episode}`);
      }
      owner ??= unitVideos.filter((v) => f.stem.startsWith(v.stem)).sort((a, b) => b.stem.length - a.stem.length)[0];
      if (!owner && unitVideos.length === 1) owner = unitVideos[0];
      if (!owner) {
        push(f, null, "找不到对应的视频");
        continue;
      }
      const ownerDst = videoDst.get(owner);
      if (!ownerDst) {
        push(f, null, "对应的视频没挪，跟着留在原处");
        continue;
      }
      push(f, subtitleName(ownerDst, f), "", undefined, { follows: [owner.path], soft: true });
      continue;
    }
    if (f.kind === "nfo" || f.kind === "image") {
      // 跟某个视频同名（<视频>.nfo、<视频>-thumb.jpg）：跟着视频改名；那个视频没排上（看不出集数、和别的版本撞了同一个目标）就跟着它留下
      const owner = unit.files.find((v) => v.kind === "video" && (f.stem === v.stem || f.stem.startsWith(`${v.stem}-`) || f.stem.startsWith(`${v.stem}.`)));
      if (owner) {
        const vdst = videoDst.get(owner);
        if (vdst) push(f, `${vdst.replace(/\.[^./]+$/, "")}${f.stem.slice(owner.stem.length)}${f.ext}`, "", undefined, { follows: [owner.path], soft: true });
        else push(f, null, "对应的视频没挪，跟着留在原处");
        continue;
      }
      if (!dstRoot) {
        push(f, null, "作品目录还没定");
        continue;
      }
      const place = placeOf(f);
      if (typeof place === "string") push(f, null, place);
      else push(f, place.dst, "", undefined, { follows: place.follows, soft: true });
      continue;
    }
    // 认不出类型的（txt / url / 音频 / 压缩包）：和认不出名字的图片 / nfo 一个规矩——作品自己的目录里原名跟进作品目录，
    // 留下就成了没人管的孤儿、旧目录也删不掉；收件箱里散着的不知道归谁，不动
    const place = dstRoot && !inWork ? placeOf(f) : null;
    if (place && typeof place !== "string") push(f, place.dst, "", undefined, { follows: place.follows, soft: true });
    else push(f, f.path, "不认识的文件类型，不动", "keep");
  }

  return { unitKey: unit.key, dstRoot, items, notes };
}

/** 删空目录的边界：只删根里面腾空的目录，根本身 removable 才删 */
export interface ScopeRoot {
  /** 相对任务 originPath；"" 是任务根（永远不删） */
  path: string;
  removable: boolean;
}

export interface DirOpsInput {
  /** 范围里所有条目（相对任务 originPath）：文件和目录 */
  entries: Array<{ path: string; isDir: boolean; id?: string }>;
  /**
   * 范围的根：只删根里面腾空的目录；根本身 removable 时才删（范围就是某个发布目录 / 季目录、自动整理新落进来的目录），
   * `inbox` 这种收件箱和任务根不删。没给就用 scopePath + scopeRemovable（一个根）
   */
  scopeRoots?: ScopeRoot[];
  /** 范围目录本身：默认不删（`inbox` 这种收件箱），scopeRemovable 时（范围就是某个发布目录）腾空了也删 */
  scopePath?: string;
  scopeRemovable?: boolean;
  items: PlannedItem[];
  cleanupEmptyDirs: boolean;
}

/**
 * 跨单元冲突检测 + 目录操作。返回完整的项列表（mkdir 在前、文件项在中、rmdir 在后）。
 *   - 两个源指向同一目标：后者冲突
 *   - 目标已存在且不是正被挪走的源：冲突
 *   - 冲突项选过办法（改名保留 / 自己填名字 / 挪进重复文件 / 删掉这一份 / 覆盖）的按选的来，跟着的字幕 / nfo 一起走；没撞上的办法不用
 *   - 目标目录缺失：mkdir（按深度）
 *   - 源目录腾空：rmdir（按深度倒序）
 */
export function finalizeItems(plans: UnitPlan[], input: DirOpsInput): PlannedItem[] {
  const items = plans.flatMap((p) => p.items);
  const existing = new Set(input.entries.map((e) => e.path));
  const entryByPath = new Map(input.entries.map((e) => [e.path, e]));
  /** 冲突上选了删除 / 覆盖、执行时会从网盘上删掉的路径：撞名检查和「源目录腾空了没」都当它不在 */
  const removed = new Set<string>();
  /** 覆盖时先删掉占位那份：挂在对应的项前面，一起落进最终的清单 */
  const before = new Map<PlannedItem, PlannedItem[]>();
  const existingDirs = new Set<string>();
  const dirIds = new Map<string, string>();
  for (const e of input.entries) {
    if (e.isDir) {
      existingDirs.add(e.path);
      if (e.id) dirIds.set(e.path, e.id);
    }
    let d = dirOf(e.path);
    while (d) {
      existingDirs.add(d);
      d = dirOf(d);
    }
  }
  const isMoving = (i: PlannedItem) => i.action === "rename" || i.action === "move";
  /** 留在原处：附属文件（soft）不算冲突，标 skip 说一句；其余是冲突 */
  const stay = (it: PlannedItem, conflictReason: string, softReason: string) => {
    it.action = it.soft ? "skip" : "conflict";
    it.reason = it.soft ? softReason : conflictReason;
  };
  /** 一项只换一次目标：换完还撞（别的项抢在前面）就按冲突留下，免得两项互相挤来挤去 */
  const retargeted = new Set<PlannedItem>();
  // 冲突、「跟着的视频没挪」都会让项留在原处，它占着的源位置就不能再当「会腾出来」：按还在挪的项重算，
  // 直到一轮下来没有新的项留下。项只会从挪变留，一定收敛，通常一两轮
  for (let changed = true; changed; ) {
    changed = false;
    const movingSrc = new Set(items.filter(isMoving).map((i) => i.srcPath));
    const settled = new Set(items.filter((i) => isMoving(i) || i.action === "keep").map((i) => i.srcPath));
    const claimed = new Map<string, PlannedItem>();
    const taken = (p: string) => (existing.has(p) && !movingSrc.has(p) && !removed.has(p)) || existingDirs.has(p) || claimed.has(p);
    /** 跨目录且改名的项先在源目录里原地改名再挪：中间名字也得是空的 */
    const usable = (it: PlannedItem, dst: string) => {
      if (taken(dst)) return false;
      if (dirOf(dst) === dirOf(it.srcPath) || baseOf(it.srcPath) === baseOf(dst)) return true;
      return !taken(join(dirOf(it.srcPath), baseOf(dst)));
    };
    /**
     * 用户给这个冲突项选过办法就换个目标接着走：改名保留（加区分后缀）或挪进重复文件目录；跟着它的字幕 / nfo 一起换。
     * 没选、或者候选位置全被占了，返回 false 按冲突留在原处
     */
    const retarget = (it: PlannedItem): boolean => {
      if (!it.resolve || retargeted.has(it)) return false;
      const stem = it.dstPath.replace(/\.[^./]+$/, "");
      // 跟着这个视频、又是按它的名字命名的（字幕、同名 nfo）：一起走
      const followers = items.filter((f) => f !== it && f.follows?.includes(it.srcPath) && f.dstPath.startsWith(stem));
      if (it.resolve === "delete") {
        retargeted.add(it);
        for (const f of [it, ...followers]) {
          removed.add(f.srcPath);
          f.action = "delete";
          f.dstPath = f.srcPath;
          f.reason = f === it ? "冲突选了删掉这一份" : `跟着 ${baseOf(it.srcPath)} 一起删掉`;
        }
        it.resolved = true;
        return true;
      }
      if (it.resolve === "replace") {
        // 占着位置的得是网盘上一个实实在在的文件：目录、或者本轮别的项要挪过去的位置，覆盖不了
        const hit = entryByPath.get(it.dstPath);
        if (!hit || hit.isDir || existingDirs.has(it.dstPath) || claimed.has(it.dstPath)) return false;
        retargeted.add(it);
        removed.add(it.dstPath);
        before.set(it, [{ unitKey: it.unitKey, kind: it.kind, action: "delete", srcPath: it.dstPath, dstPath: it.dstPath, nodeId: hit.id ?? "", reason: `覆盖：先删掉这里原来的 ${baseOf(it.dstPath)}` }]);
        it.reason = "覆盖：删掉原来那份再挪过来";
        it.resolved = true;
        return true; // 目标这一轮才腾出来，下一轮再认领
      }
      const candidates =
        it.resolve === "rename"
          ? (it.variants ?? [])
          : it.resolve === "custom"
            ? it.customName
              ? [join(dirOf(it.dstPath), it.customName)]
              : []
            : numberedVariants(duplicatePathFor(it.srcPath));
      const free = candidates.find((c) => usable(it, c));
      if (!free) return false;
      retargeted.add(it);
      it.resolved = true;
      const dup = it.resolve === "duplicate";
      it.dstPath = free;
      it.action = actionFor(it.srcPath, free);
      it.reason = dup
        ? `和已有的重复，挪进 ${DUPLICATES_DIR}/ 留着`
        : it.resolve === "custom"
          ? `目标已存在，按填的名字改成 ${baseOf(free)}`
          : `目标已存在，改名保留成 ${baseOf(free)}`;
      for (const f of followers) {
        f.dstPath = dup ? duplicatePathFor(f.srcPath) : `${free.replace(/\.[^./]+$/, "")}${f.dstPath.slice(stem.length)}`;
        f.action = actionFor(f.srcPath, f.dstPath);
      }
      return true;
    };
    for (const it of items) {
      if (!isMoving(it)) continue;
      if (it.follows && !it.follows.some((p) => settled.has(p))) {
        it.action = "skip";
        it.reason = "对应的视频没挪，跟着留在原处";
        changed = true;
        continue;
      }
      const other = claimed.get(it.dstPath);
      if (other) {
        if (!retarget(it)) stay(it, `目标和 ${baseOf(other.srcPath)} 重复`, `和 ${baseOf(other.srcPath)} 要去同一个位置，留在原处`);
        changed = true;
        continue;
      }
      if ((existing.has(it.dstPath) && !movingSrc.has(it.dstPath) && !removed.has(it.dstPath)) || existingDirs.has(it.dstPath)) {
        if (!retarget(it)) stay(it, "目标已存在", "目标位置已经有同名的，留在原处");
        changed = true;
        continue;
      }
      // 跨目录且改名的项先在源目录里原地改名再挪：中间名字不能撞上源目录里不动的文件，也不能两个项撞同一个
      if (it.action === "move" && baseOf(it.srcPath) !== baseOf(it.dstPath)) {
        const intermediate = join(dirOf(it.srcPath), baseOf(it.dstPath));
        if (taken(intermediate)) {
          if (!retarget(it)) stay(it, `源目录里已有 ${baseOf(it.dstPath)}，改名会撞上`, `源目录里已有 ${baseOf(it.dstPath)}，改名会撞上，留在原处`);
          changed = true;
          continue;
        }
        claimed.set(intermediate, it);
      }
      claimed.set(it.dstPath, it);
    }
  }

  // mkdir：目标的每一层祖先，不存在且没建过的
  const needDirs = new Set<string>();
  for (const it of items) {
    if (it.action !== "rename" && it.action !== "move") continue;
    let d = dirOf(it.dstPath);
    const chain: string[] = [];
    while (d && !existingDirs.has(d)) {
      chain.unshift(d);
      d = dirOf(d);
    }
    for (const c of chain) needDirs.add(c);
  }
  const mkdirs: PlannedItem[] = [...needDirs]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .map((d) => ({ unitKey: "", kind: "dir", action: "mkdir", srcPath: d, dstPath: d, nodeId: "", reason: "" }));

  // rmdir：源目录里没剩东西的（按范围里的清单算）
  const rmdirs: PlannedItem[] = [];
  if (input.cleanupEmptyDirs) {
    // 按最终结果算：留在原处的项（冲突、附属文件留下）还占着源目录；删掉的不占
    const moved = items.filter(isMoving);
    const movedSrc = new Set(moved.map((i) => i.srcPath));
    const remaining = new Set<string>();
    for (const p of existing) if (!movedSrc.has(p) && !removed.has(p)) remaining.add(p);
    for (const it of moved) remaining.add(it.dstPath);
    for (const d of needDirs) remaining.add(`${d}/`);
    const roots = input.scopeRoots ?? [{ path: input.scopePath ?? "", removable: !!input.scopeRemovable }];
    // 在某个根里面（不含根本身）：任务根（""）里面是除它以外的一切。往上找腾空的目录不越过根
    const inside = (d: string) => roots.some((r) => (r.path === "" ? d !== "" : d.startsWith(`${r.path}/`)));
    const removableRoot = (d: string) => roots.some((r) => r.removable && r.path !== "" && r.path === d);
    const candidates = new Set<string>();
    for (const it of [...moved, ...items.filter((i) => i.action === "delete")]) {
      if (it.action !== "move" && it.action !== "delete") continue;
      let d = dirOf(it.srcPath);
      while (d && inside(d)) {
        candidates.add(d);
        d = dirOf(d);
      }
      if (d && removableRoot(d)) candidates.add(d);
    }
    const empty = (dir: string): boolean => {
      const prefix = `${dir}/`;
      for (const p of remaining) if (p.startsWith(prefix)) return false;
      return true;
    };
    for (const d of [...candidates].sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a))) {
      if (!empty(d)) continue;
      rmdirs.push({ unitKey: "", kind: "dir", action: "rmdir", srcPath: d, dstPath: d, nodeId: dirIds.get(d) ?? "", reason: "" });
      // 目录自己也是一条条目（walkSubtree 会带目录项）：删掉它上级才算空，从深到浅正好逐层清
      remaining.delete(d);
    }
  }
  return [...mkdirs, ...items.flatMap((it) => [...(before.get(it) ?? []), it]), ...rmdirs];
}
