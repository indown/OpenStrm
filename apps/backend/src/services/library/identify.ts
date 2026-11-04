/**
 * 影库的识别工人：作品单元一个一个交给整理的 identifyUnit（目录名里的 tmdbid 标签、识别词直指、标题 + 年份打分）。
 * TMDB 客户端两层缓存 + 全局节流（services/tmdb.ts，和整理共用一条时间线），同名的第二次不花请求。
 *
 *   - 没配 TMDB：单元停在待认，工人歇着；设置里配上以后 kickIdentify 接着认
 *   - TMDB 一时出错（429、5xx、断网）：这个单元过一阵再认，整个工人歇一分钟
 *   - 令牌不对（401 这类换多少次都一样的）：整个工人停一小时
 *   - 认出来的正式名 / 原名 / 英文名 / 别名归一化后写进单元的 aka，再写到根节点给搜索用
 */
import type { OrganizeMatch } from "@openstrm/shared";
import * as units from "../../db/repositories/library-units.js";
import * as nodes from "../../db/repositories/library-nodes.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { isAbortError, messageOf } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { identifyUnit, idTagFromName, TmdbClient, type TmdbApi } from "../organize/identify.js";
import { applyRules, parseRules } from "../organize/rules.js";
import { normalizeTitle } from "../organize/parse-name.js";
import { resolveOrganizeSettings } from "../organize/settings.js";
import type { Unit } from "../organize/units.js";
import { tmdbRetryable } from "../tmdb.js";
import { normalizeForSearch } from "./search-text.js";
import { rebuildUnitsIfStale, syncAka } from "./units.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { getAll } from "../../db/repositories/media-library.js";
import { KEY } from "../../db/keys.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";

const log = moduleLogger("library-identify");

/** aka 最长多少字：别名多的剧能有几十个译名 */
const AKA_MAX = 2000;

interface Deps {
  now: () => number;
  /** 当前设置下的 TMDB 客户端；没配是 null */
  tmdb: () => TmdbApi | null;
  /** 一时出错：这个单元多久以后再认、整个工人歇多久（秒） */
  retryUnitS: number;
  pauseS: number;
  /** 令牌不对：整个工人停多久（秒） */
  authPauseS: number;
}

let cachedClient: { key: string; client: TmdbClient } | null = null;

const realDeps: Deps = {
  now: () => Math.floor(Date.now() / 1000),
  tmdb: () => {
    const s = readAppSettings();
    const apiKey = s.tmdb?.apiKey?.trim();
    if (!apiKey) return null;
    const language = s.tmdb?.language || "zh-CN";
    const key = `${apiKey}\n${language}`;
    // 客户端带进程内缓存：设置没变就一直用这一个
    if (cachedClient?.key !== key) cachedClient = { key, client: new TmdbClient(apiKey, language) };
    return cachedClient.client;
  },
  retryUnitS: 10 * 60,
  pauseS: 60,
  authPauseS: 3600,
};
let deps: Deps = { ...realDeps };

export function setIdentifyDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...deps, ...partial } : { ...realDeps };
}

/** 认出来的所有名字，归一化去重，| 连着（和 search_text 的段一个写法） */
export function akaOf(names: Array<string | undefined>): string {
  const out: string[] = [];
  for (const n of names) {
    const v = normalizeForSearch(n ?? "");
    if (v && !out.includes(v)) out.push(v);
  }
  let s = "";
  for (const v of out) {
    if (s.length + v.length + 1 > AKA_MAX) break;
    s = s ? `${s}|${v}` : v;
  }
  return s;
}

/**
 * 影库自己的一条：标题互相包含、年份又对上的算「中」（「侏罗纪公园1」→《侏罗纪公园》1993、「九龙城寨」→《九龙城寨之围城》2024）。
 * 整理那边的把握不动（它按把握决定要不要直接执行）
 */
export function adjustConfidence(m: OrganizeMatch, titles: string[], year: string): OrganizeMatch {
  if (m.confidence !== "low" || !year || m.year !== year) return m;
  // 短的那边至少 3 个字、占长的一半以上：「漫威」包含在《漫威崛起：秘密勇士》里不算
  const near2 = (a: string, b: string) => {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= 3 && short.length * 2 >= long.length && long.includes(short);
  };
  const names = [m.title, m.originalTitle, m.enTitle ?? ""].map(normalizeTitle).filter(Boolean);
  const near = titles.map(normalizeTitle).some((t) => names.some((n) => near2(t, n)));
  return near ? { ...m, confidence: "medium", reason: "标题相近、年份对上" } : m;
}

/** 认一个单元，存结果、写 aka */
async function identifyOne(u: units.UnitRow, tmdb: TmdbApi): Promise<OrganizeMatch | null> {
  const rules = parseRules(resolveOrganizeSettings(readAppSettings()).rules).rules;
  const titles = u.parsedTitles.length > 0 ? u.parsedTitles : [u.parsedTitle].filter(Boolean);
  const unit: Unit = {
    key: u.unitKey,
    rootPath: u.path,
    rawName: u.rawName,
    parsed: { title: u.parsedTitle, titles, ...(u.parsedYear ? { year: u.parsedYear } : {}), tags: {} },
    kindHint: u.kindHint,
    files: [],
    direct: applyRules(u.rawName, rules).direct,
    ownsDir: u.ownsDir,
  };
  const r = await identifyUnit({ unit, evidence: { known: idTagFromName(u.rawName, u.kindHint) }, episodeTitles: false, maxTitles: 5, strictStop: true }, tmdb);
  const m = r.match ? adjustConfidence(r.match, titles, u.parsedYear) : null;
  let aka = "";
  let details: units.UnitDetails | undefined;
  if (m) {
    // 别名、类型、国家 / 地区在详情里（有缓存，不多花请求）
    const d = await tmdb.details(m.mediaType, m.tmdbId);
    aka = akaOf([m.title, m.originalTitle, m.enTitle, ...(d?.aliases ?? [])]);
    if (d) details = detailsOf(d);
  }
  units.saveIdentified(
    u.sourceId,
    u.unitKey,
    {
      status: "done",
      tmdbId: m?.tmdbId ?? null,
      mediaType: m?.mediaType ?? null,
      title: m?.title ?? "",
      originalTitle: m?.originalTitle ?? "",
      enTitle: m?.enTitle ?? "",
      year: m?.year ?? "",
      posterUrl: m?.posterUrl ?? "",
      confidence: m?.confidence ?? "none",
      reason: m?.reason ?? (titles.length ? "TMDB 上没搜到" : "名字里没有片名"),
      candidates: m?.candidates ?? [],
      aka,
      details,
    },
    deps.now(),
  );
  applyAka(u.sourceId, u.unitKey);
  return m;
}

const detailsOf = (d: { genreIds: number[]; countries: string[]; originalLanguage: string }): units.UnitDetails => ({
  genres: d.genreIds,
  countries: d.countries,
  originalLanguage: d.originalLanguage,
});

/**
 * 以前认出来的补类型、国家 / 地区（识别工人闲下来时一个一个补，不重认）。详情多半有缓存；
 * TMDB 上没了的记成空的，别一直补
 */
async function backfillDetails(u: units.UnitRow, tmdb: TmdbApi): Promise<void> {
  const d = await tmdb.details(u.mediaType!, u.tmdbId!);
  units.saveDetails(u.sourceId, u.unitKey, d ? detailsOf(d) : { genres: [], countries: [], originalLanguage: "" });
}

/** 一个单元的 aka 写到根节点：自己的目录，或者整个来源就这一部 */
export function applyAka(sourceId: string, unitKey: string): void {
  const u = units.getUnit(sourceId, unitKey);
  if (!u) return;
  // 按标题拆出来的（分类目录里散放的几部）不是自己的目录，不写：搜片名不该搜到整个分类
  if (!u.ownsDir && units.countActiveUnits(sourceId) !== 1) return;
  nodes.setAka(sourceId, u.nodeId, u.status === "ignored" ? "" : u.aka);
}

/* ------------------------------- 手动 ------------------------------- */

/** 换匹配：手动指定 TMDB 上的哪一部。以后重切单元也保留，不会被自动识别盖掉 */
export async function matchUnit(sourceId: string, unitKey: string, mediaType: "movie" | "tv", tmdbId: number): Promise<units.UnitRow> {
  const u = units.getUnit(sourceId, unitKey);
  if (!u) throw new HttpError(404, "这个作品单元不在了（分享重新抄过？）：刷新一下再试");
  const tmdb = deps.tmdb();
  if (!tmdb) throw new HttpError(400, "TMDB 未配置：先到设置页填入 API Key");
  let d;
  try {
    d = await tmdb.details(mediaType, tmdbId);
  } catch (err) {
    throw upstreamError(`TMDB 请求失败：${messageOf(err)}`);
  }
  if (!d) throw new HttpError(404, `TMDB 上没有编号 ${tmdbId} 的${mediaType === "movie" ? "电影" : "剧集"}`);
  units.saveIdentified(
    sourceId,
    unitKey,
    {
      status: "manual",
      tmdbId: d.id,
      mediaType,
      title: d.title || d.originalTitle,
      originalTitle: d.originalTitle,
      enTitle: d.enTitle,
      year: d.year,
      posterUrl: d.posterUrl,
      confidence: "high",
      reason: "手动指定",
      candidates: u.candidates,
      aka: akaOf([d.title, d.originalTitle, d.enTitle, ...d.aliases]),
      details: detailsOf(d),
    },
    deps.now(),
  );
  applyAka(sourceId, unitKey);
  return units.getUnit(sourceId, unitKey)!;
}

/** 不是影视（花絮合集、字幕包、软件……）：不再认，海报墙不出 */
export function ignoreUnit(sourceId: string, unitKey: string): void {
  if (!units.getUnit(sourceId, unitKey)) throw new HttpError(404, "这个作品单元不在了（分享重新抄过？）：刷新一下再试");
  units.ignoreUnit(sourceId, unitKey, deps.now());
  applyAka(sourceId, unitKey);
}

/** 重新认一个单元（手动指定的、忽略的也放掉） */
export function reidentifyUnit(sourceId: string, unitKey: string): void {
  if (!units.getUnit(sourceId, unitKey)) throw new HttpError(404, "这个作品单元不在了（分享重新抄过？）：刷新一下再试");
  units.resetUnit(sourceId, unitKey);
  applyAka(sourceId, unitKey);
  kickIdentify();
}

/** 一个来源重新认：手动指定的、忽略的不动（改了识别词以后用） */
export function reidentifySource(sourceId: string): number {
  // 一条 UPDATE 放回去：几千个单元逐个放，每个都让海报墙视图增量重查一遍，不如整个作废一次
  const n = units.resetDoneUnits(sourceId);
  syncAka(sourceId);
  kickIdentify();
  return n;
}

/* ------------------------------- 工人 ------------------------------- */

let started = false;
let looping = false;
let again = false;
let wake: NodeJS.Timeout | null = null;
let pausedUntil = 0;
let idleWaiters: Array<() => void> = [];

function scheduleWake(afterS: number): void {
  if (wake) clearTimeout(wake);
  wake = setTimeout(
    () => {
      wake = null;
      void loop();
    },
    Math.max(1, afterS) * 1000,
  );
  wake.unref?.();
}

async function loop(): Promise<void> {
  if (looping) {
    again = true;
    return;
  }
  looping = true;
  try {
    for (;;) {
      if (!started) break;
      const now = deps.now();
      if (pausedUntil > now) {
        scheduleWake(pausedUntil - now);
        break;
      }
      const tmdb = deps.tmdb();
      if (!tmdb) break;
      const u = units.nextPendingUnit(now);
      if (!u) {
        // 没有要认的：以前认出来的补类型、国家 / 地区；一时出错就歇一会儿，别的错记成空的跳过
        const missing = units.nextMissingDetails();
        if (missing) {
          try {
            await backfillDetails(missing, tmdb);
          } catch (err) {
            if (isAbortError(err)) break;
            if (tmdbRetryable(err) || isAxiosLike(err)) {
              pausedUntil = now + (tmdbRetryable(err) ? deps.pauseS : deps.authPauseS);
              log.warn({ unit: missing.path, err: messageOf(err).slice(0, 200) }, "补类型时 TMDB 出错，过一阵再补");
            } else {
              units.saveDetails(missing.sourceId, missing.unitKey, { genres: [], countries: [], originalLanguage: "" });
              log.error({ err, unit: missing.path }, "补类型出错，跳过这一个");
            }
          }
          continue;
        }
        const at = units.nextUnitRetryAt();
        if (at !== null) scheduleWake(at - now);
        break;
      }
      try {
        await identifyOne(u, tmdb);
      } catch (err) {
        if (isAbortError(err)) break;
        const reason = messageOf(err).slice(0, 200);
        if (tmdbRetryable(err)) {
          units.setUnitRetry(u.sourceId, u.unitKey, now + deps.retryUnitS, reason);
          pausedUntil = now + deps.pauseS;
          log.warn({ unit: u.path, err: reason }, "TMDB 一时出错，这个单元过一阵再认");
        } else if (isAxiosLike(err)) {
          // 401 / 403 这类：令牌不对，换多少个单元都一样
          units.setUnitRetry(u.sourceId, u.unitKey, now + deps.authPauseS, reason);
          pausedUntil = now + deps.authPauseS;
          log.warn({ err: reason }, "TMDB 拒绝了请求（令牌不对？），收藏夹识别停一小时");
        } else {
          // 代码里的意外：这个单元记下原因、跳过，别卡住后面的
          units.setUnitRetry(u.sourceId, u.unitKey, now + deps.authPauseS, reason);
          log.error({ err, unit: u.path }, "收藏夹识别出错");
        }
      }
    }
  } finally {
    looping = false;
    if (again) {
      again = false;
      void loop();
    } else {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  }
}

function isAxiosLike(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { isAxiosError?: boolean }).isAxiosError === true;
}

/** 有新单元、TMDB 刚配上、手动重认：马上开认 */
export function kickIdentify(): void {
  if (!started) return;
  pausedUntil = 0;
  void loop();
}

/** 识别规则的版本：打分 / 候选的口径改了加一，启动时自动认的都重认（手动的、忽略的不动）。2 = 标题相近 + 年份对上算「中」；3 = 搜前 5 个候选；4 = 标题一样还要年份对上才停、「相近」卡严；5 = 年份差一年也算对上；6 = 停搜又要年份一样，中文名英文名都对上的加分、分数咬得紧时挑热门得多的那部，第一个候选对上冒号前的主标题也算对上 */
export const IDENTIFY_VERSION = 6;

export function reidentifyAllIfStale(): number {
  if (readKv<number>(KEY.libraryIdentifyVersion) === IDENTIFY_VERSION) return 0;
  const n = units.resetAutoIdentified();
  // 放回待认的名字清掉了：节点上的 aka 跟着清（认回来再写），不然没认出来的还能靠旧名字搜到
  if (n > 0) for (const src of getAll()) syncAka(src.id);
  writeKv(KEY.libraryIdentifyVersion, IDENTIFY_VERSION);
  if (n > 0) log.info({ units: n, version: IDENTIFY_VERSION }, "收藏夹识别规则更新了，自动认的作品重新认");
  return n;
}

/** 启动：先补切单元（升级上来的、规则变了的），识别规则变了的放回去重认，再开认 */
export function startLibraryIdentify(): void {
  rebuildUnitsIfStale();
  reidentifyAllIfStale();
  started = true;
  void loop();
}

export function stopLibraryIdentify(): void {
  started = false;
  if (wake) clearTimeout(wake);
  wake = null;
  pausedUntil = 0;
}

/** 仅供测试：等工人闲下来 */
export function __test_whenIdle(): Promise<void> {
  if (!looping) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}
