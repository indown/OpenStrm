"use client";

/**
 * strm 管理页背景要显示哪些海报。两个状态，判定只有一条规则：
 *
 *   当前路径的祖先里有带 id 标签的段  → single：就那一部作品的海报，静止
 *   否则                              → stream：当前目录下的子目录各一张，漂移
 *
 * 剧集和电影一视同仁，也不在乎深度：`剧名 (2024) [tmdbid=1]`、它的 `Season 01`、`Season 01/extras`
 * 进哪一层都是同一张。命名里没写 id 标签的库退一步：拿当前目录和它的父目录去碰运气。
 *
 * stream 态顺带数一下「子目录里有几个认出来了」（页头那句 N 个目录 · M 已识别）：这个手机上也要，
 * 所以问接口不看屏幕宽窄，只有下载图片看——窄屏上墙不画。
 *
 * 网格视图（wall: false）下漂移的那面墙不画——前景已经是一面海报墙了：这时只数、不下图，问接口也只用离线的几级。
 * 进到作品里的那张糊图照旧。
 */
import { useEffect, useState } from "react";
import type { StrmPosterResult } from "@openstrm/shared";
import { useBackdropWide, type BackdropPoster } from "@/components/poster-backdrop";
import { api } from "@/lib/api";
import { NO_POSTERS, toBackdropPosters, type ShownPosters } from "@/lib/poster-images";
import { workRootOf } from "@/lib/strm-entries";

/** 一屏也放不下更多，多了只是白拉图 */
const MAX_TILES = 24;
/** 数线索时一批问多少个目录（后端一次最多 48 个） */
const COUNT_CHUNK = 48;

export interface DirBackdrop {
  mode: "stream" | "single";
  posters: BackdropPoster[];
  /** stream 态：当前目录下有线索（海报 / id 标签 / nfo / 整理记录）的子目录个数；没开、没数完、single 态是 null */
  recognized: number | null;
}

interface Shown {
  mode: "stream" | "single";
  set: ShownPosters;
}

const NOTHING: Shown = { mode: "stream", set: NO_POSTERS };

const parentOf = (path: string): string => path.split("/").filter(Boolean).slice(0, -1).join("/");
const under = (path: string, name: string): string => (path ? `${path}/${name}` : name);

function plan(path: string, dirs: string[]): { mode: "stream" | "single"; paths: string[] } {
  const work = workRootOf(path);
  if (work) return { mode: "single", paths: [work] };
  if (dirs.length > 0) return { mode: "stream", paths: dirs.slice(0, MAX_TILES).map((d) => under(path, d)) };
  // 没有子目录又没有 id 标签：可能是命名里不写标签的库，拿自己和父目录试试
  const fallback = [path, parentOf(path)].filter((p, i, all) => p !== "" && all.indexOf(p) === i);
  return { mode: "single", paths: fallback };
}

/** 墙那一批已经问过前 MAX_TILES 个；剩下的子目录每 COUNT_CHUNK 个一批，只数线索、不联网。数不全就不给数 */
async function countKnown(taskId: string, path: string, dirs: string[], first: StrmPosterResult, alive: () => boolean): Promise<number | null> {
  const rest = dirs.slice(MAX_TILES).map((d) => under(path, d));
  let known = first.known.length;
  for (let i = 0; i < rest.length; i += COUNT_CHUNK) {
    if (!alive()) return null;
    try {
      known += (await api.strm.posters(taskId, rest.slice(i, i + COUNT_CHUNK), { offline: true })).known.length;
    } catch {
      return null;
    }
  }
  return known;
}

export function useDirPosters(opts: {
  taskId: string;
  path: string;
  dirs: string[];
  enabled: boolean;
  /** 漂移的那面墙要不要画（网格视图不要）；默认要 */
  wall?: boolean;
}): DirBackdrop {
  const { taskId, path, enabled, wall = true } = opts;
  const wide = useBackdropWide();
  const dirsKey = JSON.stringify(opts.dirs);
  const [shown, setShown] = useState<Shown>(NOTHING);
  const [recognized, setRecognized] = useState<number | null>(null);

  // 换下来的那一批解钉（新的一批这时候已经钉住了）；卸载时解钉最后一批
  useEffect(() => () => shown.set.release(), [shown]);

  useEffect(() => {
    if (!enabled || !taskId) {
      setShown(NOTHING);
      setRecognized(null);
      return;
    }
    const dirs = JSON.parse(dirsKey) as string[];
    const { mode, paths } = plan(path, dirs);
    if (paths.length === 0) {
      setShown(NOTHING);
      setRecognized(null);
      return;
    }
    // 要不要图：窄屏不画墙；网格视图只留单作品那一张
    const images = wide && (mode === "single" || wall);
    let alive = true;
    void (async () => {
      let first: StrmPosterResult;
      try {
        // 不要图就不用为了图去 TMDB 现查：数线索离线的几级就够
        first = await api.strm.posters(taskId, paths, images ? {} : { offline: true });
      } catch {
        // 背景图而已，拿不到就当没有
        if (alive) {
          setShown(NOTHING);
          setRecognized(null);
        }
        return;
      }
      if (!alive) return;
      const items = paths.flatMap((p) => (Object.hasOwn(first.posters, p) ? [{ key: p, taskId, poster: first.posters[p] }] : []));
      const [set, count] = await Promise.all([
        images ? toBackdropPosters(items, () => alive) : Promise.resolve(NO_POSTERS),
        mode === "stream" ? countKnown(taskId, path, dirs, first, () => alive) : Promise.resolve(null),
      ]);
      if (!alive) {
        set.release();
        return;
      }
      // single 态只要第一张拿到就够
      setShown({ mode, set: mode === "single" ? { ...set, posters: set.posters.slice(0, 1) } : set });
      setRecognized(count);
    })();
    return () => {
      alive = false;
    };
  }, [taskId, path, dirsKey, enabled, wide, wall]);

  return { mode: shown.mode, posters: shown.set.posters, recognized };
}
