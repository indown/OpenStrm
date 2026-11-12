"use client";

/**
 * strm 页的网格视图。目录和文件是两种格子，不做成一样大的图标格：
 *
 *   片架    目录一格一张 2:3 海报，直接摆在画布上，没有卡片外框——和收藏夹那面墙同一种画法。
 *           没有海报的：季目录用等宽字写季号，别的画一枚文件夹；进到作品里面时借作品那张图压淡了当底，字照写。
 *           季目录自己有图的，季号缩成左下角一枚小标。
 *   文件页  文件是「印章 + 名字 + 旗标 + 大小时间」的横格，印章上是集号（strm）或扩展名（附件）。
 *           格子自己没有边框，整块放在一张半透明面板上：和列表那张表格是同一种面板，也只有这一层毛玻璃。
 *           strm 在前、附件另起一块，集号才连得成一串。
 *
 * 勾选框和「⋯」平时收着，指针悬停、键盘聚焦、或者已经勾了东西时才出来；触屏上没有悬停，一直在。
 * 海报进了视口附近才问、才取图（hooks/use-tile-posters.ts）。方案见 .claude/plans/strm-grid-view.md
 */
import { memo, useEffect, useMemo, useState } from "react";
import { File, Film, Folder } from "lucide-react";
import type { MediaBrief, StrmPoster } from "@openstrm/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { MediaFlags } from "@/components/media-flags";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { useHeldImage, type TilePosters, type TileRef } from "@/hooks/use-tile-posters";
import { fmtTime, formatSize } from "@/lib/format";
import { flagsFromBrief } from "@/lib/media-flags";
import { KIND_META } from "@/lib/strm";
import { episodeStamp, extStamp, seasonStamp, splitWorkName } from "@/lib/strm-entries";
import { cn } from "@/lib/utils";
import type { StrmRow } from "../use-strm-browser";
import { DirMenu, FileMenu, groupNote, type EntryActions, type EntryGroup, type EntryViewProps } from "./entry-actions";
import { GroupHeader } from "./GroupHeader";

/** 片架：手机固定三列；再宽按容器自己排，一格不窄于 8.5rem（1440 宽大约七列，和收藏夹的墙差不多密） */
const SHELF = "grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] sm:gap-x-4 sm:gap-y-5";
/** 文件页：手机一列；再宽一格不窄于 17.5rem */
const SHEET = "grid gap-1 sm:grid-cols-[repeat(auto-fill,minmax(17.5rem,1fr))]";
/** 平时收着的控件：悬停、聚焦才出来，触屏上一直在 */
const REVEAL =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none";

/* ------------------------------- 片架：目录 ------------------------------- */

type PosterTileProps = {
  row: StrmRow;
  checked: boolean;
  /** 页面上已经勾了东西：所有格子的勾选框都亮出来，接着勾不用一个个去悬停 */
  selecting: boolean;
  poster: StrmPoster | undefined;
  /** 这个目录自己没有图时借的那张（进到作品里面才有） */
  fallback: StrmPoster | null;
  /** 搜索结果里写所在目录；浏览时是 null，第二行写年份 */
  dir: string | null;
  copyBlocked: string | null;
  actions: EntryActions;
  want: (ref: TileRef) => void;
};

const PosterTile = memo(function PosterTile({ row, checked, selecting, poster, fallback, dir, copyBlocked, actions, want }: PosterTileProps) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  useEffect(() => {
    if (near) want(row);
  }, [near, want, row]);

  const season = useMemo(() => seasonStamp(row.name), [row.name]);
  const name = useMemo(() => splitWorkName(row.name), [row.name]);
  const url = useHeldImage(row.taskId, poster ?? fallback, near);
  // 图解出来了才盖到占位上面；坏图（外链连不上、文件不是图）就一直是占位
  const [ready, setReady] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  useEffect(() => {
    if (!url) setReady(false);
  }, [url]);
  const src = url && broken !== url ? url : null;
  const shown = Boolean(src) && ready;
  // 借来的图（作品那张）压淡了当底，上面照样写季号 / 画文件夹：一排季目录不会看成一排一模一样的海报
  const borrowed = !poster && Boolean(fallback);
  const sub = [dir ?? name.year, row.isSymlink ? "链接" : ""].filter(Boolean).join(" · ");

  return (
    <div ref={ref} className="group relative min-w-0">
      <button
        type="button"
        onClick={() => actions.open(row)}
        title={row.name}
        className="block w-full min-w-0 rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <div
          className={cn(
            "relative aspect-[2/3] overflow-hidden rounded-lg bg-muted ring-1 ring-border transition-shadow group-hover:ring-2 group-hover:ring-brand motion-reduce:transition-none",
            checked && "ring-2 ring-brand",
          )}
        >
          {src && (
            // eslint-disable-next-line @next/next/no-img-element -- 本地图是带令牌取回来的 blob 地址，next/image 帮不上忙
            <img
              src={src}
              alt=""
              decoding="async"
              draggable={false}
              onLoad={() => setReady(true)}
              onError={() => setBroken(src)}
              className={cn(
                "absolute inset-0 size-full object-cover transition-opacity duration-300 motion-reduce:transition-none",
                !ready ? "opacity-0" : borrowed ? "opacity-30" : "opacity-100",
              )}
            />
          )}
          {(!shown || borrowed) && (
            <div className={cn("absolute inset-0 flex items-center justify-center", shown ? "text-foreground/75" : "text-muted-foreground/50")}>
              {season ? <span className="font-mono text-2xl font-medium">{season}</span> : <Folder className="size-8" strokeWidth={1.5} />}
            </div>
          )}
          {season && shown && !borrowed && (
            <span className="absolute bottom-1.5 left-1.5 rounded bg-background/85 px-1.5 font-mono text-[11px] leading-5 font-medium">{season}</span>
          )}
        </div>
        <div className="mt-1.5 space-y-0.5">
          <p className="truncate text-sm font-medium">{name.title}</p>
          {sub && <p className="truncate text-xs text-muted-foreground tabular-nums">{sub}</p>}
        </div>
      </button>
      <span className={cn("absolute top-1.5 left-1.5 flex rounded-md bg-background/90 p-1 shadow-xs", REVEAL, (checked || selecting) && "opacity-100")}>
        <Checkbox checked={checked} onCheckedChange={(v) => actions.toggle(row, v === true)} aria-label={`选择 ${row.name}`} />
      </span>
      <DirMenu
        row={row}
        actions={actions}
        copyBlocked={copyBlocked}
        triggerClassName={cn(
          "absolute top-1.5 right-1.5 size-7 bg-background/90 shadow-xs hover:bg-background data-[state=open]:opacity-100 dark:hover:bg-background",
          REVEAL,
        )}
      />
    </div>
  );
});

/* ------------------------------- 文件页：文件 ------------------------------- */

/** 文件格左边那枚印章：strm 写集号（认不出集号的画胶片），附件写扩展名，残留分段用警告色 */
function Stamp({ row }: { row: StrmRow }) {
  const base = "flex h-11 min-w-11 shrink-0 flex-col items-center justify-center rounded-lg border px-1 font-mono leading-none";
  if (row.kind === "strm") {
    const ep = episodeStamp(row.name);
    return (
      <span className={cn(base, "border-brand/20 bg-brand/10 text-brand")} title={KIND_META.strm.label}>
        {ep ? (
          <>
            {ep.season && <span className="mb-0.5 text-[11px] opacity-70">{ep.season}</span>}
            <span className={cn("font-semibold", ep.episode.length > 4 ? "text-xs" : "text-sm")}>{ep.episode}</span>
          </>
        ) : (
          <Film className="size-5" strokeWidth={1.75} />
        )}
      </span>
    );
  }
  const ext = extStamp(row.name);
  return (
    <span
      className={cn(base, row.kind === "part" ? "border-warning/25 bg-warning/15 text-warning" : "border-transparent bg-muted text-muted-foreground")}
      title={KIND_META[row.kind].label}
    >
      {ext ? <span className="text-[11px] font-medium">{ext}</span> : <File className="size-5" strokeWidth={1.75} />}
    </span>
  );
}

type FileCellProps = {
  row: StrmRow;
  checked: boolean;
  selecting: boolean;
  dir: string | null;
  media: MediaBrief | undefined;
  copyBlocked: string | null;
  actions: EntryActions;
};

const FileCell = memo(function FileCell({ row, checked, selecting, dir, media, copyBlocked, actions }: FileCellProps) {
  // 只有 strm 点得开（详情抽屉）；附件没有可看的
  const clickable = row.kind === "strm";
  const flags = useMemo(() => flagsFromBrief(media), [media]);
  return (
    <div className={cn("group relative flex min-w-0 items-start gap-3 rounded-lg p-2 transition-colors", checked ? "bg-brand/10" : "hover:bg-muted/60")}>
      {/* 指针设备上压在印章左上角、悬停才出来；触屏上排在印章左边、一直在 */}
      <span
        className={cn(
          "absolute top-1 left-1 z-10 flex rounded-md bg-background/90 p-1 shadow-xs",
          "pointer-coarse:static pointer-coarse:mt-3.5 pointer-coarse:bg-transparent pointer-coarse:p-0 pointer-coarse:shadow-none",
          REVEAL,
          (checked || selecting) && "opacity-100",
        )}
      >
        <Checkbox checked={checked} onCheckedChange={(v) => actions.toggle(row, v === true)} aria-label={`选择 ${row.name}`} />
      </span>
      <Stamp row={row} />
      <div className="min-w-0 flex-1 pr-7">
        <button
          type="button"
          onClick={() => actions.open(row)}
          disabled={!clickable}
          title={row.name}
          className={cn(
            "block max-w-full text-left text-sm font-medium outline-none",
            // 整格都点得到：按钮的伪元素铺满这一格，勾选框和菜单在它上面一层
            clickable ? "after:absolute after:inset-0 after:rounded-lg hover:text-brand focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50" : "cursor-default",
          )}
        >
          <span className="line-clamp-2 break-all">
            {row.name}
            {row.isSymlink && <span className="ml-1 text-xs font-normal text-muted-foreground">（链接）</span>}
          </span>
        </button>
        {dir !== null && <p className="truncate text-xs text-muted-foreground">{dir}</p>}
        {flags.length > 0 && <MediaFlags flags={flags} max={4} className="mt-1" />}
        {/* strm 只有几百字节，大小没什么可看的：只写时间；空文件（残留分段常常是）也不写大小 */}
        <p className="mt-1 truncate text-xs text-muted-foreground tabular-nums">
          {row.kind === "strm" || row.size <= 0 ? fmtTime(row.mtime) : `${formatSize(row.size)} · ${fmtTime(row.mtime)}`}
        </p>
      </div>
      <FileMenu
        row={row}
        actions={actions}
        copyBlocked={copyBlocked}
        triggerClassName={cn("absolute top-1.5 right-1.5 z-10 size-7 data-[state=open]:opacity-100", REVEAL)}
      />
    </div>
  );
});

/* ------------------------------- 一组 ------------------------------- */

function GridGroup({ group, view, tiles, selecting }: { group: EntryGroup; view: EntryViewProps; tiles: TilePosters; selecting: boolean }) {
  const dirs = useMemo(() => group.rows.filter((r) => r.isDir), [group.rows]);
  // strm 排前面、附件另起一块：按名字混着排的话每集后面夹着它的 nfo / 字幕，集号就连不成一串了
  const strms = useMemo(() => group.rows.filter((r) => !r.isDir && r.kind === "strm"), [group.rows]);
  const others = useMemo(() => group.rows.filter((r) => !r.isDir && r.kind !== "strm"), [group.rows]);
  const open = !group.task || !view.collapsed.has(group.key);
  const note = groupNote(group);
  const dirOf = (row: StrmRow) => (view.showDir ? view.dirOf(row) : null);
  return (
    <section className="space-y-3">
      {group.task && <GroupHeader group={group} collapsed={!open} onCollapse={view.onCollapse} onOpenTask={view.onOpenTask} />}
      {open && note && <p className={cn("text-xs", note.danger ? "text-destructive" : "text-muted-foreground")}>{note.text}</p>}
      {open && dirs.length > 0 && (
        <div className={SHELF}>
          {dirs.map((row) => (
            <PosterTile
              key={row.key}
              row={row}
              checked={view.selected.has(row.key)}
              selecting={selecting}
              poster={tiles.posters.get(row.key)}
              fallback={tiles.fallback}
              dir={dirOf(row)}
              copyBlocked={view.copyBlockedOf(row)}
              actions={view.actions}
              want={tiles.want}
            />
          ))}
        </div>
      )}
      {open && (strms.length > 0 || others.length > 0) && (
        <div className="divide-y rounded-xl border bg-card/60 backdrop-blur-sm">
          {[strms, others].map(
            (files, i) =>
              files.length > 0 && (
                <div key={i} className={cn(SHEET, "p-1.5")}>
                  {files.map((row) => (
                    <FileCell
                      key={row.key}
                      row={row}
                      checked={view.selected.has(row.key)}
                      selecting={selecting}
                      dir={dirOf(row)}
                      media={view.media.get(row.key)}
                      copyBlocked={view.copyBlockedOf(row)}
                      actions={view.actions}
                    />
                  ))}
                </div>
              ),
          )}
        </div>
      )}
    </section>
  );
}

export function StrmGrid({ tiles, ...view }: EntryViewProps & { tiles: TilePosters }) {
  const selecting = view.selected.size > 0;
  return (
    <div className="space-y-8">
      {view.groups.map((g) => (
        <GridGroup key={g.key} group={g} view={view} tiles={tiles} selecting={selecting} />
      ))}
    </div>
  );
}

/** 网格视图的首屏骨架：和片架同一套列，数据到了不会跳一下 */
export function GridSkeleton({ count = 14 }: { count?: number }) {
  return (
    <div className={SHELF}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="aspect-[2/3] w-full rounded-lg" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ))}
    </div>
  );
}
