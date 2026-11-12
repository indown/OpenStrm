"use client";

/**
 * 一个元素进没进到视口附近。strm 页网格视图的每个格子拿它决定要不要问海报、取图：
 * 一个目录可能上千个子目录，全问一遍、全取一遍都太多，只管人看得到的那一段。
 *
 * 全页共用一个 IntersectionObserver（几千个格子也只有一个观察者），上下各多看一截：滚过来的时候图已经在路上了。
 * 页面切到后台时浏览器不发通知，格子也就不取图——回到前台再说，正好。
 */
import { useCallback, useRef, useState } from "react";

/** 视口上下各多看这么多：大约多一屏 */
const MARGIN = "600px 0px";

const listeners = new WeakMap<Element, (near: boolean) => void>();
let observer: IntersectionObserver | null = null;

function sharedObserver(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver === "undefined") return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) listeners.get(e.target)?.(e.isIntersecting);
    },
    { rootMargin: MARGIN },
  );
  return observer;
}

/**
 * 返回 [挂到元素上的 ref, 在不在视口附近]。浏览器没有 IntersectionObserver 的当都在。
 * 卸载时 React 会拿 null 再调一次 ref，观察就是在那里撤的，不另外挂清理的 effect
 */
export function useNearViewport<T extends Element>(): [(el: T | null) => void, boolean] {
  const [near, setNear] = useState(false);
  const current = useRef<T | null>(null);

  const ref = useCallback((el: T | null) => {
    const old = current.current;
    if (old) {
      observer?.unobserve(old);
      listeners.delete(old);
    }
    current.current = el;
    if (!el) return;
    const io = sharedObserver();
    if (!io) {
      setNear(true);
      return;
    }
    listeners.set(el, setNear);
    io.observe(el);
  }, []);

  return [ref, near];
}
