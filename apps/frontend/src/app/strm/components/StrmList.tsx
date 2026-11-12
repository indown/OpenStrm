"use client";

/**
 * strm 页的列表视图：md 以上是表格，手机上一条一张卡。看全部任务时每个任务一组，组前一行标题。
 */
import { Fragment } from "react";
import { Archive, Copy, Eye, File, FolderOpen, Trash2 } from "lucide-react";
import type { MediaBrief } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MediaFlags } from "@/components/media-flags";
import { StatusBadge } from "@/components/status-badge";
import { fmtTime, formatSize } from "@/lib/format";
import { briefTitle, flagsFromBrief } from "@/lib/media-flags";
import { KIND_META } from "@/lib/strm";
import { cn } from "@/lib/utils";
import type { StrmRow } from "../use-strm-browser";
import { DirMenu, groupNote, type EntryActions, type EntryViewProps } from "./entry-actions";
import { GroupHeader } from "./GroupHeader";

/** 一行条目在表格和手机卡片上都要用到的东西 */
type RowProps = {
  row: StrmRow;
  checked: boolean;
  /** 搜索结果里要显示所在目录；浏览时是 null */
  dir: string | null;
  media?: MediaBrief;
  copyBlocked: string | null;
  actions: EntryActions;
};

function EntryName({ row, dir, media, actions }: Pick<RowProps, "row" | "dir" | "media" | "actions">) {
  const Icon = row.isDir ? FolderOpen : File;
  const clickable = row.isDir || row.kind === "strm";
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className={`mt-0.5 size-4 shrink-0 ${row.isDir ? "text-warning" : "text-muted-foreground"}`} />
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => actions.open(row)}
          disabled={!clickable}
          title={row.name}
          className={`break-all text-left text-sm font-medium ${clickable ? "hover:text-brand" : "cursor-default"}`}
        >
          {row.name}
          {row.isSymlink && <span className="ml-1 text-xs font-normal text-muted-foreground">（链接）</span>}
        </button>
        {dir !== null && <div className="break-all text-xs text-muted-foreground">{dir}</div>}
        {media && (
          <div className="mt-0.5">
            <MediaFlags flags={flagsFromBrief(media)} max={6} title={briefTitle(media)} />
          </div>
        )}
      </div>
    </div>
  );
}

function KindBadge({ row }: { row: StrmRow }) {
  if (row.isDir) return <span className="text-xs text-muted-foreground">目录</span>;
  const meta = KIND_META[row.kind];
  return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>;
}

function StrmTableRow(p: RowProps) {
  const { row, actions } = p;
  return (
    <TableRow data-state={p.checked ? "selected" : undefined}>
      <TableCell className="w-10">
        <Checkbox checked={p.checked} onCheckedChange={(v) => actions.toggle(row, v === true)} aria-label={`选择 ${row.name}`} />
      </TableCell>
      <TableCell className="min-w-[240px]">
        <EntryName row={row} dir={p.dir} media={p.media} actions={actions} />
      </TableCell>
      <TableCell className="w-24">
        <KindBadge row={row} />
      </TableCell>
      <TableCell className="w-24 text-right text-xs text-muted-foreground tabular-nums">{row.isDir ? "-" : formatSize(row.size)}</TableCell>
      <TableCell className="w-44 text-xs text-muted-foreground tabular-nums">{fmtTime(row.mtime)}</TableCell>
      <TableCell className="w-28">
        <div className="flex justify-end gap-0.5">
          {row.isDir ? (
            <DirMenu row={row} actions={actions} copyBlocked={p.copyBlocked} />
          ) : (
            <>
              {row.kind === "strm" && (
                <>
                  <Button variant="ghost" size="icon" className="size-8" title="查看" onClick={() => actions.open(row)}>
                    <Eye className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    title={p.copyBlocked ?? "复制到 OpenList / CD2"}
                    disabled={Boolean(p.copyBlocked)}
                    onClick={() => actions.copy(row)}
                  >
                    <Copy className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-8" title="归档到暂存区" onClick={() => actions.archive(row)}>
                    <Archive className="size-4" />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-destructive hover:text-destructive"
                title="删除"
                onClick={() => actions.remove(row)}
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function StrmCard(p: RowProps) {
  const { row, actions } = p;
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <Checkbox className="mt-0.5" checked={p.checked} onCheckedChange={(v) => actions.toggle(row, v === true)} aria-label={`选择 ${row.name}`} />
        <div className="min-w-0 flex-1">
          <EntryName row={row} dir={p.dir} media={p.media} actions={actions} />
          <div className="mt-1 text-xs text-muted-foreground tabular-nums">
            {row.isDir ? fmtTime(row.mtime) : `${formatSize(row.size)} · ${fmtTime(row.mtime)}`}
          </div>
        </div>
        {!row.isDir && (
          <div className="shrink-0">
            <KindBadge row={row} />
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t pt-3">
        {row.isDir ? (
          <>
            <Button variant="outline" size="sm" className="h-9 flex-1" onClick={() => actions.open(row)}>
              <FolderOpen className="size-4" />
              打开
            </Button>
            <DirMenu row={row} actions={actions} copyBlocked={p.copyBlocked} triggerClassName="size-9" />
          </>
        ) : row.kind === "strm" ? (
          <>
            <Button variant="outline" size="sm" className="h-9 flex-1" onClick={() => actions.open(row)}>
              <Eye className="size-4" />
              查看
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              title={p.copyBlocked ?? "复制到 OpenList / CD2"}
              disabled={Boolean(p.copyBlocked)}
              onClick={() => actions.copy(row)}
            >
              <Copy className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" className="size-9" title="归档到暂存区" onClick={() => actions.archive(row)}>
              <Archive className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-destructive hover:text-destructive"
              title="删除"
              onClick={() => actions.remove(row)}
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" className="h-9 flex-1 text-destructive hover:text-destructive" onClick={() => actions.remove(row)}>
            <Trash2 className="size-4" />
            删除
          </Button>
        )}
      </div>
    </div>
  );
}

export function StrmList(p: EntryViewProps) {
  const rowProps = (row: StrmRow): RowProps => ({
    row,
    checked: p.selected.has(row.key),
    dir: p.showDir ? p.dirOf(row) : null,
    media: p.media.get(row.key),
    copyBlocked: p.copyBlockedOf(row),
    actions: p.actions,
  });
  const header = (g: EntryViewProps["groups"][number]) => (
    <GroupHeader group={g} collapsed={p.collapsed.has(g.key)} onCollapse={p.onCollapse} onOpenTask={p.onOpenTask} />
  );
  return (
    <>
      {/* 手机上一条一张卡；md 起是表格 */}
      <div className="space-y-3 md:hidden">
        {p.groups.map((g) => {
          const open = !g.task || !p.collapsed.has(g.key);
          const note = groupNote(g);
          return (
            <Fragment key={g.key}>
              {g.task && <div className="pt-2 first:pt-0">{header(g)}</div>}
              {open && note && <p className={cn("text-xs", note.danger ? "text-destructive" : "text-muted-foreground")}>{note.text}</p>}
              {open && g.rows.map((row) => <StrmCard key={row.key} {...rowProps(row)} />)}
            </Fragment>
          );
        })}
      </div>
      {/* 半透明 + 毛玻璃：海报墙要从表格后面透出来，又不能影响文件名的可读性 */}
      <div className="hidden overflow-hidden rounded-xl border bg-card/60 backdrop-blur-sm md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox checked={p.allSelected} onCheckedChange={(v) => p.onToggleAll(v === true)} aria-label="全选" />
              </TableHead>
              <TableHead>名称</TableHead>
              <TableHead className="w-24">类型</TableHead>
              <TableHead className="w-24 text-right">大小</TableHead>
              <TableHead className="w-44">修改时间</TableHead>
              <TableHead className="w-28 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.groups.map((g) => {
              const open = !g.task || !p.collapsed.has(g.key);
              const note = groupNote(g);
              return (
                <Fragment key={g.key}>
                  {g.task && (
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={6} className="py-1.5">
                        {header(g)}
                      </TableCell>
                    </TableRow>
                  )}
                  {open && note && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className={cn("py-3 text-xs whitespace-normal", note.danger ? "text-destructive" : "text-muted-foreground")}>
                        {note.text}
                      </TableCell>
                    </TableRow>
                  )}
                  {open && g.rows.map((row) => <StrmTableRow key={row.key} {...rowProps(row)} />)}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
