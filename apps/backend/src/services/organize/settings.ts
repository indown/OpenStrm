/**
 * 整理设置的默认值与归一化。设置存在 app.organize（settings 表），任务上的 organize 覆盖自动整理策略、命名模板、id 标签、集标题。
 */
import type { AppSettings, OrganizeCategoryRule, OrganizeCategorySettings, OrganizeSettings, TaskDefinition } from "@openstrm/shared";

export const DEFAULT_TEMPLATES = {
  movie: "{category}/{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}",
  tv: "{category}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {episodeTitle}].{ext}",
} as const;

/** TMDB genre id：16 动画、99 纪录片、10764 真人秀、10767 脱口秀、10762 儿童 */
export const DEFAULT_CATEGORIES: Required<OrganizeCategorySettings> = {
  enabled: false,
  movie: [
    { name: "动画电影", genreIds: [16] },
    { name: "纪录片", genreIds: [99] },
    { name: "华语电影", languages: ["zh", "cn", "bo", "za"] },
    { name: "日韩电影", languages: ["ja", "ko"] },
    { name: "外语电影" },
  ],
  tv: [
    { name: "国漫", genreIds: [16], countries: ["CN", "TW", "HK"] },
    { name: "日番", genreIds: [16], countries: ["JP"] },
    { name: "动画", genreIds: [16] },
    { name: "纪录片", genreIds: [99] },
    { name: "综艺", genreIds: [10764, 10767] },
    { name: "国产剧", countries: ["CN", "TW", "HK"] },
    { name: "日韩剧", countries: ["JP", "KR"] },
    { name: "欧美剧" },
  ],
};

export interface ResolvedOrganizeSettings {
  templates: { movie: string; tv: string };
  idTag: NonNullable<OrganizeSettings["idTag"]>;
  colon: NonNullable<OrganizeSettings["colon"]>;
  episodeTitle: boolean;
  categories: Required<OrganizeCategorySettings>;
  rules: string[];
  cleanupEmptyDirs: boolean;
  extras: NonNullable<OrganizeSettings["extras"]>;
  auto: NonNullable<OrganizeSettings["auto"]>;
  probe: NonNullable<OrganizeSettings["probe"]>;
  specials: NonNullable<OrganizeSettings["specials"]>;
  /** 花絮子目录名（不带斜杠，默认 extras） */
  extrasDir: string;
}

export const DEFAULT_EXTRAS_DIR = "extras";

/** 花絮目录名：去掉首尾空白和斜杠，空的用默认 */
export function cleanExtrasDir(v: string | undefined): string {
  const name = (v ?? "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  return name || DEFAULT_EXTRAS_DIR;
}

function cleanRules(list: OrganizeCategoryRule[] | undefined, fallback: OrganizeCategoryRule[]): OrganizeCategoryRule[] {
  if (!Array.isArray(list)) return fallback;
  const out = list
    .filter((r) => r && typeof r.name === "string" && r.name.trim())
    .map((r) => ({
      name: r.name.trim(),
      ...(r.genreIds?.length ? { genreIds: r.genreIds.map(Number).filter((n) => Number.isFinite(n)) } : {}),
      ...(r.countries?.length ? { countries: r.countries.map((c) => String(c).trim().toUpperCase()).filter(Boolean) } : {}),
      ...(r.languages?.length ? { languages: r.languages.map((c) => String(c).trim().toLowerCase()).filter(Boolean) } : {}),
    }));
  return out;
}

/**
 * 全局设置归一；给了 task 就套上任务自己的命名设定（模板 / id 标签 / 集标题，留空的沿用全局）。
 * 分类、识别词、冒号、花絮这些仍是全局的
 */
export function resolveOrganizeSettings(settings: AppSettings, task?: Pick<TaskDefinition, "organize"> | null): ResolvedOrganizeSettings {
  const o = settings.organize ?? {};
  const t = task?.organize ?? {};
  return {
    templates: {
      movie: t.templates?.movie?.trim() || o.templates?.movie?.trim() || DEFAULT_TEMPLATES.movie,
      tv: t.templates?.tv?.trim() || o.templates?.tv?.trim() || DEFAULT_TEMPLATES.tv,
    },
    idTag: t.idTag ?? o.idTag ?? "emby",
    colon: o.colon ?? "smart",
    episodeTitle: (t.episodeTitle ?? o.episodeTitle) === true,
    categories: {
      enabled: o.categories?.enabled === true,
      movie: cleanRules(o.categories?.movie, DEFAULT_CATEGORIES.movie),
      tv: cleanRules(o.categories?.tv, DEFAULT_CATEGORIES.tv),
    },
    rules: Array.isArray(o.rules) ? o.rules.filter((r): r is string => typeof r === "string") : [],
    cleanupEmptyDirs: o.cleanupEmptyDirs !== false,
    // 没设过就跟着正片走：留在旧目录的花絮以后成不了单元，没人再管，还让旧目录删不掉
    extras: o.extras ?? "move",
    auto: o.auto ?? "off",
    probe: o.probe ?? "off",
    specials: o.specials === "specials" ? "specials" : "season00",
    extrasDir: cleanExtrasDir(o.extrasDir),
  };
}

/** 任务的自动整理策略：任务上没设就用全局默认 */
export function taskAutoMode(task: TaskDefinition, settings: AppSettings): NonNullable<OrganizeSettings["auto"]> {
  return task.organize?.mode ?? resolveOrganizeSettings(settings).auto;
}

/** 判分类：全部给出的条件都至少命中一个；没条件的是兜底 */
export function pickCategory(
  rules: OrganizeCategoryRule[],
  facts: { genreIds?: number[]; countries?: string[]; originalLanguage?: string },
): string {
  for (const r of rules) {
    if (r.genreIds?.length && !r.genreIds.some((g) => facts.genreIds?.includes(g))) continue;
    if (r.countries?.length && !r.countries.some((c) => facts.countries?.map((x) => x.toUpperCase()).includes(c.toUpperCase()))) continue;
    if (r.languages?.length && !(facts.originalLanguage && r.languages.map((l) => l.toLowerCase()).includes(facts.originalLanguage.toLowerCase()))) continue;
    return r.name;
  }
  return "";
}
