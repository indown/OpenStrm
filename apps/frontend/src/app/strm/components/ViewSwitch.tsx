"use client";

import { useEffect, useState } from "react";
import { LayoutGrid, List } from "lucide-react";
import { cn } from "@/lib/utils";

export type StrmView = "list" | "grid";

const VIEW_KEY = "openstrm.strm.view";

/** 没选过的用网格；存的不是「列表」也按网格算 */
const DEFAULT_VIEW: StrmView = "grid";

function readView(): StrmView {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

/** strm 页用哪种视图：选了哪个记在浏览器里，下次进来还是它；没选过是网格 */
export function useStrmView(): [StrmView, (view: StrmView) => void] {
  const [view, setView] = useState<StrmView>(DEFAULT_VIEW);
  // 放 effect 里读：服务端渲染那一遍没有 localStorage，两边首帧得一样（选过列表的人首帧是网格的骨架，随即换过来）
  useEffect(() => setView(readView()), []);
  const change = (next: StrmView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* 私密窗口之类：不记就不记 */
    }
  };
  return [view, change];
}

const VIEWS = [
  { key: "list", label: "列表视图", Icon: List },
  { key: "grid", label: "网格视图", Icon: LayoutGrid },
] as const;

/** 列表 / 网格两格开关：外框和旁边的描边按钮一个样，选中的那格垫一层底色 */
export function ViewSwitch({ view, onChange }: { view: StrmView; onChange: (view: StrmView) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="视图"
      className="inline-flex h-9 shrink-0 items-center rounded-md border bg-background p-0.5 shadow-xs dark:border-input dark:bg-input/30"
    >
      {VIEWS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={view === key}
          aria-label={label}
          title={label}
          onClick={() => onChange(key)}
          className={cn(
            "inline-flex h-full w-8 items-center justify-center rounded-[5px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            view === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
