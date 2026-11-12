"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import type { EntryGroup } from "./entry-actions";

/**
 * 看全部任务时一组（一个任务根）的标题行：点左边折叠 / 展开，右边是条数和「打开」。
 * 任务没有名字，写法和任务页那一行一样：账户徽章 + 网盘目录 + `→ 本地目录`。列表和网格共用
 */
export function GroupHeader({
  group,
  collapsed,
  onCollapse,
  onOpenTask,
}: {
  group: EntryGroup;
  collapsed: boolean;
  onCollapse: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const task = group.task;
  if (!task) return null;
  const label = `${task.originPath} → ${task.targetPath || "（数据目录根）"}`;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => onCollapse(task.id)}
        aria-expanded={!collapsed}
        title={collapsed ? `展开 ${label}` : `折叠 ${label}`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", collapsed && "-rotate-90")} />
        {/* 徽章画法和任务页那一行一样；这里在按钮里面，用 span 不用 Badge 的 div */}
        <span className={cn(badgeVariants({ variant: "outline" }), "shrink-0 font-normal text-muted-foreground")} title={`账户 ${task.account}（${task.accountType ?? "?"}）`}>
          {task.account}
        </span>
        <span className="truncate text-sm font-medium">{task.originPath}</span>
        <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">→ {task.targetPath || "（数据目录根）"}</span>
      </button>
      {task.status === "processing" && (
        <StatusBadge tone="info" pulse>
          同步中
        </StatusBadge>
      )}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {group.rows.length === group.total ? `${group.total} 项` : `${group.rows.length} / ${group.total} 项`}
      </span>
      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onOpenTask(task.id)} title={`只看这个任务：${label}`}>
        打开
        <ChevronRight className="opacity-60" />
      </Button>
    </div>
  );
}
