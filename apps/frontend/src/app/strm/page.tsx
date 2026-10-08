"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  File,
  FileCog,
  Files,
  FolderOpen,
  ListChecks,
  Loader2,
  MoreHorizontal,
  RefreshCcw,
  RefreshCw,
  Search,
  ShieldCheck,
  Stethoscope,
  Telescope,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { PosterBackdrop } from "@/components/poster-backdrop";
import { useDirPosters } from "@/hooks/use-dir-posters";
import { Spinner, TableSkeleton } from "@/components/loading";
import { fmtTime, formatSize } from "@/lib/format";
import { KIND_META, PARSE_REASON_LABEL, parentOf } from "@/lib/strm";
import { keywordFromPath, searchHref } from "@/lib/resource";
import { useStrmBrowser, type DeleteRequest, type StrmRow } from "./use-strm-browser";
import { StrmFileSheet } from "./components/StrmFileSheet";
import { ScanDialog } from "./components/ScanDialog";
import { VerifyDialog } from "./components/VerifyDialog";
import { RegenerateDialog } from "./components/RegenerateDialog";
import { RewriteDialog } from "./components/RewriteDialog";
import { AddCopyDialog, type CopyPreset } from "@/components/AddCopyDialog";
import { ArchiveDialog, type ArchivePreset } from "@/components/ArchiveDialog";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { toast } from "sonner";

const DESCRIPTION = "浏览任务生成的本地 strm 目录，体检、校验、修正或重新生成";

/** 目录条目多过这个数就不铺海报背景：几千行的表格滚起来，背景那层的合成开销不划算 */
const BACKDROP_MAX_ENTRIES = 300;

/** 从下拉菜单里打开确认弹框要等菜单先关掉，否则菜单还回焦点时会把弹框顶掉 */
const afterMenuClosed = (fn: () => void) => setTimeout(fn, 0);

/** 静态导出下 useSearchParams 必须包在 Suspense 里，不然 next build 直接报错（和历史页一样） */
export default function StrmPage() {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-6">
          <PageHeader icon={Files} title="strm 管理" description={DESCRIPTION} />
          <TableSkeleton rows={6} />
        </div>
      }
    >
      <StrmContent />
    </React.Suspense>
  );
}

/** 一行条目在表格和手机卡片上都要用到的东西；操作都回到页面层处理 */
type RowProps = {
  row: StrmRow;
  checked: boolean;
  /** 搜索结果里要显示所在目录 */
  showPath: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
  onDelete: () => void;
  onVerify: () => void;
  onRegenerate: () => void;
  onRewrite: () => void;
  /** 交给「复制到 OpenList」：目录整个复制，strm 按它指向的网盘文件 */
  onCopy: () => void;
  /** 归档到暂存区：网盘上那一份挪进任务目录下的「归档」，本地 strm 删掉；目录整个收，strm 按它指向的网盘文件 */
  onArchive: () => void;
  /** 这个任务复制不了的原因（OpenList 账号的任务、设置没配好）：有就把入口灰掉 */
  copyBlocked: string | null;
};

/** 网盘绝对路径 → 相对任务目录；不在任务目录下面回 null */
function relativeToTask(remote: string, originPath: string): string | null {
  const strip = (p: string) => p.replace(/^\/+|\/+$/g, "");
  const o = strip(originPath);
  const r = strip(remote);
  if (o === "") return r;
  if (r === o) return "";
  return r.startsWith(`${o}/`) ? r.slice(o.length + 1) : null;
}

function StrmContent() {
  const b = useStrmBrowser();
  const [filePath, setFilePath] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanPath, setScanPath] = useState("");
  const [verifyPath, setVerifyPath] = useState<string | null>(null);
  const [regenPath, setRegenPath] = useState<string | null>(null);
  const [rewritePath, setRewritePath] = useState<string | null>(null);
  const [copyPreset, setCopyPreset] = useState<CopyPreset | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [archivePreset, setArchivePreset] = useState<ArchivePreset | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const openScan = (p: string) => {
    setScanPath(p);
    setScanOpen(true);
  };

  /**
   * 这一行对应网盘上的哪条路径（相对任务目录）：本地目录和网盘目录同一个相对路径；
   * strm 要读一下才知道指向网盘上的哪个文件（按内容里写的那个，内容坏了才退回按文件名算的）。对不上的提示后回 null
   */
  const rowDrivePath = async (row: StrmRow, action: "复制" | "归档"): Promise<string | null> => {
    if (!task) return null;
    let rel: string | null = row.path;
    if (!row.isDir) {
      let remote: string;
      try {
        const info = await api.strm.file(task.id, row.path);
        if (!info.actualRemotePath && info.reason) {
          toast.error(`这个 strm 的内容看不出指向网盘上的哪个文件（${PARSE_REASON_LABEL[info.reason]}），先用「修正内容」把它写对`);
          return null;
        }
        remote = info.actualRemotePath ?? info.expectedRemotePath;
      } catch (err) {
        toast.error(apiErrorMessage(err, "读取 strm 失败"));
        return null;
      }
      rel = relativeToTask(remote, task.originPath);
    }
    if (rel === null || rel === "") {
      toast.error(`这个 strm 指向的文件不在任务的网盘目录下面，没法按任务${action}`);
      return null;
    }
    return rel;
  };

  const copyRow = async (row: StrmRow) => {
    const rel = await rowDrivePath(row, "复制");
    if (rel === null || !task) return;
    setCopyPreset({ taskId: task.id, paths: [rel] });
    setCopyOpen(true);
  };

  const archiveRow = async (row: StrmRow) => {
    const rel = await rowDrivePath(row, "归档");
    if (rel === null || !task) return;
    setArchivePreset({ taskId: task.id, paths: [rel] });
    setArchiveOpen(true);
  };

  const rowProps = (row: StrmRow): RowProps => ({
    row,
    checked: b.selected.has(row.path),
    showPath: b.mode === "search",
    onToggle: (on) => b.toggleOne(row.path, on),
    onOpen: () => {
      if (row.isDir) b.go({ path: row.path });
      else if (row.kind === "strm") setFilePath(row.path);
    },
    onDelete: () => void b.requestDelete([row.path], `「${row.name}」`),
    onVerify: () => setVerifyPath(row.path),
    onRegenerate: () => setRegenPath(row.path),
    onRewrite: () => setRewritePath(row.path),
    onCopy: () => void copyRow(row),
    onArchive: () => void archiveRow(row),
    copyBlocked: task?.copyBlocked ?? null,
  });

  const task = b.task;
  const syncing = task?.status === "processing";

  /* ---- 海报背景。纯装饰：任务在跑或在搜索时淡出，把「在动」让给进度条 ---- */
  const dirNames = useMemo(() => b.entries.filter((e) => e.isDir).map((e) => e.name), [b.entries]);
  const backdrop = useDirPosters({
    taskId: b.taskId,
    path: b.path,
    dirs: dirNames,
    enabled: Boolean(b.taskId) && b.entries.length <= BACKDROP_MAX_ENTRIES,
  });
  // 按「有没有线索」数，不按拿没拿到图：手机上不下载图，数也照样有；超过一屏的子目录也都数进去
  const recognized = backdrop.recognized ?? 0;
  const unrecognized = backdrop.recognized === null ? 0 : Math.max(0, dirNames.length - recognized);
  const fileCounts = useMemo(() => {
    let strm = 0;
    let other = 0;
    for (const e of b.entries) {
      if (e.isDir) continue;
      if (e.kind === "strm") strm++;
      else other++;
    }
    return { strm, other };
  }, [b.entries]);
  const tasksReady = b.tasks !== null;
  const q = b.query.trim();

  const goTasksButton = (
    <Button asChild variant="outline">
      <Link href="/home">去任务页</Link>
    </Button>
  );

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
        <TableSkeleton rows={6} />
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
    if (!task) {
      // 有任务但 URL 里的这个不存在（比如被删了）；没带 taskId 时 hook 会自动跳到第一个任务
      return b.taskId ? (
        <EmptyState icon={Files} title="这个任务不存在" description="可能已被删除，换一个任务看看。" />
      ) : (
        <TableSkeleton rows={6} />
      );
    }
    if (!b.loaded) return <TableSkeleton rows={6} />;
    if (b.error && b.entries.length === 0 && b.mode !== "search") {
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
    if (b.visible.length === 0) {
      if (b.mode === "search") {
        return (
          <EmptyState
            className="py-10"
            icon={Search}
            title="没有匹配的项目"
            description={`整个目录里都没有名字包含「${b.searchTerm}」的文件。`}
          />
        );
      }
      if (q) {
        return (
          <EmptyState
            className="py-10"
            icon={Search}
            title="没有匹配的项目"
            description={`当前目录里没有名字包含「${q}」的项目；按回车可以搜索整个目录。`}
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
      return (
        <EmptyState icon={FolderOpen} title="这个目录是空的" description="可以用「工具 → 重新生成」按网盘目录补齐。" />
      );
    }
    return (
      <>
        {/* 手机上一条一张卡；md 起是表格 */}
        <div className="space-y-3 md:hidden">
          {b.visible.map((row) => (
            <StrmCard key={row.path} {...rowProps(row)} />
          ))}
        </div>
        {/* 半透明 + 毛玻璃：海报墙要从表格后面透出来，又不能影响文件名的可读性 */}
        <div className="hidden overflow-hidden rounded-xl border bg-card/60 backdrop-blur-sm md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={b.allSelected} onCheckedChange={(v) => b.toggleAll(v === true)} aria-label="全选" />
                </TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-24">类型</TableHead>
                <TableHead className="w-24 text-right">大小</TableHead>
                <TableHead className="w-44">修改时间</TableHead>
                <TableHead className="w-28 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.visible.map((row) => (
                <StrmTableRow key={row.path} {...rowProps(row)} />
              ))}
            </TableBody>
          </Table>
        </div>
      </>
    );
  };

  return (
    <div className="relative z-0 space-y-6">
      {/* 海报背景。挂在这层 relative z-0 里面、自己是 -z-10：
          既在内容列的 bg-muted/50 之上（不会被那层底色盖掉），又在面板和文字之下；
          根节点是 z-0 而不是 z-10，是为了让侧栏（fixed z-10）和顶栏（sticky z-20）盖在它上面 */}
      <PosterBackdrop mode={backdrop.mode} posters={backdrop.posters} muted={syncing || b.mode === "search"} />
      <PageHeader
        icon={Files}
        title="strm 管理"
        description={DESCRIPTION}
        actions={
          <>
            <Button variant="outline" onClick={() => void b.refresh()} disabled={!task || b.refreshing}>
              <RefreshCw className={`size-4 ${b.refreshing ? "animate-spin" : ""}`} />
              刷新
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={!task}>
                  <Wrench className="size-4" />
                  工具
                  <ChevronDown className="size-4 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => afterMenuClosed(() => openScan(b.path))}>
                  <Stethoscope />
                  体检当前目录
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => afterMenuClosed(() => setVerifyPath(b.path))}>
                  <ShieldCheck />
                  校验当前目录
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={b.path === ""}
                  title={b.path === "" ? "根目录请直接运行同步任务" : undefined}
                  onSelect={() => afterMenuClosed(() => setRegenPath(b.path))}
                >
                  <RefreshCcw />
                  重新生成当前目录
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => afterMenuClosed(() => setRewritePath(b.path))}>
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
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        {task && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <p className="break-all font-mono text-xs text-muted-foreground">本地目录 {task.targetPath || "（数据目录根）"}</p>
            {syncing && (
              <StatusBadge tone="info" pulse>
                同步中
              </StatusBadge>
            )}
            {/* 这一行是海报背景的「说明文字」：背景只给气氛，认出了多少、还剩几个没认出来在这里说清楚 */}
            {b.mode === "browse" && dirNames.length > 0 && recognized > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {dirNames.length} 个目录 · {recognized} 已识别
              </span>
            )}
            {b.mode === "browse" && recognized > 0 && unrecognized > 0 && (
              <Link
                href={`/organize?${new URLSearchParams({ task: b.taskId, ...(b.path ? { path: b.path } : {}) })}`}
                title={`去整理 ${b.path ? `/${b.path}` : "这个任务"}`}
              >
                <StatusBadge tone="warning" className="tabular-nums hover:opacity-80">
                  {unrecognized} 个没认出来
                </StatusBadge>
              </Link>
            )}
            {b.mode === "browse" && fileCounts.strm > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {fileCounts.strm} 个 strm{fileCounts.other > 0 ? ` · ${fileCounts.other} 个其它` : ""}
              </span>
            )}
          </div>
        )}
      </PageHeader>

      {tasksReady && b.tasks && b.tasks.length > 0 && (
        <div className="space-y-3">
          {/* 工具栏：任务 + 筛选 / 搜索 */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select value={b.taskId || undefined} onValueChange={(id) => b.go({ taskId: id, path: "" })}>
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="选择任务" />
              </SelectTrigger>
              <SelectContent>
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
                placeholder="筛选当前目录，回车搜索整个目录"
                disabled={!task}
                className="flex-1"
              />
              <Button variant="outline" onClick={() => void b.runSearch()} disabled={!task || !q || b.searching} title="搜索整个目录">
                {b.searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                搜索
              </Button>
            </div>
          </div>

          {/* 面包屑 + 选择操作 */}
          {task && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
                <button
                  type="button"
                  onClick={() => b.go({ path: "" })}
                  disabled={b.segments.length === 0}
                  title={task.targetPath}
                  className={
                    b.segments.length === 0
                      ? "cursor-default font-medium text-foreground"
                      : "text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  }
                >
                  根目录
                </button>
                {b.segments.map((seg, i) => {
                  const last = i === b.segments.length - 1;
                  return (
                    <span key={`${i}-${seg}`} className="flex min-w-0 items-center gap-1">
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      <button
                        type="button"
                        onClick={() => b.go({ path: b.segments.slice(0, i + 1).join("/") })}
                        disabled={last}
                        title={seg}
                        className={`max-w-[140px] truncate ${
                          last
                            ? "cursor-default font-medium text-foreground"
                            : "text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        }`}
                      >
                        {seg}
                      </button>
                    </span>
                  );
                })}
              </nav>
              <div className="flex flex-wrap items-center gap-2">
                {b.mode === "search" && (
                  <button
                    type="button"
                    onClick={b.exitSearch}
                    className="inline-flex items-center gap-1 rounded-md border border-brand/20 bg-brand/10 px-2 py-0.5 text-xs text-brand"
                    title="退出搜索，回到当前目录"
                  >
                    全目录搜索「{b.searchTerm}」
                    <X className="size-3" />
                  </button>
                )}
                {b.visible.length > 0 && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground md:hidden">
                    <Checkbox checked={b.allSelected} onCheckedChange={(v) => b.toggleAll(v === true)} aria-label="全选" />
                    全选
                  </label>
                )}
                {b.selected.size > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void b.requestDelete([...b.selected], `所选 ${b.selected.size} 项`)}
                  >
                    <Trash2 className="size-4" />
                    删除所选（{b.selected.size}）
                  </Button>
                )}
              </div>
            </div>
          )}

          {b.mode === "search" && b.truncated && (
            <p className="text-xs text-warning">结果太多，只显示了前面一部分，请换个更具体的关键词。</p>
          )}
        </div>
      )}

      {renderBody()}

      <DeleteStrmDialog target={b.deleteTarget} deleting={b.deleting} onCancel={b.cancelDelete} onConfirm={() => void b.confirmDelete()} />

      <StrmFileSheet
        taskId={b.taskId}
        path={filePath}
        onOpenChange={(open) => !open && setFilePath(null)}
        onDelete={b.requestDelete}
        onDeleted={() => setFilePath(null)}
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
        onDelete={b.requestDelete}
        onRewriteAll={(p) => {
          setScanOpen(false);
          setRewritePath(p);
        }}
      />
      <VerifyDialog target={verifyPath} onOpenChange={(open) => !open && setVerifyPath(null)} taskId={b.taskId} onDelete={b.requestDelete} />
      <RegenerateDialog
        target={regenPath}
        onOpenChange={(open) => !open && setRegenPath(null)}
        taskId={b.taskId}
        syncing={Boolean(syncing)}
        onDone={() => void b.refresh()}
      />
      <RewriteDialog target={rewritePath} onOpenChange={(open) => !open && setRewritePath(null)} taskId={b.taskId} onDone={() => void b.refresh()} />
      <AddCopyDialog open={copyOpen} onOpenChange={setCopyOpen} preset={copyPreset} />
      <ArchiveDialog open={archiveOpen} onOpenChange={setArchiveOpen} preset={archivePreset} onDone={() => void b.refresh()} />
    </div>
  );
}

/* ------------------------------- 行 / 卡片 ------------------------------- */

function EntryName({ row, showPath, onOpen }: Pick<RowProps, "row" | "showPath" | "onOpen">) {
  const Icon = row.isDir ? FolderOpen : File;
  const clickable = row.isDir || row.kind === "strm";
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className={`mt-0.5 size-4 shrink-0 ${row.isDir ? "text-warning" : "text-muted-foreground"}`} />
      <div className="min-w-0">
        <button
          type="button"
          onClick={onOpen}
          disabled={!clickable}
          title={row.name}
          className={`break-all text-left text-sm font-medium ${clickable ? "hover:text-brand" : "cursor-default"}`}
        >
          {row.name}
          {row.isSymlink && <span className="ml-1 text-xs font-normal text-muted-foreground">（链接）</span>}
        </button>
        {showPath && <div className="break-all text-xs text-muted-foreground">{parentOf(row.path) || "根目录"}</div>}
      </div>
    </div>
  );
}

function DirMenu({
  path,
  size,
  onVerify,
  onRegenerate,
  onRewrite,
  onCopy,
  onArchive,
  copyBlocked,
  onDelete,
}: Pick<RowProps, "onVerify" | "onRegenerate" | "onRewrite" | "onCopy" | "onArchive" | "copyBlocked" | "onDelete"> & { path: string; size: "size-8" | "size-9" }) {
  // 季目录（Season 1）按上一级的作品名搜
  const keyword = keywordFromPath(path);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={size} title="更多操作">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => afterMenuClosed(onVerify)}>
          <ShieldCheck />
          校验此目录
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => afterMenuClosed(onRegenerate)}>
          <RefreshCcw />
          重新生成
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => afterMenuClosed(onRewrite)}>
          <FileCog />
          修正内容
        </DropdownMenuItem>
        <DropdownMenuItem disabled={Boolean(copyBlocked)} title={copyBlocked ?? undefined} onSelect={() => afterMenuClosed(onCopy)}>
          <Copy />
          复制到 OpenList
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => afterMenuClosed(onArchive)}>
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
        <DropdownMenuItem variant="destructive" onSelect={() => afterMenuClosed(onDelete)}>
          <Trash2 />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function KindBadge({ row }: { row: StrmRow }) {
  if (row.isDir) return <span className="text-xs text-muted-foreground">目录</span>;
  const meta = KIND_META[row.kind];
  return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>;
}

function StrmTableRow(p: RowProps) {
  const { row } = p;
  return (
    <TableRow data-state={p.checked ? "selected" : undefined}>
      <TableCell className="w-10">
        <Checkbox checked={p.checked} onCheckedChange={(v) => p.onToggle(v === true)} aria-label={`选择 ${row.name}`} />
      </TableCell>
      <TableCell className="min-w-[240px]">
        <EntryName row={row} showPath={p.showPath} onOpen={p.onOpen} />
      </TableCell>
      <TableCell className="w-24">
        <KindBadge row={row} />
      </TableCell>
      <TableCell className="w-24 text-right text-xs text-muted-foreground tabular-nums">{row.isDir ? "-" : formatSize(row.size)}</TableCell>
      <TableCell className="w-44 text-xs text-muted-foreground tabular-nums">{fmtTime(row.mtime)}</TableCell>
      <TableCell className="w-28">
        <div className="flex justify-end gap-0.5">
          {row.isDir ? (
            <DirMenu path={row.path} size="size-8" onVerify={p.onVerify} onRegenerate={p.onRegenerate} onRewrite={p.onRewrite} onCopy={p.onCopy} onArchive={p.onArchive} copyBlocked={p.copyBlocked} onDelete={p.onDelete} />
          ) : (
            <>
              {row.kind === "strm" && (
                <>
                  <Button variant="ghost" size="icon" className="size-8" title="查看" onClick={p.onOpen}>
                    <Eye className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-8" title={p.copyBlocked ?? "复制到 OpenList"} disabled={Boolean(p.copyBlocked)} onClick={p.onCopy}>
                    <Copy className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-8" title="归档到暂存区" onClick={p.onArchive}>
                    <Archive className="size-4" />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-destructive hover:text-destructive"
                title="删除"
                onClick={p.onDelete}
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
  const { row } = p;
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <Checkbox className="mt-0.5" checked={p.checked} onCheckedChange={(v) => p.onToggle(v === true)} aria-label={`选择 ${row.name}`} />
        <div className="min-w-0 flex-1">
          <EntryName row={row} showPath={p.showPath} onOpen={p.onOpen} />
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
            <Button variant="outline" size="sm" className="h-9 flex-1" onClick={p.onOpen}>
              <FolderOpen className="size-4" />
              打开
            </Button>
            <DirMenu path={row.path} size="size-9" onVerify={p.onVerify} onRegenerate={p.onRegenerate} onRewrite={p.onRewrite} onCopy={p.onCopy} onArchive={p.onArchive} copyBlocked={p.copyBlocked} onDelete={p.onDelete} />
          </>
        ) : row.kind === "strm" ? (
          <>
            <Button variant="outline" size="sm" className="h-9 flex-1" onClick={p.onOpen}>
              <Eye className="size-4" />
              查看
            </Button>
            <Button variant="ghost" size="icon" className="size-9" title={p.copyBlocked ?? "复制到 OpenList"} disabled={Boolean(p.copyBlocked)} onClick={p.onCopy}>
              <Copy className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" className="size-9" title="归档到暂存区" onClick={p.onArchive}>
              <Archive className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-destructive hover:text-destructive"
              title="删除"
              onClick={p.onDelete}
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" className="h-9 flex-1 text-destructive hover:text-destructive" onClick={p.onDelete}>
            <Trash2 className="size-4" />
            删除
          </Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- 删除确认 ------------------------------- */

function DeleteStrmDialog({
  target,
  deleting,
  onCancel,
  onConfirm,
}: {
  target: DeleteRequest | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const paths = target?.paths ?? [];
  return (
    <AlertDialog open={target != null} onOpenChange={(open) => !open && !deleting && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">删除{target?.label}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>会从本地目录里删除（目录连同里面的内容一起删），网盘里的文件不受影响。</p>
              <ul className="space-y-0.5 font-mono text-xs text-foreground">
                {paths.slice(0, 5).map((p) => (
                  <li key={p} className="break-all">
                    {p}
                  </li>
                ))}
                {paths.length > 5 && <li className="text-muted-foreground">…等 {paths.length} 项</li>}
              </ul>
              <p className="font-medium text-destructive">此操作无法撤销。</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={deleting}
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : "删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
