/** 命名模板变量的说明：设置页 / 任务弹框的变量表用；示例值由试算接口回来 */
export interface TemplateVarDoc {
  name: string;
  label: string;
  movie: boolean;
  tv: boolean;
}

export const TEMPLATE_VAR_DOCS: TemplateVarDoc[] = [
  { name: "category", label: "分类目录（按「二级分类」规则算出来，没开分类就没有这层）", movie: true, tv: true },
  { name: "collection", label: "所属系列（TMDB 的 collection），不属于系列就空；推荐写成 [{collection}/]", movie: true, tv: false },
  { name: "title", label: "片名（按 TMDB 语言的译名）", movie: true, tv: true },
  { name: "originalTitle", label: "原名", movie: true, tv: true },
  { name: "enTitle", label: "英文名", movie: true, tv: true },
  { name: "year", label: "年份", movie: true, tv: true },
  { name: "tmdbId", label: "TMDB 编号", movie: true, tv: true },
  { name: "imdbId", label: "IMDb 编号", movie: true, tv: true },
  { name: "idTag", label: "id 标签（按「id 标签写法」生成）", movie: true, tv: true },
  { name: "season", label: "季", movie: false, tv: true },
  { name: "season00", label: "两位季号", movie: false, tv: true },
  { name: "episode", label: "集（多集是 1-2）", movie: false, tv: true },
  { name: "episode00", label: "两位集号（多集是 01-02）", movie: false, tv: true },
  { name: "absolute", label: "绝对集数（全剧连续编号，番剧常用）", movie: false, tv: true },
  { name: "absolute000", label: "三位绝对集数", movie: false, tv: true },
  { name: "episodeTitle", label: "集标题（要开「文件名里写集标题」）", movie: false, tv: true },
  { name: "part", label: "分段（part1 / cd1）", movie: true, tv: true },
  { name: "edition", label: "版本（导演剪辑版、加长版…）", movie: true, tv: false },
  { name: "resolution", label: "清晰度（2160p / 1080p）", movie: true, tv: true },
  { name: "source", label: "来源（WEB-DL / BluRay）", movie: true, tv: true },
  { name: "videoCodec", label: "视频编码（H.265 / AV1）", movie: true, tv: true },
  { name: "audio", label: "音频（DDP / Atmos）", movie: true, tv: true },
  { name: "hdr", label: "HDR 标记（DV / HDR10）", movie: true, tv: true },
  { name: "group", label: "发布组", movie: true, tv: true },
  { name: "originalName", label: "原文件名（不含扩展名）", movie: true, tv: true },
  { name: "ext", label: "扩展名（模板末尾要有 .{ext}）", movie: true, tv: true },
];

export const templateVarsFor = (type: "movie" | "tv"): TemplateVarDoc[] => TEMPLATE_VAR_DOCS.filter((v) => v[type]);
