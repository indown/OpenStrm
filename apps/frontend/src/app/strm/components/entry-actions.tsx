"use client";

/**
 * strm 页条目（列表里的一行、网格里的一格）共用的东西：能做哪些操作、两种视图都要的 props、目录和文件的下拉菜单。
 * 操作都回到页面层处理（弹框、跳转都在那儿），这里不碰接口。
 */
import Link from "next/link";
import { Archive, Copy, Eye, FileCog, MoreHorizontal, RefreshCcw, ShieldCheck, Telescope, Trash2 } from "lucide-react";
import type { MediaBrief } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TaskRow } from "@/lib/api";
import { keywordFromPath, searchHref } from "@/lib/resource";
import { cn } from "@/lib/utils";
import type { GroupState, StrmRow } from "../use-strm-browser";

/** 从下拉菜单里打开确认弹框要等菜单先关掉，否则菜单还回焦点时会把弹框顶掉 */
export const afterMenuClosed = (fn: () => void) => setTimeout(fn, 0);

/** 一行条目能做的事。页面层给的是同一份（useMemo），网格的格子才能按 memo 省掉重画 */
export interface EntryActions {
  /** 目录进去；strm 开详情；别的文件什么都不做 */
  open: (row: StrmRow) => void;
  toggle: (row: StrmRow, on: boolean) => void;
  remove: (row: StrmRow) => void;
  verify: (row: StrmRow) => void;
  regenerate: (row: StrmRow) => void;
  rewrite: (row: StrmRow) => void;
  /** 交给「复制到 OpenList / CD2」：目录整个复制，strm 按它指向的网盘文件 */
  copy: (row: StrmRow) => void;
  /** 归档到暂存区：网盘上那一份挪进任务目录下的「归档」，本地 strm 删掉；目录整个收，strm 按它指向的网盘文件 */
  archive: (row: StrmRow) => void;
}

/** 一组条目：看全部任务时一个任务一组（带 task），别的时候整页就一组 */
export interface EntryGroup {
  key: string;
  task?: TaskRow;
  rows: StrmRow[];
  /** 这一组没按输入框筛之前有多少条 */
  total: number;
  state?: GroupState;
}

/** 列表和网格都要的 props */
export interface EntryViewProps {
  groups: EntryGroup[];
  /** 勾着的行键 */
  selected: ReadonlySet<string>;
  allSelected: boolean;
  onToggleAll: (on: boolean) => void;
  /** 行键 → strm 指向的网盘文件的实测媒体信息（整理页探测过或 Emby 回填过的才有） */
  media: ReadonlyMap<string, MediaBrief>;
  /** 搜索结果：每条下面写所在目录 */
  showDir: boolean;
  dirOf: (row: StrmRow) => string;
  /** 这一行所在的任务复制不了的原因（挂载层账号的任务、设置没配好）：有就把入口灰掉 */
  copyBlockedOf: (row: StrmRow) => string | null;
  actions: EntryActions;
  /** 折起来的组（任务 id） */
  collapsed: ReadonlySet<string>;
  onCollapse: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
}

/** 一组下面要不要说一句话：没列成、目录不存在、是空的。有条目的不用说 */
export function groupNote(group: EntryGroup): { text: string; danger: boolean } | null {
  // 没有 state：这一组还没列回来，先什么都不说
  if (!group.task || !group.state) return null;
  if (group.state.error) return { text: `这个任务的目录没列出来：${group.state.error}。点页头的「刷新」再试一次。`, danger: true };
  if (group.rows.length > 0) return null;
  if (group.state.missing) return { text: "本地目录还不存在：这个任务还没跑过，到「任务」页运行一次同步。", danger: false };
  return { text: "这个任务的本地目录是空的。", danger: false };
}

type MenuProps = {
  row: StrmRow;
  actions: EntryActions;
  copyBlocked: string | null;
  /** 触发按钮的额外样式：表格里是 size-8，手机卡片 size-9，海报上是压在图角上的小方块 */
  triggerClassName?: string;
};

/** 目录的「更多操作」 */
export function DirMenu({ row, actions, copyBlocked, triggerClassName }: MenuProps) {
  // 季目录（Season 1）按上一级的作品名搜
  const keyword = keywordFromPath(row.path);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("size-8", triggerClassName)} title="更多操作">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => afterMenuClosed(() => actions.verify(row))}>
          <ShieldCheck />
          校验此目录
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => afterMenuClosed(() => actions.regenerate(row))}>
          <RefreshCcw />
          重新生成
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => afterMenuClosed(() => actions.rewrite(row))}>
          <FileCog />
          修正内容
        </DropdownMenuItem>
        <DropdownMenuItem disabled={Boolean(copyBlocked)} title={copyBlocked ?? undefined} onSelect={() => afterMenuClosed(() => actions.copy(row))}>
          <Copy />
          复制到 OpenList / CD2
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => afterMenuClosed(() => actions.archive(row))}>
          <Archive />
          归档到暂存区
        </DropdownMenuItem>
        {keyword && (
          <DropdownMenuItem asChild>
            <Link href={searchHref(keyword)}>
              <Telescope />
              找资源
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => afterMenuClosed(() => actions.remove(row))}>
          <Trash2 />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 文件的「更多操作」（网格视图用；列表里这几个是一排图标按钮）：strm 能查看 / 复制 / 归档，别的文件只能删 */
export function FileMenu({ row, actions, copyBlocked, triggerClassName }: MenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("size-8", triggerClassName)} title="更多操作">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {row.kind === "strm" && (
          <>
            <DropdownMenuItem onSelect={() => afterMenuClosed(() => actions.open(row))}>
              <Eye />
              查看
            </DropdownMenuItem>
            <DropdownMenuItem disabled={Boolean(copyBlocked)} title={copyBlocked ?? undefined} onSelect={() => afterMenuClosed(() => actions.copy(row))}>
              <Copy />
              复制到 OpenList / CD2
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => afterMenuClosed(() => actions.archive(row))}>
              <Archive />
              归档到暂存区
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem variant="destructive" onSelect={() => afterMenuClosed(() => actions.remove(row))}>
          <Trash2 />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
