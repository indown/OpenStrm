/**
 * 海报用的图片地址（背景墙、strm 页网格视图的片架）：外链原样用；本地图片（source === "local"）要带令牌取成 blob
 * 再给 object URL——<img> 带不了 Authorization 头，令牌又不能放进 URL（会落到日志和 referrer 里）。
 *
 *   - 本地图全页同时最多取 2 张：它和接口是同一个源，HTTP/1.1 一个源只开 6 条连接，海报要是把连接占满，
 *     点「执行」、刷新列表都得排在几 MB 的图后面。排队的工夫要它的格子可能已经滚走了：轮到时没人要就不取；
 *   - object URL 按最近使用淘汰，个数和字节数都封顶；正在用的图是钉住的，淘汰不到它，用完（release）才放——
 *     不然 revoke 掉之后窗口一缩放、列重排，新挂上去的 <img> 指着一个没了的 blob，就是一块空白；
 *   - 后端把太大的本地图换成了外链小图（fallback 是本地那张）：先看这个外链的主机连不连得上，连不上退回本地图。
 */
import type { StrmPoster } from "@openstrm/shared";
import type { BackdropPoster } from "@/components/poster-backdrop";
import { api } from "@/lib/api";

const BLOB_CACHE_MAX = 80;
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;
const FETCH_CONCURRENCY = 2;
/** 试一个外链主机连不连得上，最多等这么久 */
const PROBE_TIMEOUT_MS = 8000;

interface CachedBlob {
  url: string;
  bytes: number;
}

/** 按最近使用排，最旧的在前 */
const blobCache = new Map<string, CachedBlob>();
let cachedBytes = 0;
/** object URL → 有几处正用着它 */
const pins = new Map<string, number>();

function pin(url: string): void {
  pins.set(url, (pins.get(url) ?? 0) + 1);
}

function unpin(url: string): void {
  const n = (pins.get(url) ?? 0) - 1;
  if (n > 0) pins.set(url, n);
  else pins.delete(url);
}

/** 超了上限就从最旧的开始放，钉住的跳过（所以可能暂时超一点，等它们换下来再放） */
function trim(): void {
  for (const [key, entry] of blobCache) {
    if (blobCache.size <= BLOB_CACHE_MAX && cachedBytes <= BLOB_CACHE_BYTES) return;
    if (pins.has(entry.url)) continue;
    blobCache.delete(key);
    cachedBytes -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  }
}

/* ------------------------------- 取本地图的队列 ------------------------------- */

let fetching = 0;
const waiting: Array<() => void> = [];

/** 等一个取图的位子。位子是直接递给下一个排队的，不会被后来的插队多占出去 */
async function takeSlot(): Promise<void> {
  if (fetching < FETCH_CONCURRENCY) {
    fetching++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function freeSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else fetching--;
}

/** 正在取（或者排着队）的一张：同一张图几处同时要，只取一次；wanted 是这几处各自「还要不要」 */
interface Pending {
  promise: Promise<CachedBlob | null>;
  wanted: Array<() => boolean>;
}

const inflight = new Map<string, Pending>();

/**
 * 取一张本地图（命中缓存就挪到最新）。返回的 object URL 已经钉住，用完要 unpin；
 * 排到的时候已经没人要了（alive 都是 false）回 null。取不到会抛
 */
async function localImage(taskId: string, rel: string, alive: () => boolean): Promise<string | null> {
  const key = JSON.stringify([taskId, rel]);
  const hit = blobCache.get(key);
  if (hit) {
    blobCache.delete(key);
    blobCache.set(key, hit);
    pin(hit.url);
    return hit.url;
  }
  let pending = inflight.get(key);
  if (pending) {
    pending.wanted.push(alive);
  } else {
    const wanted = [alive];
    const promise = (async () => {
      await takeSlot();
      try {
        if (!wanted.some((w) => w())) return null;
        const blob = await api.strm.image(taskId, rel);
        const entry = { url: URL.createObjectURL(blob), bytes: blob.size };
        blobCache.set(key, entry);
        cachedBytes += entry.bytes;
        // 先替等着的几处钉一下：它们要到下一个微任务才各自钉上，中间别处一 trim 就把这张刚取的放掉了
        pin(entry.url);
        window.setTimeout(() => {
          unpin(entry.url);
          trim();
        }, 0);
        return entry;
      } finally {
        inflight.delete(key);
        freeSlot();
      }
    })();
    pending = { promise, wanted };
    inflight.set(key, pending);
  }
  const entry = await pending.promise;
  if (!entry) return null;
  pin(entry.url);
  return entry.url;
}

/* ------------------------------- 外链连不连得上 ------------------------------- */

/** 每个外链主机只试一次：连得上就都用外链，连不上就都退回本地图 */
const hostVerdicts = new Map<string, Promise<boolean>>();

function reachable(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return Promise.resolve(false);
  }
  let verdict = hostVerdicts.get(host);
  if (!verdict) {
    verdict = new Promise<boolean>((resolve) => {
      const img = new Image();
      const settle = (ok: boolean) => {
        window.clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve(ok);
      };
      const timer = window.setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
      img.onload = () => settle(true);
      img.onerror = () => settle(false);
      img.src = url;
    });
    hostVerdicts.set(host, verdict);
  }
  return verdict;
}

/* ------------------------------- 单张 ------------------------------- */

/** 要显示的一张海报：接口给的那几个字段就够 */
export type PosterSource = Pick<StrmPoster, "source" | "url" | "fallback">;

/** 能直接给 <img> 的地址；用完调 release（本地图解钉，外链什么都不做） */
export interface HeldImage {
  url: string;
  release: () => void;
}

const NOOP = () => {};

/**
 * 一张海报换成能直接用的地址：外链没有本地后备就直接用，有后备的先看主机连不连得上；本地图取成 blob 并钉住。
 * 拿不到（读不到、alive 已经是 false）回 null，不抛——少一张图而已
 */
export async function holdPoster(taskId: string, poster: PosterSource, alive: () => boolean): Promise<HeldImage | null> {
  const local = poster.source === "local" ? poster.url : poster.fallback;
  try {
    if (poster.source !== "local" && (!local || (await reachable(poster.url)))) return { url: poster.url, release: NOOP };
    if (!local || !alive()) return null;
    const url = await localImage(taskId, local, alive);
    if (!url) return null;
    let released = false;
    return {
      url,
      release: () => {
        if (released) return;
        released = true;
        unpin(url);
        trim();
      },
    };
  } catch {
    return null;
  }
}

/* ------------------------------- 一批（背景墙） ------------------------------- */

export interface PosterToShow {
  /** 墙上这一块的键，一般是目录路径 */
  key: string;
  taskId: string;
  poster: PosterSource;
}

/** 墙上显示的一批：posters 直接给 <img>；release 把其中的本地图解钉，换下来或者卸载时调一次 */
export interface ShownPosters {
  posters: BackdropPoster[];
  release: () => void;
}

export const NO_POSTERS: ShownPosters = { posters: [], release: () => {} };

/**
 * 换成墙上能直接用的地址，顺序不变；读不到的那张就少一张。
 * alive() 变成 false（组件卸了、换了目录）就不再发新的请求；这时候返回的这批没人要，调用方直接 release。
 */
export async function toBackdropPosters(items: PosterToShow[], alive: () => boolean): Promise<ShownPosters> {
  const out: Array<BackdropPoster | null> = items.map(() => null);
  const held: HeldImage[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length && alive()) {
      const i = next++;
      const { key, taskId, poster } = items[i];
      const image = await holdPoster(taskId, poster, alive);
      if (!image) continue;
      held.push(image);
      out[i] = { key, url: image.url };
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, worker));
  // 这一批已经钉住了，超出上限的只会从别处淘汰
  trim();
  let released = false;
  return {
    posters: out.filter((p): p is BackdropPoster => p !== null),
    release: () => {
      if (released) return;
      released = true;
      for (const image of held) image.release();
    },
  };
}
