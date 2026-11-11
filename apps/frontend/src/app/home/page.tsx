"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CalendarClock,
  ChevronRight,
  Edit,
  FileText,
  FolderX,
  History,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { TaskExecutionSummary } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-header";
import { PosterBackdrop } from "@/components/poster-backdrop";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading";
import { useAllPosters } from "@/hooks/use-all-posters";
import { RUN_STATUS } from "@/lib/status";
import { api, type TaskRow } from "@/lib/api";
import { usePolling } from "@/hooks/use-polling";
import { startTaskWithToast } from "@/lib/task-start";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";
import { LAYER_META } from "@/lib/mount-layer";
import { normTargetDir } from "@/lib/openlist-copy";
import { AddTaskDialog } from "./components/AddTaskDialog";

/** 有任务在跑时的状态轮询间隔 */
const POLL_INTERVAL_MS = 5000;

type Account = { name: string; accountType: string };

function relativePast(ms: number): string {
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

function relativeFuture(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, Math.floor((t - Date.now()) / 1000));
  if (d < 60) return "不到 1 分钟后";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟后`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时后`;
  return `${Math.floor(d / 86400)} 天后`;
}

function fmtTime(value: number | string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 上次执行的一句话摘要 */
function describeRun(run: TaskExecutionSummary): string {
  if (run.status === "failed") {
    // 个别文件失败时 errorMessage 已经是"3 个文件失败：a、b、c"，再带上成功数更完整
    const failed = run.summary.failedFiles ?? 0;
    if (failed > 0 && run.summary.errorMessage) return `${run.summary.errorMessage}（完成 ${run.summary.downloadedFiles}/${run.summary.totalFiles}）`;
    return run.summary.errorMessage || "失败";
  }
  if (run.status === "cancelled") return run.summary.errorMessage ? `已取消：${run.summary.errorMessage}` : "已取消";
  if (run.status === "running") return "进行中";
  const parts = [`${run.summary.downloadedFiles}/${run.summary.totalFiles} 个文件`];
  if (run.summary.deletedFiles) parts.push(`清理 ${run.summary.deletedFiles} 个`);
  return parts.join("，");
}

/** 从下拉菜单里打开确认弹框要等菜单先关掉，否则菜单还回焦点时会把弹框顶掉 */
const afterMenuClosed = (fn: () => void) => setTimeout(fn, 0);

/** 一行任务在界面上需要的全部派生状态；表格行和手机卡片共用 */
type RowState = {
  task: TaskRow;
  starting: boolean;
  running: boolean;
  /** 同账户有任务在跑或在启动：这一行的"开始"要禁用 */
  busy: boolean;
  startDisabled: boolean;
  startTitle: string;
};

const DESCRIPTION = "每个任务把网盘的一个目录同步成本地的 strm 目录；可以手动跑，也可以定时";

/** 静态导出下 useSearchParams 必须包在 Suspense 里（和 strm / 历史页一样） */
export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="space-y-6">
          <PageHeader icon={ListChecks} title="任务管理" description={DESCRIPTION} />
          <TableSkeleton rows={4} />
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const [data, setData] = useState<TaskRow[]>([]);
  // 只有首次加载显示骨架；之后的刷新和轮询表格留在屏幕上
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // 编辑 / 删除 / 清空目录弹框放在页面层，由当前操作的那一行驱动，不在每一行里各放一份
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaskRow | null>(null);
  const [clearTarget, setClearTarget] = useState<TaskRow | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [startingTasks, setStartingTasks] = useState<Set<string>>(new Set());
  /** 复制到 OpenList 的队列按任务数一下：复制中几个、失败几个（队列的详情在云下载页） */
  const [copyStats, setCopyStats] = useState<Map<string, { pending: number; failed: number }>>(new Map());
  // 列表请求的序号：慢的旧响应不能盖掉新状态（比如启动前发出的轮询把乐观标上的 processing 改回去）
  const listSeqRef = useRef(0);
  const router = useRouter();
  const search = useSearchParams();
  const wantNew = search.get("new") === "1";
  const wantEdit = search.get("edit") ?? "";

  /** 拉任务列表。silent：后台轮询用，不转刷新按钮、失败也不弹提示（每 5 秒一条太吵） */
  const fetchTasks = useCallback(async (silent = false) => {
    const seq = ++listSeqRef.current;
    if (!silent) setRefreshing(true);
    // 复制队列是锦上添花：读不到就不显示，不影响任务列表
    void api.copy
      .list(500)
      .then((q) => {
        if (seq !== listSeqRef.current) return;
        const stats = new Map<string, { pending: number; failed: number }>();
        for (const c of q.items) {
          if (!c.taskId || (c.status !== "pending" && c.status !== "failed")) continue;
          const s = stats.get(c.taskId) ?? { pending: 0, failed: 0 };
          if (c.status === "pending") s.pending++;
          else s.failed++;
          stats.set(c.taskId, s);
        }
        setCopyStats(stats);
      })
      .catch(() => {});
    try {
      const rows = await api.tasks.list();
      if (seq === listSeqRef.current) setData(rows);
    } catch (err) {
      if (!silent) toast.error(apiErrorMessage(err, "获取任务列表失败"));
    } finally {
      setLoaded(true);
      if (!silent) setRefreshing(false);
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      setAccountsLoading(true);
      const list = await api.accounts.list();
      setAccounts(list.map((a) => ({ name: a.name, accountType: a.accountType })));
    } catch (err) {
      toast.error(apiErrorMessage(err, "获取账户列表失败"));
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    fetchAccounts();
  }, [fetchTasks, fetchAccounts]);

  // 命令面板用 /home?new=1 和 ?edit=<id> 直接开弹框。开完把参数抹掉，
  // 否则刷新或后退会再弹一次；抹掉之后 wantNew / wantEdit 变空，这个 effect 自己就停了
  useEffect(() => {
    if (!wantNew && !wantEdit) return;
    if (wantNew) {
      setEditing(null);
      setEditorOpen(true);
    } else {
      // 编辑要等列表回来才知道是哪一行
      if (!loaded) return;
      const task = data.find((t) => t.id === wantEdit);
      if (!task) toast.error("找不到这个任务，可能已经删了");
      else {
        setEditing(task);
        setEditorOpen(true);
      }
    }
    router.replace("/home");
  }, [wantNew, wantEdit, loaded, data, router]);

  // 有任务在跑时每 5 秒刷一次状态；页面切到后台不刷，切回来立刻刷一次
  const hasProcessing = data.some((task) => task.status === "processing");
  usePolling(() => fetchTasks(true), POLL_INTERVAL_MS, { enabled: hasProcessing });

  /* ---- 海报墙：整个 strm 库的作品。纯装饰：有任务在跑或在启动就淡出，把「在动」让给那一行 ---- */
  // 任务表的指纹：增删任务、改本地目录才重拉，每 5 秒的状态轮询不会触发
  const postersKey = loaded ? data.map((t) => `${t.id}\u0000${t.targetPath}`).join("\n") : "";
  const wallPosters = useAllPosters(postersKey);
  const wallMuted = hasProcessing || startingTasks.size > 0;

  // 有任务在跑或在启动的账户：同账户的任务互斥
  const busyAccounts = useMemo(() => {
    const set = new Set<string>();
    for (const task of data) {
      if (task.status === "processing" || startingTasks.has(task.id)) set.add(task.account);
    }
    return set;
  }, [data, startingTasks]);

  const deleteTask = async (task: TaskRow) => {
    try {
      await api.tasks.remove(task.id);
      toast.success("任务已删除");
      setDeleteTarget(null);
      fetchTasks();
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
    }
  };

  const startTask = useCallback(async (id: string) => {
    setStartingTasks((prev) => new Set(prev).add(id));
    try {
      // 提示都在 startTaskWithToast 里；这里只管把起来了的那一行乐观标成执行中
      if (await startTaskWithToast(id)) {
        // 同时作废在途的列表响应，免得启动前发出的轮询把它改回 pending。之后的轮询会拿到真实状态
        listSeqRef.current++;
        setData((prev) => prev.map((task) => (task.id === id ? { ...task, status: "processing" as const } : task)));
      }
    } finally {
      setStartingTasks((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // 起不来的也会进历史：把"上次执行"刷出来
      void fetchTasks(true);
    }
  }, [fetchTasks]);

  // 取消任务；不管成没成功都重新拉一次状态
  const cancelTask = useCallback(async (id: string) => {
    try {
      await api.tasks.cancel(id);
      toast.success("任务已取消");
    } catch (err) {
      toast.error(apiErrorMessage(err, "任务取消失败"));
    } finally {
      void fetchTasks(true);
    }
  }, [fetchTasks]);

  /** 运行中看实时日志；不在运行就去看这个任务的执行历史 */
  const openLogs = (task: TaskRow) => {
    const id = encodeURIComponent(task.id);
    router.push(task.status === "processing" ? `/log?taskId=${id}` : `/history?taskId=${id}`);
  };

  const openHistory = (task: TaskRow) => router.push(`/history?taskId=${encodeURIComponent(task.id)}`);

  const openEditor = (task: TaskRow) => {
    setEditing(task);
    setEditorOpen(true);
  };

  const clearDirectory = async (task: TaskRow) => {
    try {
      await api.system.clearDirectory(task.targetPath);
      toast.success(`已清空 ${task.targetPath}`);
      setClearTarget(null);
    } catch (error: unknown) {
      toast.error(apiErrorBody(error).message || "清空目录失败");
    }
  };

  const rowState = (task: TaskRow): RowState => {
    const starting = startingTasks.has(task.id);
    const running = task.status === "processing";
    const busy = busyAccounts.has(task.account);
    return {
      task,
      starting,
      running,
      busy,
      startDisabled: starting || running || busy,
      startTitle: starting ? "启动中..." : busy ? `账户 ${task.account} 有任务正在运行` : "开始同步",
    };
  };

  /** 新建和编辑共用页面底部那一个弹框：editing 为空就是新建 */
  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const newTaskButton = (
    <Button onClick={openCreate}>
      <Plus />
      新建任务
    </Button>
  );

  /* ---------- 表格行和卡片共用的几块 ---------- */

  const accountBadge = ({ task, busy }: RowState) => (
    <Badge
      variant="outline"
      className={`shrink-0 font-normal ${busy ? "border-warning/40 text-warning" : "text-muted-foreground"}`}
      title={`账户 ${task.account}（${task.accountType ?? "?"}）`}
    >
      {task.account}
    </Badge>
  );

  const stateBadge = ({ starting, running }: RowState) =>
    starting ? (
      <StatusBadge tone="neutral">
        <Loader2 className="animate-spin" />
        启动中
      </StatusBadge>
    ) : running ? (
      <StatusBadge tone="info" pulse>
        运行中
      </StatusBadge>
    ) : (
      <StatusBadge tone="neutral">空闲</StatusBadge>
    );

  /** 清空目录和删除都是不可逆操作，收进菜单，别和"开始"并排等着误点 */
  const moreMenu = ({ task, running }: RowState, size: "size-8" | "size-9") => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={size}
          title={running ? "运行中不能清空或删除" : "更多操作"}
          disabled={running}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => afterMenuClosed(() => setClearTarget(task))}>
          <FolderX />
          清空本地目录
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => afterMenuClosed(() => setDeleteTarget(task))}>
          <Trash2 />
          删除任务
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /**
   * 开着「复制到 OpenList」的任务：一个「复制」标，队列里有在跑 / 失败的再各给一个，点开是云下载页的复制队列。
   * 开着却复制不了（比如这个账号在设置页没填挂载根）换成警示色的「复制没生效」，点开去改的地方：
   * 后端说的 copyBlockedAt——挂载层的账号和路径在「网盘挂载」里那一家的面板，目标目录在「复制」一节；
   * 挂载层账号的任务不在设置页改，打开任务设置把复制关掉
   */
  const copyFixHref = (task: TaskRow): string | null => {
    const at = task.copyBlockedAt;
    if (at === null) return null;
    if (at === "openlist" || at === "cd2") return `/settings#${LAYER_META[at].anchor}`;
    return "/settings#openlist-copy";
  };
  const copyBadges = (task: TaskRow) => {
    const stat = copyStats.get(task.id);
    if (!task.copyToOpenlist?.enabled && !stat) return null;
    const open = () => router.push("/offline#copy-queue");
    return (
      <>
        {task.copyToOpenlist?.enabled &&
          (task.copyBlocked ? (
            <button
              type="button"
              onClick={() => {
                const href = copyFixHref(task);
                if (href) router.push(href);
                else openEditor(task);
              }}
              title={`${task.copyBlocked}。开着也不会复制，${copyFixHref(task) ? "点这里去设置页" : "点这里打开任务设置"}`}
            >
              <StatusBadge tone="warning">复制没生效</StatusBadge>
            </button>
          ) : (
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5 py-0"
              title={`新文件会复制到 ${normTargetDir(task.copyToOpenlist.dstDir) || "设置页的默认目标目录"}${
                task.copyToOpenlist.afterCopy === "archive" ? "，复制完把网盘上那份挪进任务目录下的「归档」" : task.copyToOpenlist.afterCopy === "delete" ? "，复制完删掉网盘上那份" : ""
              }`}
            >
              复制
            </Badge>
          ))}
        {stat && stat.pending > 0 && (
          <button type="button" onClick={open} title="复制队列在云下载页">
            <StatusBadge tone="info" pulse className="tabular-nums">
              复制中 {stat.pending}
            </StatusBadge>
          </button>
        )}
        {stat && stat.failed > 0 && (
          <button type="button" onClick={open} title="到云下载页的复制队列里重试">
            <StatusBadge tone="danger" className="tabular-nums">
              复制失败 {stat.failed}
            </StatusBadge>
          </button>
        )}
      </>
    );
  };

  /* ---------- 桌面：表格行 ---------- */

  const renderRow = (state: RowState) => {
    const { task, starting, running, startDisabled, startTitle } = state;
    const run = task.lastRun;
    const runMeta = run ? RUN_STATUS[run.status] : null;
    return (
      // 正在跑的行：行底色带一点品牌色 + 首格一条呼吸的竖条（globals.css）
      <TableRow key={task.id} data-running={running ? "true" : undefined}>
        <TableCell className="align-top">
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              {accountBadge(state)}
              <span className="break-all text-sm font-medium" title={task.originPath}>
                {task.originPath}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="break-all font-mono" title={`本地路径：${task.targetPath}`}>
                → {task.targetPath}
              </span>
              {task.enable302 && (
                <Badge variant="secondary" className="shrink-0 px-1.5 py-0" title="Emby 302 直链已开启">
                  302
                </Badge>
              )}
              {copyBadges(task)}
            </div>
          </div>
        </TableCell>
        <TableCell className="align-top">
          {task.cronExpression ? (
            <div className="space-y-1">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{task.cronExpression}</code>
              {task.nextRunAt && (
                <div
                  className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground"
                  title={`下次：${fmtTime(task.nextRunAt)}`}
                >
                  <CalendarClock className="size-3" />
                  {relativeFuture(task.nextRunAt)}
                </div>
              )}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">手动</span>
          )}
        </TableCell>
        <TableCell className="align-top">
          {run && runMeta ? (
            // 整块可点，进这个任务的执行历史；hover 有底色和箭头，看得出是个入口
            <button
              type="button"
              className="group -mx-2 -my-1 flex w-full max-w-[250px] min-w-0 flex-col items-start gap-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted"
              title={`${fmtTime(run.startTime)}\n${describeRun(run)}\n点击查看执行历史`}
              onClick={() => openHistory(task)}
            >
              <div className="flex items-center gap-2">
                <StatusBadge tone={runMeta.tone} pulse={run.status === "running"}>
                  {runMeta.label}
                </StatusBadge>
                <span className="text-xs whitespace-nowrap text-muted-foreground">{relativePast(run.startTime)}</span>
                <ChevronRight className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <div className={`w-full truncate text-xs ${run.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                {describeRun(run)}
              </div>
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">还没跑过</span>
          )}
        </TableCell>
        <TableCell className="align-top">{stateBadge(state)}</TableCell>
        <TableCell className="align-top">
          <div className="flex justify-end gap-0.5">
            {running ? (
              <Button variant="ghost" size="icon" className="size-8" title="取消任务" onClick={() => cancelTask(task.id)}>
                <Square />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                title={startTitle}
                disabled={startDisabled}
                onClick={() => startTask(task.id)}
              >
                {starting ? <Loader2 className="animate-spin" /> : <Play />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title={running ? "实时日志" : "执行历史"}
              onClick={() => openLogs(task)}
            >
              {running ? <FileText /> : <History />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title={running ? "运行中不能编辑" : "编辑任务"}
              disabled={running}
              onClick={() => openEditor(task)}
            >
              <Edit />
            </Button>
            {moreMenu(state, "size-8")}
          </div>
        </TableCell>
      </TableRow>
    );
  };

  /* ---------- 手机：一行一张卡，按钮带文字、够手指点 ---------- */

  const renderCard = (state: RowState) => {
    const { task, starting, running, busy, startDisabled, startTitle } = state;
    const run = task.lastRun;
    const runMeta = run ? RUN_STATUS[run.status] : null;
    return (
      <div key={task.id} className={`rounded-xl border bg-card p-4 ${running ? "running-outline" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {accountBadge(state)}
              <span className="break-all text-sm font-medium">{task.originPath}</span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="break-all font-mono">→ {task.targetPath}</span>
              {task.enable302 && (
                <Badge variant="secondary" className="shrink-0 px-1.5 py-0">
                  302
                </Badge>
              )}
              {copyBadges(task)}
            </div>
          </div>
          {stateBadge(state)}
        </div>

        <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-3.5 shrink-0" />
            {task.cronExpression ? (
              <span className="flex flex-wrap items-center gap-x-2">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{task.cronExpression}</code>
                {task.nextRunAt && <span>下次 {relativeFuture(task.nextRunAt)}</span>}
              </span>
            ) : (
              <span>手动触发</span>
            )}
          </div>
          <div className="flex items-start gap-2">
            <History className="mt-0.5 size-3.5 shrink-0" />
            {run && runMeta ? (
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <StatusBadge tone={runMeta.tone} pulse={run.status === "running"}>
                  {runMeta.label}
                </StatusBadge>
                <span>{relativePast(run.startTime)}</span>
                <span className={`break-all ${run.status === "failed" ? "text-destructive" : ""}`}>{describeRun(run)}</span>
                {/* 手机没有 hover，入口要写成字 */}
                <button type="button" className="inline-flex items-center text-brand" onClick={() => openHistory(task)}>
                  查看历史
                  <ChevronRight className="size-3" />
                </button>
              </span>
            ) : (
              <span>还没跑过</span>
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 border-t pt-3">
          {running ? (
            <Button variant="outline" size="sm" className="h-9 flex-1" onClick={() => cancelTask(task.id)}>
              <Square />
              取消
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-9 flex-1"
              disabled={startDisabled}
              onClick={() => startTask(task.id)}
            >
              {starting ? <Loader2 className="animate-spin" /> : <Play />}
              {starting ? "启动中" : "开始"}
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-9 flex-1" onClick={() => openLogs(task)}>
            {running ? <FileText /> : <History />}
            {running ? "日志" : "历史"}
          </Button>
          <Button variant="outline" size="sm" className="h-9 flex-1" disabled={running} onClick={() => openEditor(task)}>
            <Edit />
            编辑
          </Button>
          {moreMenu(state, "size-9")}
        </div>
        {busy && !running && !starting && <p className="mt-2 text-xs text-muted-foreground">{startTitle}</p>}
      </div>
    );
  };

  let body: React.ReactNode;
  if (!loaded) {
    body = <TableSkeleton rows={4} />;
  } else if (data.length === 0) {
    body = (
      <EmptyState
        icon={ListChecks}
        title="还没有任务"
        description="选一个网盘目录和本地目录就能开始；可以手动跑，也可以定时"
        action={newTaskButton}
      />
    );
  } else {
    const states = data.map(rowState);
    body = (
      <>
        {/* 手机：卡片；md 以上：表格。两份只是排版不同，数据和按钮逻辑都在上面共用 */}
        <div className="space-y-3 md:hidden">{states.map(renderCard)}</div>
        {/* 半透明 + 毛玻璃：海报墙要从表格后面透出来，又不能影响读字（和 strm 页一样） */}
        <div className="hidden overflow-hidden rounded-xl border bg-card/60 backdrop-blur-sm md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[280px]">任务</TableHead>
                <TableHead className="w-40">定时</TableHead>
                <TableHead className="w-64">上次执行</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-36 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{states.map(renderRow)}</TableBody>
          </Table>
        </div>
      </>
    );
  }

  return (
    <div className="relative z-0 space-y-6">
      {/* 海报背景挂在这层 relative z-0 里面、自己是 -z-10：在内容列的底色之上、面板和文字之下，
          侧栏（fixed z-10）和顶栏（sticky z-20）照样盖在它上面 */}
      <PosterBackdrop mode="stream" posters={wallPosters} muted={wallMuted} />
      <PageHeader
        icon={ListChecks}
        title="任务管理"
        description={DESCRIPTION}
        actions={
          <>
            <Button variant="outline" onClick={() => fetchTasks()} disabled={refreshing}>
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              刷新
            </Button>
            {newTaskButton}
          </>
        }
      />

      {body}

      {/* 新建 / 编辑弹框：整页一个，编辑哪一行就喂哪一行的数据，新建时 task 为空 */}
      <AddTaskDialog
        task={editing ?? undefined}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        accounts={accounts}
        accountsLoading={accountsLoading}
        onSuccess={() => fetchTasks()}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除任务</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p className="font-medium break-all text-foreground">
                  {deleteTarget?.originPath} → {deleteTarget?.targetPath}
                </p>
                <p>账户 {deleteTarget?.account}。只删除任务定义和它的定时；本地已生成的 strm 不会被删。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) void deleteTask(deleteTarget);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearTarget !== null} onOpenChange={(open) => !open && setClearTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空本地目录</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  将删除本地目录 <span className="font-medium break-all text-foreground">{clearTarget?.targetPath}</span> 下的所有文件和子目录，网盘不受影响。
                </p>
                <p className="font-medium text-destructive">此操作无法撤销；下次同步会重新生成 strm。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                if (clearTarget) void clearDirectory(clearTarget);
              }}
            >
              确认清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
