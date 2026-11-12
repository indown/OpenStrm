"use client";

import * as React from "react";
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArchiveX,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCog,
  Files,
  FolderOpen,
  ListChecks,
  Loader2,
  RefreshCcw,
  RefreshCw,
  Search,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { PosterBackdrop } from "@/components/poster-backdrop";
import { useAllPosters } from "@/hooks/use-all-posters";
import { useDirPosters } from "@/hooks/use-dir-posters";
import { useTilePosters } from "@/hooks/use-tile-posters";
import { Spinner, TableSkeleton } from "@/components/loading";
import { PARSE_REASON_LABEL, parentOf, type RequestDelete } from "@/lib/strm";
import { workRootOf, type StrmRef } from "@/lib/strm-entries";
import { cn } from "@/lib/utils";
import { useStrmBrowser, type StrmRow } from "./use-strm-browser";
import { afterMenuClosed, type EntryActions, type EntryGroup, type EntryViewProps } from "./components/entry-actions";
import { DELETE_LIST_MAX, DeleteStrmDialog } from "./components/DeleteStrmDialog";
import { StrmList } from "./components/StrmList";
import { GridSkeleton, StrmGrid } from "./components/StrmGrid";
import { ViewSwitch, useStrmView } from "./components/ViewSwitch";
import { StrmFileSheet } from "./components/StrmFileSheet";
import { ScanDialog } from "./components/ScanDialog";
import { VerifyDialog } from "./components/VerifyDialog";
import { RegenerateDialog } from "./components/RegenerateDialog";
import { RewriteDialog } from "./components/RewriteDialog";
import { AddCopyDialog, type CopyPreset } from "@/components/AddCopyDialog";
import { ArchiveDialog, type ArchivePreset } from "@/components/ArchiveDialog";
import { CleanArchiveDialog, type CleanArchivePreset } from "@/components/CleanArchiveDialog";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { toast } from "sonner";

const DESCRIPTION = "浏览任务生成的本地 strm 目录，体检、校验、修正或重新生成";

/** 目录条目多过这个数就不铺海报背景：几千行的表格滚起来，背景那层的合成开销不划算 */
const BACKDROP_MAX_ENTRIES = 300;

/** 任务下拉里「全部任务」那一项的值（Radix 的选项不能用空串） */
const ALL_TASKS = "__all__";

/** 静态导出下 useSearchParams 必须包在 Suspense 里，不然 next build 直接报错（和历史页一样） */
export default function StrmPage() {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-6">
          <PageHeader icon={Files} title="strm 管理" description={DESCRIPTION} />
          {/* 默认视图是网格，骨架跟着它 */}
          <GridSkeleton />
        </div>
      }
    >
      <StrmContent />
    </React.Suspense>
  );
}

/** 网盘绝对路径 → 相对任务目录；不在任务目录下面回 null */
function relativeToTask(remote: string, originPath: string): string | null {
  const strip = (p: string) => p.replace(/^\/+|\/+$/g, "");
  const o = strip(originPath);
  const r = strip(remote);
  if (o === "") return r;
  if (r === o) return "";
  return r.startsWith(`${o}/`) ? r.slice(o.length + 1) : null;
}

/** 面包屑的一级：当前这一级点不动、加粗 */
function Crumb({ current, onClick, title, className, children }: { current: boolean; onClick: () => void; title?: string; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={current}
      title={title}
      className={cn(
        "truncate",
        current ? "cursor-default font-medium text-foreground" : "text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
        className,
      )}
    >
      {children}
    </button>
  );
}

function StrmContent() {
  const b = useStrmBrowser();
  const [view, setView] = useStrmView();
  const grid = view === "grid";
  // 弹框都记着自己是对哪个任务开的：看全部任务时一页里有好几个任务的条目
  const [fileRef, setFileRef] = useState<StrmRef | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanPath, setScanPath] = useState("");
  const [verifyRef, setVerifyRef] = useState<StrmRef | null>(null);
  const [regenRef, setRegenRef] = useState<StrmRef | null>(null);
  const [rewriteRef, setRewriteRef] = useState<StrmRef | null>(null);
  const [copyPreset, setCopyPreset] = useState<CopyPreset | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [archivePreset, setArchivePreset] = useState<ArchivePreset | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [cleanPreset, setCleanPreset] = useState<CleanArchivePreset | null>(null);
  const [cleanOpen, setCleanOpen] = useState(false);
  /** 全部任务里折起来的组（任务 id） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const task = b.task;
  const { go, toggleOne, requestDelete, taskOf, displayPath } = b;
  // 全部任务：任何一个任务在跑都算
  const syncing = b.allScope ? (b.tasks ?? []).some((t) => t.status === "processing") : task?.status === "processing";

  const openScan = (p: string) => {
    setScanPath(p);
    setScanOpen(true);
  };

  /**
   * 这一行对应网盘上的哪条路径（相对它那个任务的目录）：本地目录和网盘目录同一个相对路径；
   * strm 要读一下才知道指向网盘上的哪个文件（按内容里写的那个，内容坏了才退回按文件名算的）。对不上的提示后回 null
   */
  const rowDrivePath = useCallback(
    async (row: StrmRow, action: "复制" | "归档"): Promise<string | null> => {
      const owner = taskOf(row.taskId);
      if (!owner) return null;
      let rel: string | null = row.path;
      if (!row.isDir) {
        let remote: string;
        try {
          const info = await api.strm.file(owner.id, row.path);
          if (!info.actualRemotePath && info.reason) {
            toast.error(`这个 strm 的内容看不出指向网盘上的哪个文件（${PARSE_REASON_LABEL[info.reason]}），先用「修正内容」把它写对`);
            return null;
          }
          remote = info.actualRemotePath ?? info.expectedRemotePath;
        } catch (err) {
          toast.error(apiErrorMessage(err, "读取 strm 失败"));
          return null;
        }
        rel = relativeToTask(remote, owner.originPath);
      }
      if (rel === null || rel === "") {
        toast.error(`这个 strm 指向的文件不在任务的网盘目录下面，没法按任务${action}`);
        return null;
      }
      return rel;
    },
    [taskOf],
  );

  /** 行上的操作。同一份对象传给每一行 / 每一格：网格的格子是 memo 的，海报一批批回来时只重画变了的那几格 */
  const actions = useMemo<EntryActions>(() => {
    const refOf = (row: StrmRow): StrmRef => ({ taskId: row.taskId, path: row.path });
    return {
      open: (row) => {
        if (row.isDir) go({ taskId: row.taskId, path: row.path });
        else if (row.kind === "strm") setFileRef(refOf(row));
      },
      toggle: (row, on) => toggleOne(row.key, on),
      remove: (row) => void requestDelete([refOf(row)], `「${row.name}」`),
      verify: (row) => setVerifyRef(refOf(row)),
      regenerate: (row) => setRegenRef(refOf(row)),
      rewrite: (row) => setRewriteRef(refOf(row)),
      copy: (row) =>
        void rowDrivePath(row, "复制").then((rel) => {
          if (rel === null) return;
          setCopyPreset({ taskId: row.taskId, paths: [rel] });
          setCopyOpen(true);
        }),
      archive: (row) =>
        void rowDrivePath(row, "归档").then((rel) => {
          if (rel === null) return;
          setArchivePreset({ taskId: row.taskId, paths: [rel] });
          setArchiveOpen(true);
        }),
    };
  }, [go, toggleOne, requestDelete, rowDrivePath]);

  /** 弹框里的删除只认路径（都是它那个任务下面的）：补上任务再交给页面级的确认 */
  const deleteIn = useCallback(
    (taskId: string): RequestDelete =>
      (paths, label) =>
        requestDelete(
          paths.map((path) => ({ taskId, path })),
          label,
        ),
    [requestDelete],
  );
  const sheetTask = fileRef?.taskId ?? b.taskId;
  const verifyTask = verifyRef?.taskId ?? b.taskId;
  const deleteFromSheet = useMemo(() => deleteIn(sheetTask), [deleteIn, sheetTask]);
  const deleteFromVerify = useMemo(() => deleteIn(verifyTask), [deleteIn, verifyTask]);
  const deleteFromScan = useMemo(() => deleteIn(b.taskId), [deleteIn, b.taskId]);

  const dirOf = useCallback((row: StrmRow) => displayPath({ taskId: row.taskId, path: parentOf(row.path) }) || "根目录", [displayPath]);
  const copyBlockedOf = useCallback((row: StrmRow) => taskOf(row.taskId)?.copyBlocked ?? null, [taskOf]);

  /* ---- 海报背景。纯装饰：任务在跑或在搜索时淡出，把「在动」让给进度条 ---- */
  const dirNames = useMemo(() => (b.allScope ? [] : b.entries.filter((e) => e.isDir).map((e) => e.name)), [b.allScope, b.entries]);
  const light = b.entries.length <= BACKDROP_MAX_ENTRIES;
  // 网格视图下漂移的那面墙不画（前景已经是一面海报墙了），只留进到作品里的那张糊图；「认出来几个」照数
  const backdrop = useDirPosters({ taskId: b.taskId, path: b.path, dirs: dirNames, enabled: Boolean(b.taskId) && light, wall: !grid });
  // 全部任务没有「当前目录」：用任务页那面全库的墙。键是任务表的指纹（id + 本地目录），空串不拉
  const wallKey = useMemo(
    () => (b.allScope && !grid && light ? JSON.stringify(b.owners.map((t) => [t.id, t.targetPath])) : ""),
    [b.allScope, b.owners, grid, light],
  );
  const wallPosters = useAllPosters(wallKey);
  // 按「有没有线索」数，不按拿没拿到图：手机上不下载图，数也照样有；超过一屏的子目录也都数进去
  const recognized = backdrop.recognized ?? 0;
  const unrecognized = backdrop.recognized === null ? 0 : Math.max(0, dirNames.length - recognized);
  const counts = useMemo(() => {
    let dirs = 0;
    let strm = 0;
    let other = 0;
    for (const e of b.entries) {
      if (e.isDir) dirs++;
      else if (e.kind === "strm") strm++;
      else other++;
    }
    return { dirs, strm, other };
  }, [b.entries]);

  /* ---- 网格视图的海报：格子进了视口附近才问 ---- */
  const tileScope = JSON.stringify([b.taskId, b.path, b.mode === "search" ? b.searchTerm : null]);
  const workRoot = b.taskId && b.mode === "browse" ? workRootOf(b.path) : null;
  const work = useMemo(() => (workRoot ? { taskId: b.taskId, path: workRoot } : null), [b.taskId, workRoot]);
  const tiles = useTilePosters({ scope: tileScope, listing: b.base, enabled: grid, work });

  const tasksReady = b.tasks !== null;
  const q = b.query.trim();
  const browsing = b.mode === "browse";

  /** 看全部任务时一个任务一组；别的时候（单任务、搜索结果）整页就一组、没有标题 */
  const groups = useMemo<EntryGroup[]>(() => {
    if (!b.allScope || !browsing) return [{ key: "", rows: b.visible, total: b.base.length }];
    const shown = new Map<string, StrmRow[]>();
    for (const row of b.visible) {
      const list = shown.get(row.taskId);
      if (list) list.push(row);
      else shown.set(row.taskId, [row]);
    }
    const totals = new Map<string, number>();
    for (const row of b.entries) totals.set(row.taskId, (totals.get(row.taskId) ?? 0) + 1);
    return (
      b.owners
        .map((t) => ({ key: t.id, task: t, rows: shown.get(t.id) ?? [], total: totals.get(t.id) ?? 0, state: b.groupStates.get(t.id) }))
        // 在筛的时候没有命中的组不占地方
        .filter((g) => !q || g.rows.length > 0)
    );
  }, [b.allScope, browsing, b.visible, b.base, b.entries, b.owners, b.groupStates, q]);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const openTask = useCallback((id: string) => go({ taskId: id, path: "" }), [go]);

  const goTasksButton = (
    <Button asChild variant="outline">
      <Link href="/home">去任务页</Link>
    </Button>
  );
  const skeleton = grid ? <GridSkeleton /> : <TableSkeleton rows={6} />;

  const renderBody = () => {
    if (!tasksReady) {
      return b.tasksError ? (
        <EmptyState
          icon={Files}
          title="读取任务列表失败"
          description={b.tasksError}
          action={
            <Button variant="outline" onClick={() => void b.reloadTasks()}>
              <RefreshCw className="size-4" />
              重试
            </Button>
          }
        />
      ) : (
        skeleton
      );
    }
    if (b.tasks && b.tasks.length === 0) {
      return (
        <EmptyState
          icon={ListChecks}
          title="还没有同步任务"
          description="strm 管理基于任务的本地目录；先到「任务」页新建一个并跑一次。"
          action={goTasksButton}
        />
      );
    }
    if (!task && !b.allScope) {
      // 有任务但 URL 里的这个不存在（比如被删了）；只有一个任务、没带 taskId 时 hook 会自动跳进去
      return b.taskId ? <EmptyState icon={Files} title="这个任务不存在" description="可能已被删除，换一个任务看看。" /> : skeleton;
    }
    if (!b.loaded) return skeleton;
    if (b.error && b.entries.length === 0 && browsing) {
      return (
        <EmptyState
          icon={Files}
          title="读取目录失败"
          description={b.error}
          action={
            <Button variant="outline" onClick={() => void b.refresh()} disabled={b.refreshing}>
              <RefreshCw className={`size-4 ${b.refreshing ? "animate-spin" : ""}`} />
              重试
            </Button>
          }
        />
      );
    }
    if (b.loading && b.visible.length === 0) return <Spinner label="正在读取目录…" />;
    // 全部任务、没在筛：一条都没有也照样分组画，每一组自己说是没跑过还是空的
    if (b.visible.length === 0 && !(b.allScope && browsing && !q)) {
      if (!browsing) {
        return (
          <EmptyState
            className="py-10"
            icon={Search}
            title="没有匹配的项目"
            description={`${b.allScope ? "所有任务的目录" : "整个目录"}里都没有名字包含「${b.searchTerm}」的文件。`}
          />
        );
      }
      if (q) {
        return (
          <EmptyState
            className="py-10"
            icon={Search}
            title="没有匹配的项目"
            description={
              b.allScope
                ? `各任务的根目录里没有名字包含「${q}」的项目；按回车可以搜索所有任务的整个目录。`
                : `当前目录里没有名字包含「${q}」的项目；按回车可以搜索整个目录。`
            }
          />
        );
      }
      if (b.path === "") {
        return (
          <EmptyState
            icon={Files}
            title="这个目录还是空的"
            description="任务还没跑过，或者本地目录不存在。到「任务」页运行一次同步后再来。"
            action={goTasksButton}
          />
        );
      }
      return <EmptyState icon={FolderOpen} title="这个目录是空的" description="可以用「工具 → 重新生成」按网盘目录补齐。" />;
    }
    const viewProps: EntryViewProps = {
      groups,
      selected: b.selected,
      allSelected: b.allSelected,
      onToggleAll: b.toggleAll,
      media: b.media,
      showDir: !browsing,
      dirOf,
      copyBlockedOf,
      actions,
      collapsed,
      onCollapse: toggleCollapsed,
      onOpenTask: openTask,
    };
    return grid ? <StrmGrid {...viewProps} tiles={tiles} /> : <StrmList {...viewProps} />;
  };

  const toolsButton = (
    <Button variant="outline" disabled={!task}>
      <Wrench className="size-4" />
      工具
      <ChevronDown className="size-4 opacity-60" />
    </Button>
  );

  return (
    <div className="relative z-0 space-y-6">
      {/* 海报背景。挂在这层 relative z-0 里面、自己是 -z-10：
          既在内容列的 bg-muted/50 之上（不会被那层底色盖掉），又在面板和文字之下；
          根节点是 z-0 而不是 z-10，是为了让侧栏（fixed z-10）和顶栏（sticky z-20）盖在它上面 */}
      <PosterBackdrop
        mode={b.allScope ? "stream" : backdrop.mode}
        posters={b.allScope ? wallPosters : backdrop.posters}
        muted={Boolean(syncing) || !browsing}
      />
      <PageHeader
        icon={Files}
        title="strm 管理"
        description={DESCRIPTION}
        actions={
          <>
            <Button variant="outline" onClick={() => void b.refresh()} disabled={(!task && !b.allScope) || b.refreshing}>
              <RefreshCw className={`size-4 ${b.refreshing ? "animate-spin" : ""}`} />
              刷新
            </Button>
            {b.allScope ? (
              // 灰掉的按钮不吃指针事件，提示挂在外面这层上
              <span title="工具是对一个任务的当前目录做的：先选一个任务，或者点某一组的「打开」">{toolsButton}</span>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>{toolsButton}</DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => afterMenuClosed(() => openScan(b.path))}>
                    <Stethoscope />
                    体检当前目录
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => afterMenuClosed(() => setVerifyRef({ taskId: b.taskId, path: b.path }))}>
                    <ShieldCheck />
                    校验当前目录
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={b.path === ""}
                    title={b.path === "" ? "根目录请直接运行同步任务" : undefined}
                    onSelect={() => afterMenuClosed(() => setRegenRef({ taskId: b.taskId, path: b.path }))}
                  >
                    <RefreshCcw />
                    重新生成当前目录
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => afterMenuClosed(() => setRewriteRef({ taskId: b.taskId, path: b.path }))}>
                    <FileCog />
                    修正内容
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={b.path === "" || Boolean(task?.copyBlocked)}
                    title={task?.copyBlocked ?? (b.path === "" ? "任务目录本身不能整个复制，进到里面的目录再选" : undefined)}
                    onSelect={() =>
                      afterMenuClosed(() => {
                        setCopyPreset({ taskId: b.taskId, paths: [b.path] });
                        setCopyOpen(true);
                      })
                    }
                  >
                    <Copy />
                    复制当前目录到 OpenList
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={b.path === ""}
                    title={b.path === "" ? "任务目录本身不能整个归档，进到里面的目录再选" : undefined}
                    onSelect={() =>
                      afterMenuClosed(() => {
                        setArchivePreset({ taskId: b.taskId, paths: [b.path] });
                        setArchiveOpen(true);
                      })
                    }
                  >
                    <Archive />
                    归档当前目录到暂存区
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      afterMenuClosed(() => {
                        setCleanPreset({ taskId: b.taskId });
                        setCleanOpen(true);
                      })
                    }
                  >
                    <ArchiveX />
                    清理归档
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      >
        {(task || b.allScope) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {task ? (
              <p className="break-all font-mono text-xs text-muted-foreground">本地目录 {task.targetPath || "（数据目录根）"}</p>
            ) : (
              <p className="text-xs text-muted-foreground tabular-nums">全部任务 · {b.owners.length} 个本地目录</p>
            )}
            {syncing && (
              <StatusBadge tone="info" pulse>
                同步中
              </StatusBadge>
            )}
            {/* 这一行是海报背景的「说明文字」：背景只给气氛，认出了多少、还剩几个没认出来在这里说清楚 */}
            {task && browsing && counts.dirs > 0 && recognized > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {counts.dirs} 个目录 · {recognized} 已识别
              </span>
            )}
            {task && browsing && recognized > 0 && unrecognized > 0 && (
              <Link
                href={`/organize?${new URLSearchParams({ task: b.taskId, ...(b.path ? { path: b.path } : {}) })}`}
                title={`去整理 ${b.path ? `/${b.path}` : "这个任务"}`}
              >
                <StatusBadge tone="warning" className="tabular-nums hover:opacity-80">
                  {unrecognized} 个没认出来
                </StatusBadge>
              </Link>
            )}
            {b.allScope && browsing && counts.dirs > 0 && <span className="text-xs text-muted-foreground tabular-nums">{counts.dirs} 个目录</span>}
            {browsing && counts.strm > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {counts.strm} 个 strm{counts.other > 0 ? ` · ${counts.other} 个其它` : ""}
              </span>
            )}
          </div>
        )}
      </PageHeader>

      {tasksReady && b.tasks && b.tasks.length > 0 && (
        <div className="space-y-3">
          {/* 工具栏：任务 + 筛选 / 搜索 + 视图 */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={b.taskId || (b.hasAll ? ALL_TASKS : undefined)}
              onValueChange={(id) => id && b.go({ taskId: id === ALL_TASKS ? "" : id, path: "" })}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="选择任务" />
              </SelectTrigger>
              <SelectContent>
                {b.hasAll && <SelectItem value={ALL_TASKS}>全部任务</SelectItem>}
                {b.tasks.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.originPath} → {t.targetPath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex flex-1 items-center gap-2">
              <Input
                value={b.query}
                onChange={(e) => b.setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void b.runSearch()}
                placeholder={b.allScope ? "筛选各任务的根目录，回车搜索所有任务" : "筛选当前目录，回车搜索整个目录"}
                disabled={!task && !b.allScope}
                className="flex-1"
              />
              <Button
                variant="outline"
                onClick={() => void b.runSearch()}
                disabled={(!task && !b.allScope) || !q || b.searching}
                title={b.allScope ? "搜索所有任务的整个目录" : "搜索整个目录"}
              >
                {b.searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                搜索
              </Button>
              <ViewSwitch view={view} onChange={setView} />
            </div>
          </div>

          {/* 面包屑 + 选择操作。行高按「删除所选」那个按钮先占住：勾上第一个时这一行不长高，下面的内容不会从指针底下挪走 */}
          {(task || b.allScope) && (
            <div className="flex flex-col gap-2 sm:min-h-8 sm:flex-row sm:items-center sm:justify-between">
              <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
                {b.hasAll && (
                  <Crumb current={b.allScope} onClick={() => b.go({ taskId: "" })}>
                    全部任务
                  </Crumb>
                )}
                {task && (
                  <>
                    {b.hasAll && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                    {/* 有「全部任务」那一级时，任务根写它的本地目录，不然几个任务的「根目录」分不清 */}
                    <Crumb current={b.segments.length === 0} onClick={() => b.go({ path: "" })} title={task.targetPath} className="max-w-[220px]">
                      {b.hasAll ? task.targetPath || "数据目录根" : "根目录"}
                    </Crumb>
                  </>
                )}
                {b.segments.map((seg, i) => (
                  <span key={`${i}-${seg}`} className="flex min-w-0 items-center gap-1">
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    <Crumb
                      current={i === b.segments.length - 1}
                      onClick={() => b.go({ path: b.segments.slice(0, i + 1).join("/") })}
                      title={seg}
                      className="max-w-[140px]"
                    >
                      {seg}
                    </Crumb>
                  </span>
                ))}
              </nav>
              <div className={cn("flex flex-wrap items-center gap-2", (b.visible.length > 0 || b.selected.size > 0) && "min-h-8")}>
                {!browsing && (
                  <button
                    type="button"
                    onClick={b.exitSearch}
                    className="inline-flex items-center gap-1 rounded-md border border-brand/20 bg-brand/10 px-2 py-0.5 text-xs text-brand"
                    title={b.allScope ? "退出搜索，回到全部任务" : "退出搜索，回到当前目录"}
                  >
                    {b.allScope ? "全部任务搜索" : "全目录搜索"}「{b.searchTerm}」
                    <X className="size-3" />
                  </button>
                )}
                {/* 列表视图 md 以上表头里有全选；手机卡片和网格视图没有表头，放这里 */}
                {b.visible.length > 0 && (
                  <label className={cn("flex items-center gap-2 text-xs text-muted-foreground", !grid && "md:hidden")}>
                    <Checkbox checked={b.allSelected} onCheckedChange={(v) => b.toggleAll(v === true)} aria-label="全选" />
                    全选
                  </label>
                )}
                {b.selected.size > 0 && (
                  <Button variant="destructive" size="sm" onClick={() => void b.requestDelete(b.selectedRefs, `所选 ${b.selected.size} 项`)}>
                    <Trash2 className="size-4" />
                    删除所选（{b.selected.size}）
                  </Button>
                )}
              </div>
            </div>
          )}

          {!browsing && b.truncated && <p className="text-xs text-warning">结果太多，只显示了前面一部分，请换个更具体的关键词。</p>}
        </div>
      )}

      {renderBody()}

      <DeleteStrmDialog
        target={
          b.deleteTarget
            ? { label: b.deleteTarget.label, paths: b.deleteTarget.refs.slice(0, DELETE_LIST_MAX).map(displayPath), count: b.deleteTarget.refs.length }
            : null
        }
        deleting={b.deleting}
        onCancel={b.cancelDelete}
        onConfirm={() => void b.confirmDelete()}
      />

      <StrmFileSheet
        taskId={sheetTask}
        path={fileRef?.path ?? null}
        onOpenChange={(open) => !open && setFileRef(null)}
        onDelete={deleteFromSheet}
        onDeleted={() => setFileRef(null)}
      />
      <ScanDialog
        key={`${b.taskId}::${scanPath}`}
        open={scanOpen}
        onOpenChange={setScanOpen}
        taskId={b.taskId}
        path={scanPath}
        onOpenPath={(dir) => {
          setScanOpen(false);
          b.go({ path: dir });
        }}
        onDelete={deleteFromScan}
        onRewriteAll={(p) => {
          setScanOpen(false);
          setRewriteRef({ taskId: b.taskId, path: p });
        }}
      />
      <VerifyDialog target={verifyRef?.path ?? null} onOpenChange={(open) => !open && setVerifyRef(null)} taskId={verifyTask} onDelete={deleteFromVerify} />
      <RegenerateDialog
        target={regenRef?.path ?? null}
        onOpenChange={(open) => !open && setRegenRef(null)}
        taskId={regenRef?.taskId ?? b.taskId}
        syncing={regenRef ? taskOf(regenRef.taskId)?.status === "processing" : false}
        onDone={() => void b.refresh()}
      />
      <RewriteDialog
        target={rewriteRef?.path ?? null}
        onOpenChange={(open) => !open && setRewriteRef(null)}
        taskId={rewriteRef?.taskId ?? b.taskId}
        onDone={() => void b.refresh()}
      />
      <AddCopyDialog open={copyOpen} onOpenChange={setCopyOpen} preset={copyPreset} />
      <ArchiveDialog open={archiveOpen} onOpenChange={setArchiveOpen} preset={archivePreset} onDone={() => void b.refresh()} />
      <CleanArchiveDialog open={cleanOpen} onOpenChange={setCleanOpen} preset={cleanPreset} />
    </div>
  );
}
