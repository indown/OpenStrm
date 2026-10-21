/**
 * 命名模板预设，两个轴：
 *   - 服务器（Emby / Jellyfin / Plex / Kodi）：决定 id 标签写法、特别篇目录名、花絮目录名和两类文件名的细节；
 *   - 结构（每类各一组）：只管目录层级（按年份分目录、按系列归档、绝对集数、保留原文件名）。
 * 模板 = buildTemplate(类型, 结构, 服务器)；反推时先按 id 标签定服务器，再看模板等于哪个结构。
 * 默认模板（Emby + 默认结构）必须和后端 services/organize/settings.ts 的 DEFAULT_TEMPLATES 一字不差（有测试盯着）。
 */
import type { OrganizeIdTagStyle } from "@openstrm/shared";
import { joinMovie, joinTv } from "./template-parts";

export type MediaKind = "movie" | "tv";
export type ServerKey = "emby" | "jellyfin" | "plex" | "kodi";
export type SpecialsStyle = "season00" | "specials";

export interface ServerPreset {
  key: ServerKey;
  label: string;
  hint: string;
  idTag: OrganizeIdTagStyle;
  specials: SpecialsStyle;
  extrasDir: string;
  /** 电影文件名（不含目录） */
  movieFile: string;
  /** 季目录 */
  tvSeason: string;
  /** 剧集文件名；{ABS} 是「绝对集数」可选段的插入点 */
  tvFile: string;
}

const EMBY_MOVIE_FILE = "{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}";
const EMBY_TV_FILE = "{title} - S{season00}E{episode00}{ABS}[ - {episodeTitle}].{ext}";

export const SERVERS: ServerPreset[] = [
  {
    key: "emby",
    label: "Emby",
    hint: "目录名带 [tmdbid=…]，季目录 Season 01，花絮进 extras/",
    idTag: "emby",
    specials: "season00",
    extrasDir: "extras",
    movieFile: EMBY_MOVIE_FILE,
    tvSeason: "Season {season00}",
    tvFile: EMBY_TV_FILE,
  },
  {
    key: "jellyfin",
    label: "Jellyfin",
    hint: "和 Emby 一样的结构，id 标签写成 [tmdbid-…]",
    idTag: "jellyfin",
    specials: "season00",
    extrasDir: "extras",
    movieFile: EMBY_MOVIE_FILE,
    tvSeason: "Season {season00}",
    tvFile: EMBY_TV_FILE,
  },
  {
    key: "plex",
    label: "Plex",
    hint: "id 标签 {tmdb-…}，文件名带年份、小写 s01e01，特别篇目录叫 Specials，花絮进 Other/",
    idTag: "plex",
    specials: "specials",
    extrasDir: "Other",
    movieFile: "{title} ({year})[ - {edition}].{ext}",
    tvSeason: "Season {season00}",
    tvFile: "{title} ({year}) - s{season00}e{episode00}{ABS}[ - {episodeTitle}].{ext}",
  },
  {
    key: "kodi",
    label: "Kodi",
    hint: "目录名不写 id（Kodi 靠 nfo），特别篇目录叫 Specials，花絮进 extras/",
    idTag: "none",
    specials: "specials",
    extrasDir: "extras",
    movieFile: EMBY_MOVIE_FILE,
    tvSeason: "Season {season00}",
    tvFile: EMBY_TV_FILE,
  },
];

export const serverByKey = (key: ServerKey): ServerPreset => SERVERS.find((s) => s.key === key) ?? SERVERS[0];

/** 设置里的 id 标签写法对应哪个服务器（模板是自定义的时候，预设按它生成文件名细节） */
export function serverFromIdTag(idTag: OrganizeIdTagStyle | undefined): ServerKey {
  switch (idTag) {
    case "jellyfin":
      return "jellyfin";
    case "plex":
      return "plex";
    case "none":
      return "kodi";
    default:
      return "emby";
  }
}

export type MovieStructure = "default" | "yearDir" | "collection" | "keepName";
export type TvStructure = "default" | "yearDir" | "absolute" | "keepName";
export type StructureKey = MovieStructure | TvStructure;

export interface StructurePreset {
  key: StructureKey;
  label: string;
  hint: string;
}

export const STRUCTURES: Record<MediaKind, StructurePreset[]> = {
  movie: [
    { key: "default", label: "默认", hint: "作品目录带年份和 id 标签" },
    { key: "yearDir", label: "按年份分目录", hint: "作品目录上面多一层年份：2024/沙丘：第二部 (2024) [tmdbid=…]/…" },
    { key: "collection", label: "按系列归档", hint: "同一系列的电影放进系列目录：沙丘（系列）/沙丘：第二部 (2024) [tmdbid=…]/…；不属于系列的照常" },
    { key: "keepName", label: "只归目录，文件名保留原名", hint: "作品目录照规范建，文件名原样不动：只想把散落的文件归位、不想动发布组命名时用" },
  ],
  tv: [
    { key: "default", label: "默认", hint: "作品目录带年份和 id 标签，剧集按 Season 分目录" },
    { key: "yearDir", label: "按年份分目录", hint: "作品目录上面多一层年份：2023/怒呛人生 (2023) [tmdbid=…]/Season 01/…" },
    { key: "absolute", label: "动画：文件名带绝对集数", hint: "番剧常按总集数编号：S02E05 后面再跟 - 030，播放器和字幕组的编号都对得上" },
    { key: "keepName", label: "只归目录，文件名保留原名", hint: "作品目录和季目录照规范建，文件名原样不动" },
  ],
};

const WORK_DIR = "{title} ({year}) {idTag}";

function dirOf(structure: StructureKey): string {
  switch (structure) {
    case "yearDir":
      return `{category}/{year}/${WORK_DIR}`;
    case "collection":
      return `{category}/[{collection}/]${WORK_DIR}`;
    default:
      return `{category}/${WORK_DIR}`;
  }
}

export function buildTemplate(type: MediaKind, structure: StructureKey, server: ServerKey): string {
  const s = serverByKey(server);
  const dir = dirOf(structure);
  if (type === "movie") {
    return joinMovie({ dir, file: structure === "keepName" ? "{originalName}.{ext}" : s.movieFile });
  }
  const file = structure === "keepName" ? "{originalName}.{ext}" : s.tvFile.replace("{ABS}", structure === "absolute" ? "[ - {absolute000}]" : "");
  return joinTv({ dir, season: s.tvSeason, file });
}

const norm = (t: string): string => t.trim();

/** 这条模板等于当前服务器下的哪个结构预设；都不等就是自定义（null） */
export function detectStructure(type: MediaKind, template: string, server: ServerKey): StructureKey | null {
  const t = norm(template);
  for (const st of STRUCTURES[type]) if (buildTemplate(type, st.key, server) === t) return st.key;
  return null;
}

export interface ServerFacts {
  idTag: OrganizeIdTagStyle;
  specials: SpecialsStyle;
  extrasDir: string;
  movie: string;
  tv: string;
}

/** 整套设置（id 标签 / 特别篇 / 花絮目录 / 两条模板）正好是某个服务器预设的样子才算命中；否则 null（显示「自定义」） */
export function detectServer(facts: ServerFacts): ServerKey | null {
  for (const s of SERVERS) {
    if (s.idTag !== facts.idTag || s.specials !== facts.specials || s.extrasDir !== facts.extrasDir) continue;
    if (detectStructure("movie", facts.movie, s.key) === null || detectStructure("tv", facts.tv, s.key) === null) continue;
    return s.key;
  }
  return null;
}

/** 和后端 services/organize/settings.ts 里的默认模板一致 */
export const DEFAULT_TEMPLATES = {
  movie: buildTemplate("movie", "default", "emby"),
  tv: buildTemplate("tv", "default", "emby"),
};
