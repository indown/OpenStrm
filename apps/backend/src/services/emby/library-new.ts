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
import { readAppSettings } from "../../db/repositories/settings.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { DEFAULT_TIMEOUT_MS } from "../../lib/http.js";
import { moduleLogger } from "../../lib/logger.js";
import { createPollingLoop } from "../../lib/polling.js";
import { notify, notifyPrefs, type EmbyNewGroup, type NotifyEvent } from "../notify.js";
import { backfillProbesFromEmby, type EmbyStreamSource } from "../media/emby-streams.js";

const log = moduleLogger("emby-new");

const POLL_MS = 120_000;
/** refreshEmbyNow 之后等扫描跑一会儿再看 */
const NUDGE_MS = 30_000;
const FETCH_LIMIT = 50;
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
  /** 按 DateCreated 倒序取最近的条目；Emby 未配置时回 null */
  fetch: (limit: number) => Promise<EmbyNewItem[] | null>;
  /** 按 id 取条目（带媒体源）：入库时还没分析流的条目之后几轮再问；Emby 未配置时回 null */
  fetchByIds: (ids: string[]) => Promise<EmbyNewItem[] | null>;
  notify: (event: NotifyEvent) => Promise<unknown>;
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

async function fetchLatestReal(limit: number): Promise<EmbyNewItem[] | null> {
  const e = embyBase();
  if (!e) return null;
  const url = `${e.base}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&SortBy=DateCreated&SortOrder=Descending&Limit=${limit}&Fields=${EMBY_FIELDS}&api_key=${encodeURIComponent(e.apiKey)}`;
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

const realDeps: Deps = { fetch: fetchLatestReal, fetchByIds: fetchByIdsReal, notify };

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

/** 跑一轮。导出为函数是为了测试直接触发，不用等两分钟 */
export async function tickEmbyNew(): Promise<void> {
  try {
    await runRound();
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
}

const hasVideoStream = (i: EmbyNewItem): boolean => (i.sources ?? []).some((src) => src.streams.some((st) => st.Type === "Video"));

/**
 * 回填探测缓存：自己的游标，和通知开关无关；首轮也回填（存量的最近几十条白送）。
 * Emby 对 strm 条目要到首次播放（PlaybackInfo）才分析流，入库那一刻多半是空的：这些条目记进 pending，之后每轮按 id 再问，
 * 有了流就回填、拿掉；等太久的丢掉
 */
async function backfillRound(sorted: EmbyNewItem[]): Promise<void> {
  const cursor = readKv<Cursor>(KEY.embyProbeCursor);
  const fresh = cursor ? sorted.filter((i) => i.at > cursor.at || (i.at === cursor.at && !cursor.ids.includes(i.id))) : sorted;
  const newest = sorted[0];
  if (newest) writeKv(KEY.embyProbeCursor, { at: newest.at, ids: sorted.filter((i) => i.at === newest.at).map((i) => i.id) });

  const now = Date.now();
  const pending = (readKv<Pending[]>(KEY.embyProbePending) ?? []).filter((p) => now - p.since < PENDING_TTL_MS);
  const known = new Set(pending.map((p) => p.id));
  const ready = fresh.filter(hasVideoStream);
  for (const i of fresh) if (!hasVideoStream(i) && (i.sources?.length ?? 0) > 0 && !known.has(i.id)) pending.push({ id: i.id, since: now });

  // 之前没分析的：按 id 再看一眼
  if (pending.length > 0) {
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

async function runRound(): Promise<void> {
  const items = await deps.fetch(FETCH_LIMIT);
  if (!items) return;

  const sorted = items.filter((i) => Number.isFinite(i.at) && i.id).sort((a, b) => b.at - a.at);
  await backfillRound(sorted);
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

/* ------------------------------- 循环 ------------------------------- */

let lastTickAt: number | null = null;

const loop = createPollingLoop({
  name: "Emby 入库检查",
  log,
  intervalMs: POLL_MS,
  // 起得早一点：启动后先把游标定好，之后的入库才有对照
  firstDelayMs: 5_000,
  tick: tickEmbyNew,
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
 * 这半分钟里再来几次只算一次；撞上正在跑的那一轮就跳过（exhaustMap 管着）。
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
