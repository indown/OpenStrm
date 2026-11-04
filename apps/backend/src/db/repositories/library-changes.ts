/**
 * 影库单元变动的进程内广播：仓库层写完就喊一声，`library-works-view.ts` 听着增量维护海报墙视图。
 *
 * 用广播而不是让视图模块和 `library-units.ts` 互相 import：那样会绕成环。
 * 只在这一个进程里有效：写单元的只有后端进程（Emby 代理进程不写），够用。
 */
import type { LibraryUnitStatus } from "@openstrm/shared";

/** 一个单元落在视图哪个格子里由这三个字段决定 */
export interface UnitKeyState {
  status: LibraryUnitStatus;
  tmdbId: number | null;
  mediaType: "movie" | "tv" | null;
}

export type LibraryChange =
  /** 一个单元写过了：before / after 是写前后的状态，没有这一行时是 null */
  | { kind: "unit"; sourceId: string; unitKey: string; before: UnitKeyState | null; after: UnitKeyState | null }
  /** 一部作品的分组字段变了（补类型、地区），单元的状态没动：只重查这一组 */
  | { kind: "group"; mediaType: "movie" | "tv"; tmdbId: number }
  /** 批量变动（重切、删来源、分享失效…）：视图整个作废 */
  | { kind: "all" };

type Listener = (change: LibraryChange) => void;

const listeners = new Set<Listener>();

export function onLibraryChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyLibraryChange(change: LibraryChange): void {
  for (const listener of listeners) listener(change);
}
