/** 和后端 services/organize/settings.ts 里的默认模板一致；设置页输入框的占位、预设都从这来（放在 lib 里，别和页面组件互相引用） */
export const DEFAULT_TEMPLATES = {
  movie: "{category}/{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}",
  tv: "{category}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {episodeTitle}].{ext}",
};

/** 命名模板预设：设置页和任务弹框都能一键套用；大多数用户要的写法其实现在就能写，缺的是看见 */
export interface TemplatePreset {
  key: string;
  label: string;
  hint: string;
  movie: string;
  tv: string;
}

export const TEMPLATE_PRESETS: TemplatePreset[] = [
  { key: "default", label: "默认（Emby / Jellyfin）", hint: "作品目录带年份和 id 标签，剧集按 Season 分目录", movie: DEFAULT_TEMPLATES.movie, tv: DEFAULT_TEMPLATES.tv },
  {
    key: "year-dir",
    label: "按年份分目录",
    hint: "作品目录上面多一层年份：2024/沙丘：第二部 (2024) [tmdbid=…]/…",
    movie: "{category}/{year}/{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}",
    tv: "{category}/{year}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {episodeTitle}].{ext}",
  },
  {
    key: "collection",
    label: "电影按系列归档",
    hint: "同一系列的电影放进系列目录：沙丘（系列）/沙丘：第二部 (2024) [tmdbid=…]/…；不属于系列的照常",
    movie: "{category}/[{collection}/]{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}",
    tv: DEFAULT_TEMPLATES.tv,
  },
  {
    key: "absolute",
    label: "动画：文件名带绝对集数",
    hint: "番剧常按总集数编号：S02E05 后面再跟 - 030，播放器和字幕组的编号都对得上",
    movie: DEFAULT_TEMPLATES.movie,
    tv: "{category}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {absolute000}][ - {episodeTitle}].{ext}",
  },
  {
    key: "plex",
    label: "Plex 风格",
    hint: "文件名也带年份、小写 s01e01；配合「id 标签写法」选 Plex",
    movie: "{category}/{title} ({year}) {idTag}/{title} ({year})[ - {edition}].{ext}",
    tv: "{category}/{title} ({year}) {idTag}/Season {season00}/{title} ({year}) - s{season00}e{episode00}[ - {episodeTitle}].{ext}",
  },
  {
    key: "keep-name",
    label: "只归目录，文件名保留原名",
    hint: "作品目录和季目录照规范建，文件名原样不动：只想把散落的文件归位、不想动发布组命名时用",
    movie: "{category}/{title} ({year}) {idTag}/{originalName}.{ext}",
    tv: "{category}/{title} ({year}) {idTag}/Season {season00}/{originalName}.{ext}",
  },
];
