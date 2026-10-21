/**
 * Emby 入库通知：定期问 Emby「最近收了什么新条目」，按剧聚合后发 Telegram。
 *
 * 为什么轮询而不是 Emby Webhook：webhook 要用户去 Emby 里配回调、要在管理端开免鉴权入口，
 * 各版本 payload 还不一样；而 emby.url + apiKey 本来就配好了（302 代理在用），
 * 对局域网 Emby 两分钟一次 /Items 查询可以忽略不计。
 *
 * 循环常驻、不追着设置起停：每一轮先看配置，Emby 没配就什么都不做；通知开关关着也会问一次，
 * 因为同一批条目还顺手给整理的探测缓存回填媒体流（services/media/emby-streams.ts，自己的游标）。
 * refreshEmbyNow 成功后 30 秒会插一轮加急——入库基本都发生在我们触发刷新之后。
 * 游标 = 最新条目的 DateCreated（毫秒）+ 同一时刻的 id 集，落在 settings 表里：
 * 重启不重复报；开关关掉一阵再打开，会把这段时间的入库补报一次（超量时只报总数）。
 */
import axios from "axios";
import { setTimeout as sleep } from "node:timers/promises";
import { readAppSettings } from "../../db/repositories/settings.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { isAbortError, messageOf } from "../../lib/errors.js";
import { DEFAULT_TIMEOUT_MS } from "../../lib/http.js";
import { moduleLogger } from "../../lib/logger.js";
import { createPollingLoop } from "../../lib/polling.js";
import { notify, notifyPrefs, type EmbyNewGroup, type NotifyEvent } from "../notify.js";
import { backfillProbesFromEmby, type EmbyStreamSource } from "../media/emby-streams.js";
import { countMediaStreams, requestPlaybackInfo, type EmbyMediaSource } from "./api.js";
import { listRunningTaskIds } from "../task/registry.js";
import { jobs as organizeJobs } from "../organize/run-state.js";

const log = moduleLogger("emby-new");

const POLL_MS = 120_000;
/** refreshEmbyNow 之后等扫描跑一会儿再看 */
const NUDGE_MS = 30_000;
/** 一页问这么多；一页装不下这轮的新增就往后翻，最多翻这么多页（整季一次入库八十集也得全看到，不然后面的既不预热也不回填） */
const FETCH_LIMIT = 50;
const FETCH_PAGES_MAX = 10;
/** 一轮新增超过这个数就只报总数：库重建、首次挂大目录时别刷屏 */
const FLOOD_LIMIT = 30;

export interface EmbyNewItem {
  id: string;
  /** Emby 的 Type：Episode / Movie / … */
  type: string;
  name: string;
  seriesName?: string;
  season?: number;
  episode?: number;
  year?: number;
  /** DateCreated 解析成毫秒；解析不了的条目直接丢弃 */
  at: number;
  /** 条目的媒体源（Emby 分析过的流，回填探测缓存用）；桩 / 老数据可以没有 */
  sources?: EmbyStreamSource[];
}

interface Cursor {
  at: number;
  /** at 这一毫秒上已经见过的条目 id：同一批入库常常共享同一个 DateCreated */
  ids: string[];
}

/* ------------------------------- 依赖注入 ------------------------------- */

interface Deps {
  /** 按 DateCreated 倒序取最近的条目，从第 startIndex 条起取 limit 条；Emby 未配置时回 null */
  fetch: (limit: number, startIndex: number) => Promise<EmbyNewItem[] | null>;
  /** 按 id 取条目（带媒体源）：入库时还没分析流的条目之后几轮再问；Emby 未配置时回 null */
  fetchByIds: (ids: string[]) => Promise<EmbyNewItem[] | null>;
  notify: (event: NotifyEvent) => Promise<unknown>;
  /** 预热：服务端替播放器问一次 PlaybackInfo，Emby 借此探测 strm 的媒体流并落库。停机时 signal 掐断它 */
  playbackInfo: (id: string, signal?: AbortSignal) => Promise<EmbyMediaSource[]>;
  /** 同步 / 整理在跑：预热让路（它们已经在占网盘和 Emby） */
  busy: () => boolean;
  /** 两次预热之间歇一下，停机时掐断；测试里换成不等 */
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Emby 的一页条目 → 我们的结构；sources 只在要了 MediaSources 时有 */
function toNewItem(it: Record<string, unknown>): EmbyNewItem {
  return {
    id: String(it.Id ?? ""),
    type: String(it.Type ?? ""),
    name: String(it.Name ?? ""),
    seriesName: typeof it.SeriesName === "string" ? it.SeriesName : undefined,
    season: typeof it.ParentIndexNumber === "number" ? it.ParentIndexNumber : undefined,
    episode: typeof it.IndexNumber === "number" ? it.IndexNumber : undefined,
    year: typeof it.ProductionYear === "number" ? it.ProductionYear : undefined,
    at: Date.parse(String(it.DateCreated ?? "")),
    sources: Array.isArray(it.MediaSources)
      ? (it.MediaSources as Array<Record<string, unknown>>)
          .filter((ms) => typeof ms.Path === "string" && ms.Path)
          .map((ms) => ({
            path: ms.Path as string,
            size: typeof ms.Size === "number" ? ms.Size : undefined,
            container: typeof ms.Container === "string" ? ms.Container : undefined,
            streams: Array.isArray(ms.MediaStreams) ? (ms.MediaStreams as Array<Record<string, unknown>>) : [],
          }))
      : undefined,
  };
}

const EMBY_FIELDS = "DateCreated,SeriesName,ParentIndexNumber,IndexNumber,ProductionYear,MediaSources";

function embyBase(): { base: string; apiKey: string } | null {
  const s = readAppSettings();
  if (!s.emby?.url || !s.emby.apiKey) return null;
  return { base: s.emby.url.replace(/\/+$/, ""), apiKey: s.emby.apiKey };
}

async function fetchLatestReal(limit: number, startIndex: number): Promise<EmbyNewItem[] | null> {
  const e = embyBase();
  if (!e) return null;
  const url = `${e.base}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&SortBy=DateCreated&SortOrder=Descending&StartIndex=${startIndex}&Limit=${limit}&Fields=${EMBY_FIELDS}&api_key=${encodeURIComponent(e.apiKey)}`;
  const res = await axios.get<{ Items?: Array<Record<string, unknown>> }>(url, { timeout: DEFAULT_TIMEOUT_MS });
  return (res.data?.Items ?? []).map(toNewItem);
}

async function fetchByIdsReal(ids: string[]): Promise<EmbyNewItem[] | null> {
  const e = embyBase();
  if (!e) return null;
  const out: EmbyNewItem[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const url = `${e.base}/Items?Ids=${encodeURIComponent(ids.slice(i, i + 50).join(","))}&Fields=${EMBY_FIELDS}&api_key=${encodeURIComponent(e.apiKey)}`;
    const res = await axios.get<{ Items?: Array<Record<string, unknown>> }>(url, { timeout: DEFAULT_TIMEOUT_MS });
    out.push(...(res.data?.Items ?? []).map(toNewItem));
  }
  return out;
}

const realDeps: Deps = {
  fetch: fetchLatestReal,
  fetchByIds: fetchByIdsReal,
  notify,
  playbackInfo: (id, signal) => requestPlaybackInfo(id, { signal }),
  busy: () => listRunningTaskIds().length > 0 || organizeJobs.size > 0,
  wait: (ms, signal) => sleep(ms, undefined, { signal }),
};

let deps: Deps = { ...realDeps };

/** 仅供测试：换掉会碰网络的部分；传 null 恢复 */
export function setEmbyNewDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 聚合 ------------------------------- */

/** 按 剧+季（或电影本身）聚合，顺序按这一批里第一次出现的先后 */
export function groupEmbyNewItems(items: EmbyNewItem[]): EmbyNewGroup[] {
  const groups = new Map<string, EmbyNewGroup>();
  for (const it of items) {
    const tv = it.type === "Episode";
    const name = tv ? it.seriesName || it.name : it.name;
    const key = tv ? `tv|${name}|${it.season ?? ""}` : `mv|${name}|${it.year ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { kind: tv ? "tv" : "movie", name, episodes: [], count: 0 };
      if (tv) g.season = it.season;
      else g.year = it.year;
      groups.set(key, g);
    }
    g.count += 1;
    if (tv && it.episode != null && !g.episodes.includes(it.episode)) g.episodes.push(it.episode);
  }
  for (const g of groups.values()) g.episodes.sort((a, b) => a - b);
  return [...groups.values()];
}

/* ------------------------------- 一轮 ------------------------------- */

/** 跑一轮。导出为函数是为了测试直接触发，不用等两分钟。signal 是停机信号：预热会在 Emby 上等几十秒，停机不能等它 */
export async function tickEmbyNew(signal?: AbortSignal): Promise<void> {
  try {
    await runRound(signal);
  } finally {
    lastTickAt = Date.now();
  }
}

/** 入库时 Emby 还没分析流的条目：记下来之后几轮再问。最多记这么多、最多等这么久（Emby 对 strm 要到首次播放才分析） */
const PENDING_MAX = 200;
const PENDING_TTL_MS = 30 * 24 * 3600 * 1000;

interface Pending {
  id: string;
  since: number;
  /** 上次预热（服务端问 PlaybackInfo、Emby 答了）的时间；探测失败的条目隔一天再试一次，不每轮都试 */
  warmedAt?: number;
  /** 上次问 PlaybackInfo 没问成（Emby 没回答：连不上、非 2xx、超时）的时间；过一会儿再试，不按探测失败记一天 */
  failedAt?: number;
}

/** 预热：一轮最多这么多条、每条之间歇这么久——PlaybackInfo 会让 Emby 隔着网盘读文件头，一条就是几秒到几十秒 */
const PREWARM_PER_ROUND = 5;
const PREWARM_GAP_MS = 3_000;
/** 一轮的预热超过这么久就不再开新的（在问的那条问完为止）：这一轮拖太长，下一轮和加急都跟着晚 */
const PREWARM_BUDGET_MS = 60_000;
/** 探测失败（Emby 读不到 strm 指向的位置）的条目多久后再试 */
const PREWARM_RETRY_MS = 24 * 3600 * 1000;
/** Emby 没回答的条目多久后再试 */
const PREWARM_FAIL_RETRY_MS = 10 * 60 * 1000;

const prewarmDue = (p: Pending, now: number): boolean =>
  (!p.warmedAt || now - p.warmedAt >= PREWARM_RETRY_MS) && (!p.failedAt || now - p.failedAt >= PREWARM_FAIL_RETRY_MS);

/**
 * 入库后预热。Emby 对 strm 条目只在被问到 PlaybackInfo 时才探测媒体流（扫库、Refresh 都不探），
 * 不预热的话这几秒到几十秒就全算在首播头上。这里替播放器先问一次：探成功的 Emby 就落库了，
 * 之后真播放不再探；探不到的（Emby 主机读不到 strm 指向的位置）记下时间，隔天再试；
 * Emby 没回答的（连不上、超时）记另一个时间，十分钟后再试——不能按探测失败记一天，那是 Emby 的问题不是条目的。
 * 一次一条、慢慢来：Emby 的探测要真读网盘，和同步 / 整理抢的是同一条带宽，它们在跑时整轮让路。
 * 停机信号一到就停：在问的那条掐断、不记时间，下次启动再问。
 */
async function prewarmRound(pending: Pending[], now: number, signal?: AbortSignal): Promise<void> {
  if (pending.length === 0 || readAppSettings().emby?.prewarm === false) return;
  if (deps.busy()) {
    log.debug("同步 / 整理在跑，这轮不预热");
    return;
  }
  const due = pending.filter((p) => prewarmDue(p, now)).slice(0, PREWARM_PER_ROUND);
  if (due.length === 0) return;
  const started = Date.now();
  let probed = 0;
  let empty = 0;
  let asked = 0;
  let failed: string | null = null;
  for (const [i, p] of due.entries()) {
    if (signal?.aborted) break;
    if (i > 0) {
      if (Date.now() - started > PREWARM_BUDGET_MS) break;
      try {
        await deps.wait(PREWARM_GAP_MS, signal);
      } catch {
        break; // 停机把等待掐断了
      }
    }
    try {
      const streams = countMediaStreams(await deps.playbackInfo(p.id, signal));
      asked += 1;
      p.warmedAt = now;
      delete p.failedAt;
      if (streams > 0) probed += 1;
      else empty += 1;
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) break;
      asked += 1;
      p.failedAt = now;
      failed ??= messageOf(err);
    }
  }
  if (asked === 0) return;
  const parts = [`预热了 ${asked} 个新入库条目的媒体流`];
  if (probed > 0) parts.push(`${probed} 个 Emby 已探测落库`);
  if (empty > 0) parts.push(`${empty} 个 Emby 探测不到（它读不到 strm 指向的位置，明天再试）`);
  if (failed) parts.push(`有条目没问成（十分钟后再试）：${failed}`);
  if (asked < due.length) parts.push(`这轮时间用完，剩下 ${due.length - asked} 个下轮接着`);
  log.info(parts.join("，"));
}

const hasVideoStream = (i: EmbyNewItem): boolean => (i.sources ?? []).some((src) => src.streams.some((st) => st.Type === "Video"));
/** 探过了、有流但没有视频流（纯音频之类）：没东西可回填，不用一直挂在 pending 里每轮问 */
const hasAnyStream = (i: EmbyNewItem): boolean => (i.sources ?? []).some((src) => src.streams.length > 0);

/**
 * 回填探测缓存：自己的游标，和通知开关无关；首轮也回填（存量的最近几十条白送）。
 * Emby 对 strm 条目要到首次播放（PlaybackInfo）才分析流，入库那一刻多半是空的：这些条目记进 pending，之后每轮按 id 再问，
 * 有了流就回填、拿掉；等太久的丢掉
 */
async function backfillRound(sorted: EmbyNewItem[], signal?: AbortSignal): Promise<void> {
  const cursor = readKv<Cursor>(KEY.embyProbeCursor);
  const fresh = cursor ? sorted.filter((i) => i.at > cursor.at || (i.at === cursor.at && !cursor.ids.includes(i.id))) : sorted;
  const newest = sorted[0];
  if (newest) writeKv(KEY.embyProbeCursor, { at: newest.at, ids: sorted.filter((i) => i.at === newest.at).map((i) => i.id) });

  const now = Date.now();
  const pending = (readKv<Pending[]>(KEY.embyProbePending) ?? []).filter((p) => now - p.since < PENDING_TTL_MS);
  const known = new Set(pending.map((p) => p.id));
  const ready = fresh.filter(hasVideoStream);
  for (const i of fresh) if (!hasVideoStream(i) && (i.sources?.length ?? 0) > 0 && !known.has(i.id)) pending.push({ id: i.id, since: now });

  // 先预热再按 id 看：这轮刚探好的同一轮就能回填
  await prewarmRound(pending, now, signal);

  // 之前没分析的：按 id 再看一眼。停机信号到了就只把预热记下的时间落库，别再问
  if (pending.length > 0 && !signal?.aborted) {
    const again = await deps.fetchByIds(pending.map((p) => p.id));
    if (again) {
      const found = new Map(again.map((i) => [i.id, i]));
      for (const p of [...pending]) {
        const i = found.get(p.id);
        if (!i) {
          pending.splice(pending.indexOf(p), 1); // 条目没了（删了 / 重建了）
          continue;
        }
        if (hasVideoStream(i)) {
          ready.push(i);
          pending.splice(pending.indexOf(p), 1);
        } else if (hasAnyStream(i)) {
          pending.splice(pending.indexOf(p), 1);
        }
      }
    }
  }
  writeKv(KEY.embyProbePending, pending.slice(-PENDING_MAX));

  const sources = ready.flatMap((i) => i.sources ?? []);
  if (sources.length === 0) return;
  const r = backfillProbesFromEmby(sources);
  if (r.filled > 0) log.info(`按 Emby 分析过的媒体流回填了 ${r.filled} 个文件的探测缓存${r.kept ? `（${r.kept} 个已有读文件头的结果，不覆盖）` : ""}`);
}

/** 通知：和回填 / 预热无关的一段，先做——预热会在 Emby 上等几十秒，入库通知不该等它 */
function notifyRound(sorted: EmbyNewItem[]): void {
  // 通知开关关着就到此为止；通知的游标会停在关掉那一刻，重新打开时把中间的入库补报一次
  if (!notifyPrefs(readAppSettings()).embyNew) return;
  const newest = sorted[0];
  const cursor = readKv<Cursor>(KEY.embyNewCursor);
  const idsAt = (at: number) => sorted.filter((i) => i.at === at).map((i) => i.id);

  if (!cursor) {
    // 首轮只定位游标：存量不算新增
    writeKv(KEY.embyNewCursor, newest ? { at: newest.at, ids: idsAt(newest.at) } : { at: 0, ids: [] });
    return;
  }

  const fresh = sorted.filter((i) => i.at > cursor.at || (i.at === cursor.at && !cursor.ids.includes(i.id)));
  if (fresh.length === 0) return;
  writeKv(KEY.embyNewCursor, { at: newest.at, ids: idsAt(newest.at) });

  if (fresh.length >= FLOOD_LIMIT) {
    log.info(`Emby 入库 ${fresh.length} 个条目（批量，只报总数）`);
    void deps.notify({ type: "emby-new", groups: [], total: fresh.length }).catch(() => {});
    return;
  }
  const groups = groupEmbyNewItems(fresh);
  log.info(`Emby 入库 ${fresh.length} 个条目：${groups.map((g) => g.name).join("、")}`);
  void deps.notify({ type: "emby-new", groups, total: fresh.length }).catch(() => {});
}

/**
 * 最近的条目：一页装得下就一页；这一页最老的那条还比两个游标（通知的、回填的）都新，说明这轮的新增不止一页，
 * 往后翻，翻到够老或翻满上限为止。还没有游标的首轮只看一页（首轮只定位游标，存量不算新增）。
 * 按 id 去重；一页翻过来没有新的也停（桩或者 Emby 不认 StartIndex 时别空转）
 */
async function fetchRecent(): Promise<EmbyNewItem[] | null> {
  const floor = Math.min(readKv<Cursor>(KEY.embyNewCursor)?.at ?? Infinity, readKv<Cursor>(KEY.embyProbeCursor)?.at ?? Infinity);
  const out: EmbyNewItem[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < FETCH_PAGES_MAX; page++) {
    const items = await deps.fetch(FETCH_LIMIT, page * FETCH_LIMIT);
    if (!items) return page === 0 ? null : out;
    let added = 0;
    for (const i of items) {
      if (!i.id || seen.has(i.id)) continue;
      seen.add(i.id);
      out.push(i);
      added += 1;
    }
    const oldest = items.at(-1);
    if (items.length < FETCH_LIMIT || added === 0 || !Number.isFinite(floor) || !oldest || !(oldest.at > floor)) break;
  }
  return out;
}

async function runRound(signal?: AbortSignal): Promise<void> {
  const items = await fetchRecent();
  if (!items) return;

  const sorted = items.filter((i) => Number.isFinite(i.at) && i.id).sort((a, b) => b.at - a.at);
  notifyRound(sorted);
  await backfillRound(sorted, signal);
}

/* ------------------------------- 循环 ------------------------------- */

let lastTickAt: number | null = null;

const loop = createPollingLoop({
  name: "Emby 入库检查",
  log,
  intervalMs: POLL_MS,
  // 起得早一点：启动后先把游标定好，之后的入库才有对照
  firstDelayMs: 5_000,
  tick: (signal) => tickEmbyNew(signal),
});

export function getEmbyNewWatcherStatus(): { running: boolean; lastTickAt: number | null; lastError: string | null } {
  return { running: loop.running, lastTickAt, lastError: loop.lastError };
}

export function startEmbyNewWatcher(): void {
  loop.start();
}

export async function stopEmbyNewWatcher(): Promise<void> {
  await loop.stop();
}

/**
 * refreshEmbyNow 成功后调：30 秒后插一轮加急，入库延迟从最多 2 分钟压到半分钟。
 * 这半分钟里再来几次只算一次；到点时正有一轮在跑（预热能跑上一分钟）就等它跑完紧接着来一轮，不丢。
 */
export function nudgeEmbyNewWatch(): void {
  loop.nudge(NUDGE_MS);
}

/** 仅供测试：停循环、清游标 */
export async function __test_resetEmbyNew(): Promise<void> {
  await stopEmbyNewWatcher();
  writeKv(KEY.embyNewCursor, null);
  writeKv(KEY.embyProbeCursor, null);
  writeKv(KEY.embyProbePending, null);
  lastTickAt = null;
  loop.noteError(null);
}
