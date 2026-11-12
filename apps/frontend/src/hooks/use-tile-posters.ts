"use client";

/**
 * strm 页网格视图的海报：每个目录格子一张。
 *
 * 和背景墙不一样，这里的目录可能上千个，不能一口气全问：
 *   - 格子进了视口附近才把自己排进队列（want）；队列按任务凑批，最近进来的先问——人已经滚到那儿了；
 *   - 先发离线的一遍（本地图 / 详情缓存 / 整理记录），有的立刻上；回包里的 pending 再分小批联网补，
 *     一个目录要问 TMDB 一两次，小批补到的先上，不让一屏的图都等最慢的那个；
 *   - 哪一批回 unreachable（TMDB 连不上）就不再联网问，直到目录重新列出来：不然每一批都要白等一回超时；
 *   - 请求都带 compact：太大的本地图换成外链小图，一屏二十几张不拉原图。
 *
 * 图片本身在 useHeldImage：也是进了视口附近才取，离开就解钉，缓存照 lib/poster-images.ts 的上限淘汰。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StrmPoster, StrmPosterResult } from "@openstrm/shared";
import { api } from "@/lib/api";
import { holdPoster, type HeldImage, type PosterSource } from "@/lib/poster-images";
import type { StrmRef } from "@/lib/strm-entries";

/** 一个目录格子：key 是页面上认这一行的键（refKey） */
export interface TileRef extends StrmRef {
  key: string;
}

/** 离线那一遍一批问多少个目录（后端一次最多 48 个） */
const CHUNK = 48;
/** 联网那一遍一批问多少个 */
const ONLINE_CHUNK = 12;

const NONE: ReadonlyMap<string, StrmPoster> = new Map();

interface Work {
  /** 目录重新列出来就加一：在飞的那一批回来对不上号，结果作废 */
  gen: number;
  asked: Set<string>;
  queue: TileRef[];
  online: TileRef[];
  busy: boolean;
  onlineBusy: boolean;
  /** TMDB 连不上：这一轮不再联网问 */
  down: boolean;
  scheduled: boolean;
}

export interface TilePosters {
  /** 行键 → 海报；没拿到的、还没问到的都不在里面 */
  posters: ReadonlyMap<string, StrmPoster>;
  /** 进到作品里面时那部作品自己的海报：季目录没有自己的图就借它 */
  fallback: StrmPoster | null;
  /** 这一格进了视口附近：没问过就排上 */
  want: (ref: TileRef) => void;
}

export function useTilePosters(opts: {
  /** 在看哪儿（任务 + 目录 + 是不是搜索结果）：变了就把手里的海报全忘掉 */
  scope: string;
  /** 列出来的那一批条目：换了一批（刷新、删了东西）就重新问一遍，手里的先留着，免得闪一下 */
  listing: unknown;
  enabled: boolean;
  /** 当前目录在哪部作品里面（任务 + 作品目录）；不在作品里是 null */
  work: StrmRef | null;
}): TilePosters {
  const { scope, listing, enabled } = opts;
  const workTask = opts.work?.taskId ?? "";
  const workPath = opts.work?.path ?? "";
  const [posters, setPosters] = useState<ReadonlyMap<string, StrmPoster>>(NONE);
  const [fallback, setFallback] = useState<StrmPoster | null>(null);
  const work = useRef<Work>({ gen: 0, asked: new Set(), queue: [], online: [], busy: false, onlineBusy: false, down: false, scheduled: false });
  const on = useRef(enabled);

  // 用 layout effect：格子是在普通 effect 里喊 want 的，重置要赶在它们前面，不然刚排上的又被清掉、再也没人问
  useLayoutEffect(() => {
    const w = work.current;
    on.current = enabled;
    w.gen++;
    w.asked = new Set();
    w.queue = [];
    w.online = [];
    w.down = false;
    return () => {
      w.gen++;
    };
  }, [scope, listing, enabled]);

  useLayoutEffect(() => setPosters(NONE), [scope, enabled]);

  const merge = useCallback((batch: TileRef[], res: StrmPosterResult, replace: boolean) => {
    setPosters((prev) => {
      const next = new Map(prev);
      for (const ref of batch) {
        if (Object.hasOwn(res.posters, ref.path)) next.set(ref.key, res.posters[ref.path]);
        // 离线那一遍没有的：等着联网的先留着手里那张（上次问到的），别的就是真没有了
        else if (replace) next.delete(ref.key);
      }
      return next;
    });
  }, []);

  const pumpOnline = useCallback(async () => {
    const w = work.current;
    if (w.onlineBusy || w.down || w.online.length === 0) return;
    w.onlineBusy = true;
    const gen = w.gen;
    const taskId = w.online[0].taskId;
    const batch = w.online.filter((r) => r.taskId === taskId).slice(0, ONLINE_CHUNK);
    const taken = new Set(batch.map((r) => r.key));
    w.online = w.online.filter((r) => !taken.has(r.key));
    try {
      const res = await api.strm.posters(taskId, batch.map((r) => r.path), { compact: true });
      if (gen !== w.gen) return;
      merge(batch, res, false);
      if (res.unreachable) {
        w.down = true;
        w.online = [];
      }
    } catch {
      /* 这一批就算了：海报而已 */
    } finally {
      w.onlineBusy = false;
      void pumpOnline();
    }
  }, [merge]);

  const pump = useCallback(async () => {
    const w = work.current;
    if (w.busy || w.queue.length === 0) return;
    w.busy = true;
    const gen = w.gen;
    // 从队尾往前凑同一个任务的一批：队尾是最近进视口的
    const taskId = w.queue[w.queue.length - 1].taskId;
    const batch: TileRef[] = [];
    const rest: TileRef[] = [];
    for (let i = w.queue.length - 1; i >= 0; i--) {
      const ref = w.queue[i];
      if (ref.taskId === taskId && batch.length < CHUNK) batch.push(ref);
      else rest.push(ref);
    }
    w.queue = rest.reverse();
    try {
      const res = await api.strm.posters(taskId, batch.map((r) => r.path), { offline: true, compact: true });
      if (gen !== w.gen) return;
      const pending = new Set(res.pending);
      merge(
        batch.filter((r) => !pending.has(r.path)),
        res,
        true,
      );
      merge(
        batch.filter((r) => pending.has(r.path)),
        res,
        false,
      );
      for (const ref of batch) if (pending.has(ref.path)) w.online.push(ref);
    } catch {
      // 没问成：忘掉「问过」，这一格下次进视口再问
      if (gen === w.gen) for (const ref of batch) w.asked.delete(ref.key);
    } finally {
      w.busy = false;
      void pump();
      void pumpOnline();
    }
  }, [merge, pumpOnline]);

  const want = useCallback(
    (ref: TileRef) => {
      const w = work.current;
      if (!on.current || w.asked.has(ref.key)) return;
      w.asked.add(ref.key);
      w.queue.push(ref);
      if (w.scheduled) return;
      // 一屏的格子是在同一拍里各自喊的：攒到这一拍末尾一起发
      w.scheduled = true;
      queueMicrotask(() => {
        w.scheduled = false;
        void pump();
      });
    },
    [pump],
  );

  useEffect(() => {
    if (!enabled || !workTask || !workPath) {
      setFallback(null);
      return;
    }
    let alive = true;
    api.strm
      .posters(workTask, [workPath], { compact: true })
      .then((res) => {
        if (alive) setFallback(Object.hasOwn(res.posters, workPath) ? res.posters[workPath] : null);
      })
      .catch(() => {
        if (alive) setFallback(null);
      });
    return () => {
      alive = false;
    };
  }, [enabled, workTask, workPath, listing]);

  return { posters, fallback, want };
}

/**
 * 一格要显示的图：进了视口附近才取（外链直接用，本地图带令牌取成 blob），离开就解钉、把地址收回去。
 * 换了一张海报（离线先顶着的那张换成联网问到的）时旧地址留到新的拿到手，不闪
 */
export function useHeldImage(taskId: string, poster: PosterSource | null | undefined, near: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const source = poster?.source;
  const posterUrl = poster?.url;
  const posterFallback = poster?.fallback;

  useEffect(() => {
    if (!near || !source || !posterUrl) {
      setUrl(null);
      return;
    }
    let alive = true;
    let held: HeldImage | null = null;
    void holdPoster(taskId, { source, url: posterUrl, fallback: posterFallback }, () => alive).then((image) => {
      if (!alive) {
        image?.release();
        return;
      }
      held = image;
      setUrl(image?.url ?? null);
    });
    return () => {
      alive = false;
      held?.release();
    };
  }, [near, taskId, source, posterUrl, posterFallback]);

  return url;
}
