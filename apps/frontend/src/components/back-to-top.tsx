"use client";

/**
 * 「回到顶部」悬浮按钮：往下滚过一屏才出现，点一下回到页面最上面。
 * 给一直往下接页的长列表用（收藏夹的作品墙 / 搜索结果）：滚了几十屏以后，筛选栏和搜索框都在顶上，没有它只能一路滚回去。
 *
 * 摆在内容列的底部正中（和资源搜索页底部那条悬浮栏同一个位置、同一种药丸），不放右下角，两个原因：
 *   - 列表每一行的末尾是操作按钮（搜索结果、「分享」列表的「⋯」），右下角的圆钮正好压在这一列上，整个按钮都看不见；
 *   - 桌面上 toast 从右下角出来，会盖住它。
 * 内容列窄的时候（手机，或者平板宽度下侧栏展开着）改成靠左：每行的「打开 / 转存 / ⋯」靠右排、占掉右边两百来像素，
 * 列一窄正中也会压到「打开」；左边是缩略图和文字，压着不碍事。看的是内容列的宽度（容器查询），不是视口宽度。
 *
 * 用法：放在页面内容的最后（LayoutWrapper 那个内容容器的直接子元素）。它是 sticky 的——
 * 平时贴在视口底边上方、浮在内容上；滚到页面最底时落回文档流里自己的位置（最后一行的下面），不压着最后一行。
 */
import { useEffect, useState } from "react";
import { ArrowUpToLine } from "lucide-react";
import { cn } from "@/lib/utils";

/** 离顶上超过这么多屏，回顶时就跳过中间那一大段、只滑最后一屏；不到的整段滑回去（看得见是从哪回来的） */
const SKIP_BEYOND_SCREENS = 3;

export function BackToTop() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // 滚过一屏才算「离顶上远了」：第一屏里用不着它。
    // scroll 事件浏览器一帧最多发一次，这里只读两个数，值没变时 setState 也不会重画，不用再节流
    const update = () => setShown(window.scrollY > window.innerHeight);
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const toTop = () => {
    // 系统设了「减少动态效果」的直接跳过去，不滑
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      window.scrollTo({ top: 0, behavior: "instant" });
      return;
    }
    // 滚得深的不一路滑回去：先直接跳到离顶上只剩一屏的地方，再把最后一屏滑完。
    // 浏览器自己的平滑滚动越远越久（Chrome 实测 900px 0.7 秒、7000px 以上封顶 1.5 秒），几十屏的海报在眼前刷一秒半，没必要
    const screen = window.innerHeight;
    if (window.scrollY > screen * SKIP_BEYOND_SCREENS) window.scrollTo({ top: screen, behavior: "instant" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    // 这一整条是透明的、不接鼠标（别挡住它两边的内容），只有按钮接。
    // 没出现时高度是 0，不占地方；出现时占一个按钮的高度——滚到底时按钮就落在这块自己的地方上。
    // z-30：在顶栏（z-20）上面、弹框（z-50）下面
    <div className={cn("@container pointer-events-none sticky bottom-6 z-30", shown ? "mt-3 h-9 pointer-coarse:h-10" : "h-0")}>
      {/* @xl = 内容列 576px：再窄的话正中的按钮会碰到行末那组操作按钮（它们从右边起占 200px 出头） */}
      <div className="flex h-full items-end justify-start @xl:justify-center">
        <button
          type="button"
          onClick={toTop}
          className={cn(
            "pointer-events-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border bg-card/90 pr-3.5 pl-3 text-sm text-muted-foreground shadow-lg backdrop-blur-md outline-none pointer-coarse:h-10",
            "transition-[opacity,translate,visibility,color,border-color] duration-200 motion-reduce:transition-none",
            "hover:border-brand/50 hover:text-brand focus-visible:ring-[3px] focus-visible:ring-ring/50",
            // 藏起来用 visibility：键盘焦点和读屏都碰不到它；它排在过渡里，淡出播完才真的藏
            shown ? "visible translate-y-0 opacity-100" : "invisible translate-y-2 opacity-0",
          )}
        >
          <ArrowUpToLine className="size-4" />
          回到顶部
        </button>
      </div>
    </div>
  );
}
