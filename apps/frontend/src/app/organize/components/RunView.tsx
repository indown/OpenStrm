"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, ChevronDown, ChevronRight, Film, Loader2, Play, RefreshCw, RotateCw, Search, Square, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { OrganizeConflictChoice, OrganizeConflictResolution, OrganizeItem, OrganizeRun, OrganizeRunDetail, OrganizeRunStatus, OrganizeUnit, OrganizeUnitPatch } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { PosterBackdrop } from "@/components/poster-backdrop";
import { StatusBadge } from "@/components/status-badge";
import { ProgressBar } from "@/components/progress-bar";
import { EmptyState } from "@/components/empty-state";
import { Spinner, TableSkeleton } from "@/components/loading";
import { api, type TaskRow } from "@/lib/api";
import { usePolling } from "@/hooks/use-polling";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";
import { accountLabel } from "@/lib/drive";
import { fmtTime } from "@/lib/format";
import { NAMING_LABEL, RUN_STATUS_META, TRIGGER_LABEL, handPicked, isBusyStatus, notifyOrganizeChanged } from "@/lib/organize";
import { AdjustDialog } from "./AdjustDialog";
import { FailurePanel } from "./FailurePanel";
import { MatchDialog } from "@/components/MatchDialog";
import { RenameDialog } from "./RenameDialog";
import { UnitList } from "./UnitList";
import { POLL_MS, plannedText, toastRunError } from "./helpers";

/** 执行 / 撤销中每隔几次 summary 拉一次完整详情：单元卡上的数字、展开着的文件表跟着变 */
/** 背景里最多铺这么多张海报，一屏也放不下更多 */
const BACKDROP_TILES = 24;

const FULL_EVERY = 5;

export function RunView({
  runId,
  tasks,
  onClose,
  onOpenRun,
  onLoaded,
}: {
  runId: string;
  tasks: TaskRow[] | null;
  onClose: () => void;
  onOpenRun: (id: string) => void;
  /** 第一次读到这次整理时告诉页面（页面把任务下拉框和范围切过来） */
  onLoaded?: (run: OrganizeRun) => void;
}) {
  const [detail, setDetail] = useState<OrganizeRunDetail | null>(null);
  /** 完整详情拉了几次：展开着的文件清单按它重拉 */
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [matching, setMatching] = useState<OrganizeUnit | null>(null);
  const [adjusting, setAdjusting] = useState<OrganizeUnit | null>(null);
  /** 冲突项「自己改名」弹框：要改的项和它所在的单元 */
  const [renaming, setRenaming] = useState<{ unit: OrganizeUnit; item: OrganizeItem } | null>(null);
  const [confirm, setConfirm] = useState<"apply" | "revert" | "delete" | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showScopes, setShowScopes] = useState(false);
  /** 正在保存修改的单元（换匹配 / 季集偏移 / 勾选 / 按文件勾选） */
  const [patching, setPatching] = useState<ReadonlySet<string>>(new Set());
  /** 失败面板在放弃（要在网盘上改回原名） */
  const [panelWorking, setPanelWorking] = useState(false);
  const fullSeq = useRef(0);
  const sumSeq = useRef(0);
  const lastStatus = useRef<OrganizeRunStatus | null>(null);
  const reported = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  /**
   * 状态变了（包括第一次读到）：待处理可能跟着变（预览好了待执行、执行完有失败、撤销没退完…），让侧栏角标刷新。
   * 第一次读到也要算：预览常常在页面第一次读详情之前就做完了，看不到「进行中 → 待执行」这一下
   */
  const seen = useCallback((status: OrganizeRunStatus) => {
    if (lastStatus.current !== status) notifyOrganizeChanged();
    lastStatus.current = status;
  }, []);

  const load = useCallback(async () => {
    const n = ++fullSeq.current;
    try {
      const d = await api.organize.getRun(runId);
      if (n !== fullSeq.current) return;
      seen(d.run.status);
      setDetail(d);
      setVersion((v) => v + 1);
      setError(null);
      return d;
    } catch (err) {
      if (n !== fullSeq.current) return;
      setError(apiErrorMessage(err, "读取整理记录失败"));
    }
    return null;
  }, [runId, seen]);

  /** 进行中只拉 run 和开关（不带单元和项）；一结束就拉一次完整详情，别拿「待执行 + 0 个单元」闪一下 */
  const loadSummary = useCallback(async () => {
    const n = ++sumSeq.current;
    try {
      const s = await api.organize.summary(runId);
      if (n !== sumSeq.current) return;
      seen(s.run.status);
      if (!isBusyStatus(s.run.status)) {
        void load();
        return;
      }
      setDetail((d) => (d ? { ...d, ...s } : d));
    } catch {
      /* 下一轮再拉 */
    }
  }, [runId, seen, load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!detail || reported.current) return;
    reported.current = true;
    onLoaded?.(detail.run);
  }, [detail, onLoaded]);

  const status = detail?.run.status;

  /** 铺在后面的海报：这次识别出来的，按作品去重。要在早返回之前算，hook 的顺序不能变 */
  const backdropPosters = useMemo(
    () =>
      Array.from(
        new Map(
          (detail?.units ?? [])
            .filter((u) => u.match?.posterUrl)
            .map((u) => [u.match?.tmdbId ?? u.key, { key: u.key, url: u.match?.posterUrl ?? "" }] as const),
        ).values(),
      ).slice(0, BACKDROP_TILES),
    [detail],
  );
  // 进行中隔几秒拉一次摘要，每 FULL_EVERY 次拉一次全量（清单、日志）
  const pollTick = useRef(0);
  usePolling(
    () => {
      pollTick.current += 1;
      return pollTick.current % FULL_EVERY === 0 ? load() : loadSummary();
    },
    POLL_MS,
    { enabled: !!status && isBusyStatus(status) },
  );

  // 日志展开着就一直停在最底下
  const logLength = detail?.run.log.length ?? 0;
  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [showLog, logLength]);

  const markPatching = (keys: string[], on: boolean) =>
    setPatching((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  /** 改单元：进行中这个单元转圈，执行 / 撤销 / 删除先禁用（后端也会回 409，这里是别让人点）；成功返回 true */
  const patchUnit = async (unit: OrganizeUnit, patch: OrganizeUnitPatch): Promise<boolean> => {
    markPatching([unit.key], true);
    try {
      await api.organize.patchUnit(runId, unit.key, patch);
      await load();
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, "修改失败"));
      // 失败多半是这次预览已经不能改了（执行了 / 取消了 / 进程重启过）：刷新一下，页面照实显示
      await load();
      return false;
    } finally {
      markPatching([unit.key], false);
    }
  };

  /** 刷新一部作品的 TMDB 信息：跳过缓存重新拉详情和季集，按新信息重新规划；信息没变后端什么都不动 */
  const refreshUnit = async (unit: OrganizeUnit) => {
    const before = detail?.planVersion;
    markPatching([unit.key], true);
    try {
      const next = await api.organize.patchUnit(runId, unit.key, { refresh: true });
      const d = await load();
      const a = unit.match;
      const b = next.match;
      if (a && b && a.title !== b.title) toast.success(`「${a.title}」→「${b.title}」，已按新译名重新规划`);
      else if (a && b && (a.year !== b.year || unit.dstRoot !== next.dstRoot)) toast.success(`「${b.title}」的 TMDB 信息有更新，已重新规划`);
      else if (d?.planVersion && before && d.planVersion !== before) toast.success(`「${b?.title ?? unit.rawName}」的集标题 / 海报有更新，清单已重新规划`);
      else toast.info("TMDB 上的信息没有变化");
    } catch (err) {
      toast.error(apiErrorMessage(err, "刷新 TMDB 信息失败"));
      await load();
    } finally {
      markPatching([unit.key], false);
    }
  };

  /** 批量勾选（一次重规划）；「只选把握大的」是把握大的勾上、其余取消，两次批量 */
  const bulk = async (steps: Array<{ keys: string[]; selected: boolean }>) => {
    const keys = steps.flatMap((s) => s.keys);
    if (keys.length === 0) return;
    markPatching(keys, true);
    try {
      let changed = 0;
      for (const s of steps) if (s.keys.length > 0) changed += (await api.organize.patchUnits(runId, s.keys, { selected: s.selected })).changed;
      if (changed === 0) toast.info("列出的作品已经是这样勾的了");
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "修改失败"));
      await load();
    } finally {
      markPatching(keys, false);
    }
  };

  /** 按文件勾选：取消勾选的文件留在原处，跟着它的字幕 / nfo 一起留下 */
  const toggleItems = async (unit: OrganizeUnit, ids: string[], selected: boolean) => {
    markPatching([unit.key], true);
    try {
      await api.organize.patchItems(runId, ids, { selected });
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "修改失败"));
      await load();
    } finally {
      markPatching([unit.key], false);
    }
  };

  /** 冲突项选了办法：重新规划一遍（删除 / 覆盖只是写进计划，真删要等执行） */
  const resolveItem = async (unit: OrganizeUnit, ids: string[], resolve: OrganizeConflictResolution | null): Promise<boolean> => {
    markPatching([unit.key], true);
    try {
      await api.organize.patchItems(runId, ids, { resolve });
      await load();
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, "修改失败"));
      await load();
      return false;
    } finally {
      markPatching([unit.key], false);
    }
  };

  /** 下拉里选的：自己改名先弹框问名字，其余直接重规划 */
  const pickResolve = (unit: OrganizeUnit, item: OrganizeItem, how: OrganizeConflictChoice | "stay") => {
    if (how === "custom") setRenaming({ unit, item });
    else void resolveItem(unit, [item.id], how === "stay" ? null : { how });
  };

  const repreview = async (opts: { refreshTmdb?: boolean } = {}) => {
    setBusy(true);
    try {
      const next = await api.organize.repreview(runId, opts);
      toast.success(opts.refreshTmdb ? "按同一范围重新预览并刷新 TMDB 信息，请稍候" : "按同一范围重新预览，请稍候");
      notifyOrganizeChanged();
      onOpenRun(next.id);
    } catch (err) {
      toastRunError(err, "重新预览失败", onOpenRun);
    } finally {
      setBusy(false);
    }
  };

  const act = async (kind: "apply" | "cancel" | "revert" | "delete") => {
    setBusy(true);
    try {
      // 带上打开时看到的那一版：之后清单被改过（比如智能体改的）后端会拒，下面重新拉一遍给人看
      if (kind === "apply") await api.organize.apply(runId, undefined, detail?.planVersion);
      else if (kind === "cancel") await api.organize.cancel(runId);
      else if (kind === "revert") await api.organize.revert(runId);
      else {
        await api.organize.remove(runId);
        toast.success("已删除这条整理记录");
        notifyOrganizeChanged();
        onClose();
        return;
      }
      toast.success(kind === "apply" ? "开始执行" : kind === "cancel" ? "已取消" : "开始撤销");
      notifyOrganizeChanged();
      await load();
    } catch (err) {
      if (apiErrorBody(err).code === "PLAN_CHANGED") {
        toast.warning("清单在你打开之后被改过了（可能是智能体改的），已刷新，看一眼再执行");
        await load();
      } else {
        toastRunError(err, "操作失败", onOpenRun);
      }
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (error && !detail) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="读不到这条整理记录"
        description={error}
        action={
          <Button variant="outline" onClick={onClose}>
            返回
          </Button>
        }
      />
    );
  }
  if (!detail) return <TableSkeleton rows={4} />;

  const { run, units, counts, dirCount, groups, revertable, applicable, editable, executed, outdated } = detail;
  const outdatedRunId = outdated?.kind === "changed" ? outdated.runId : undefined;
  const blockedBy = revertable.blockedBy;
  const meta = RUN_STATUS_META[run.status];
  const canApply = applicable.ok;
  const canCancel = isBusyStatus(run.status);
  const reverting = run.stage === "revert";
  // 改单元 / 放弃还在保存的时候不给执行、撤销、删除（后端也会回 409）
  const locked = busy || panelWorking || patching.size > 0;
  // 预览没做完（列目录 / 识别中途失败或被取消）：没有单元，也没有统计可看
  const previewFailed = units.length === 0 && run.stage === "apply" && (run.status === "failed" || run.status === "cancelled");
  const mirrorLeft = run.stats.failedByKind.mirror;
  const unsure = run.naming === "local" ? 0 : units.filter((u) => u.selected && (!u.match || u.match.confidence !== "high")).length;
  const task = tasks?.find((t) => t.id === run.taskId) ?? null;
  const origin = task ? task.originPath.replace(/\/+$/, "") : "";
  const full = (p: string) => (origin ? `${origin}/${p}` : p);
  const manualScopes = handPicked(run.trigger);

  return (
    <div className="space-y-4">
      {/* 这次识别出来的海报铺在后面。执行 / 撤销一开始就淡出——那时候该动的是进度条 */}
      <PosterBackdrop mode="stream" posters={backdropPosters} muted={isBusyStatus(run.status)} />
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={meta.tone} pulse={meta.pulse}>
                {meta.label}
              </StatusBadge>
              <span className="text-xs text-muted-foreground">
                {TRIGGER_LABEL[run.trigger]} · {fmtTime(run.createdAt * 1000)}
              </span>
              {run.naming === "local" && (
                <StatusBadge tone="info" title="名字和位置照本地 strm 的目录结构来，不经过 TMDB 识别">
                  {NAMING_LABEL.local}
                </StatusBadge>
              )}
            </div>
            {task && (
              <div className="break-all text-xs text-muted-foreground">
                任务：{accountLabel(task.account, task.accountType)} · {task.originPath} → {task.targetPath}
              </div>
            )}
            <div className="break-all text-sm">
              范围：
              {run.scopePaths.length === 0 ? (
                run.scopePath ? (
                  full(run.scopePath)
                ) : (
                  "整个任务"
                )
              ) : (
                <button type="button" className="inline-flex items-center gap-0.5 hover:text-brand" onClick={() => setShowScopes((v) => !v)}>
                  {manualScopes ? `${run.scopePaths.length} 个目录` : `${run.scopePaths.length} 个新增路径`}
                  {showScopes ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                </button>
              )}
            </div>
            {showScopes && run.scopePaths.length > 0 && (
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                {run.scopePaths.map((p) => (
                  <li key={p} className="break-all">
                    {full(p)}
                  </li>
                ))}
              </ul>
            )}
            {run.error && !previewFailed && <div className="break-all text-xs text-destructive">{run.error}</div>}
            {!revertable.ok && blockedBy && (
              <div className="text-xs text-muted-foreground">
                不能撤销：{revertable.reason}
                <button type="button" className="ml-1 text-brand hover:underline" onClick={() => onOpenRun(blockedBy.id)}>
                  打开那一次（{fmtTime(blockedBy.createdAt * 1000)}）
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            {canCancel && (
              <Button variant="outline" size="sm" onClick={() => void act("cancel")} disabled={busy}>
                <Square className="size-4" />
                取消
              </Button>
            )}
            {(run.status === "ready" || (!executed && (run.status === "cancelled" || run.status === "failed"))) && (
              <div className="flex items-center">
                <Button variant="outline" size="sm" className="rounded-r-none" onClick={() => void repreview()} disabled={locked} title="按同一范围重新列目录、识别、规划">
                  <Search className="size-4" />
                  重新预览
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="rounded-l-none border-l-0 px-1.5 has-[>svg]:px-1.5" disabled={locked} aria-label="更多重新预览的方式">
                      <ChevronDown className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-w-[min(22rem,calc(100vw-2rem))]">
                    <DropdownMenuItem className="flex-col items-start gap-0.5" onSelect={() => void repreview({ refreshTmdb: true })}>
                      <span>重新预览并刷新 TMDB 信息</span>
                      <span className="text-xs text-muted-foreground">
                        跳过缓存重新拉每部作品的详情和季集。和重新预览一样，没「记住」的手动改动不保留；只想刷新某一部，在它那一行点「刷新 TMDB」
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
            {canApply && (
              <Button size="sm" onClick={() => setConfirm("apply")} disabled={locked}>
                {run.status === "ready" ? <Play className="size-4" /> : <RotateCw className="size-4" />}
                {run.status === "ready" ? `执行 ${run.stats.planned} 项` : `重试失败项（${applicable.count}）`}
              </Button>
            )}
            {revertable.ok && (
              <Button variant={reverting ? "default" : "outline"} size="sm" onClick={() => setConfirm("revert")} disabled={locked}>
                <Undo2 className="size-4" />
                {reverting ? "继续撤销" : "撤销"}
              </Button>
            )}
            {!isBusyStatus(run.status) && (
              <Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" title="删除记录" onClick={() => setConfirm("delete")} disabled={locked}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </div>

        {run.progress && isBusyStatus(run.status) && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="break-all">{run.progress.message}</span>
              {run.progress.total > 0 && (
                <span className="tabular-nums">
                  {run.progress.done} / {run.progress.total}
                </span>
              )}
            </div>
            {/* 识别阶段拿不到总数，走不确定态：一小段来回漂，不假装知道百分比 */}
            <ProgressBar
              percent={run.progress.total > 0 ? (run.progress.done / run.progress.total) * 100 : 0}
              running
              indeterminate={run.progress.total === 0}
            />
          </div>
        )}

        {!previewFailed && (
          <div className="flex flex-wrap gap-2 text-xs">
            <StatusBadge tone="neutral" className="tabular-nums">
              {run.stats.units} 部作品
            </StatusBadge>
            <StatusBadge tone="brand" className="tabular-nums">
              {run.stats.planned} 项要动
            </StatusBadge>
            {run.stats.keep > 0 && <StatusBadge tone="neutral" className="tabular-nums">{run.stats.keep} 项已规范</StatusBadge>}
            {run.stats.conflicts > 0 && <StatusBadge tone="danger" className="tabular-nums">{run.stats.conflicts} 项冲突</StatusBadge>}
            {run.stats.skipped > 0 && <StatusBadge tone="neutral" className="tabular-nums">{run.stats.skipped} 项跳过</StatusBadge>}
            {!reverting && run.stats.done > 0 && <StatusBadge tone="success" className="tabular-nums">{run.stats.done} 项完成</StatusBadge>}
            {!reverting && run.stats.failed > 0 && <StatusBadge tone="danger" className="tabular-nums">{run.stats.failed} 项失败</StatusBadge>}
            {reverting && run.stats.reverted > 0 && <StatusBadge tone="success" className="tabular-nums">{run.stats.reverted} 项已退回</StatusBadge>}
            {reverting && run.stats.notReverted > 0 && <StatusBadge tone="danger" className="tabular-nums">{run.stats.notReverted} 项没退回</StatusBadge>}
            {mirrorLeft > 0 && <StatusBadge tone="warning" className="tabular-nums">{mirrorLeft} 项本地未同步</StatusBadge>}
            {unsure > 0 && run.status === "ready" && <StatusBadge tone="warning" className="tabular-nums">{unsure} 部识别把握不大</StatusBadge>}
          </div>
        )}

        {run.naming === "local" && run.status === "ready" && task && (task.removeExtraFiles || task.cronExpression) && (
          <div className="flex items-start gap-1 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span>
              {task.removeExtraFiles ? "任务开着「删除本地多余文件」：执行前别跑同步，不然改过名的 strm 会被当多余删掉。" : ""}
              {task.cronExpression ? "任务有定时同步：整理进行中那一轮会跳过，建议先把这次整理执行完。" : ""}
            </span>
          </div>
        )}

        {run.log.length > 0 && (
          <div>
            <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowLog((v) => !v)}>
              {showLog ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              日志（{run.log.length}）
            </button>
            {showLog && (
              <pre ref={logRef} className="mt-2 max-h-60 overflow-auto rounded-md bg-muted/50 p-2 text-xs leading-relaxed">
                {run.log.join("\n")}
              </pre>
            )}
          </div>
        )}
      </section>

      {run.status === "ready" && (!editable || outdated) && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 space-y-1">
            {outdated?.kind === "changed" && (
              <p>
                预览之后这个任务又整理 / 撤销过（{fmtTime(outdated.at * 1000)}
                {outdatedRunId && (
                  <button type="button" className="ml-1 text-brand hover:underline" onClick={() => onOpenRun(outdatedRunId)}>
                    看那一次
                  </button>
                )}
                ），网盘可能已经变了，建议重新预览再执行。
              </p>
            )}
            {outdated?.kind === "old" && <p>这是 {Math.max(1, Math.floor((Date.now() / 1000 - outdated.at) / 86400))} 天前的预览，网盘可能已经变了，建议重新预览再执行。</p>}
            {!editable && <p>这次预览是上次启动时做的，单元结构没保存下来，不能再换匹配、改季集或勾选；可以直接执行，或者重新预览。</p>}
          </div>
          <Button size="sm" variant="outline" onClick={() => void repreview()} disabled={locked}>
            <Search className="size-4" />
            重新预览
          </Button>
        </div>
      )}

      {!isBusyStatus(run.status) && run.status !== "ready" && (
        <FailurePanel run={run} groups={groups} busy={busy} version={version} onWorking={setPanelWorking} onChanged={async () => void (await load())} onRevert={() => setConfirm("revert")} onOpenRun={onOpenRun} />
      )}

      {run.status === "planning" && units.length === 0 ? (
        <Spinner label="正在列目录、识别作品…" />
      ) : previewFailed ? (
        <EmptyState
          icon={run.status === "failed" ? AlertTriangle : Ban}
          title={run.status === "failed" ? "预览没做完" : "预览已取消"}
          description={run.status === "failed" ? run.error || "列目录或识别的时候出错了。" : "这次预览在识别完之前被取消了。"}
          action={
            <Button onClick={() => void repreview()} disabled={locked}>
              <Search className="size-4" />
              重新预览
            </Button>
          }
        />
      ) : units.length === 0 ? (
        <EmptyState icon={Film} title="范围里没有视频文件" description="换一个目录，或检查设置里的 strm 扩展名。" />
      ) : (
        <UnitList
          runId={runId}
          units={units}
          counts={counts}
          dirCount={dirCount}
          stage={run.stage}
          version={version}
          ready={run.status === "ready"}
          editable={editable}
          naming={run.naming}
          patching={patching}
          busy={locked}
          onPatch={(u, patch) => void patchUnit(u, patch)}
          onBulk={(keys, selected) => void bulk([{ keys, selected }])}
          onOnlyHigh={(list) =>
            void bulk([
              { keys: list.filter((u) => u.match && u.match.confidence !== "high").map((u) => u.key), selected: false },
              { keys: list.filter((u) => u.match?.confidence === "high").map((u) => u.key), selected: true },
            ])
          }
          onToggleItems={(u, ids, selected) => void toggleItems(u, ids, selected)}
          onResolve={pickResolve}
          onMatch={setMatching}
          onAdjust={setAdjusting}
          onRefresh={(u) => void refreshUnit(u)}
        />
      )}

      <MatchDialog
        unit={matching}
        onOpenChange={(o) => !o && setMatching(null)}
        onPick={(pick) => (matching ? patchUnit(matching, { match: pick }) : Promise.resolve(false))}
        pickingNote="正在按新的匹配重新规划…"
      />
      <AdjustDialog unit={adjusting} onOpenChange={(o) => !o && setAdjusting(null)} onSave={(p) => (adjusting ? patchUnit(adjusting, p) : Promise.resolve(false))} />
      <RenameDialog
        item={renaming?.item ?? null}
        onOpenChange={(o) => !o && setRenaming(null)}
        onSave={(name) => (renaming ? resolveItem(renaming.unit, [renaming.item.id], { how: "custom", name }) : Promise.resolve(false))}
      />

      <AlertDialog open={confirm != null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "apply" ? "在网盘上执行整理" : confirm === "revert" ? "撤销这次整理" : "删除整理记录"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "apply" &&
                (run.status === "ready"
                  ? `会在网盘上${plannedText(run.stats)}，${run.naming === "local" ? "本地 strm 的内容改成新的网盘路径（名字和位置不变，Emby 不受影响）。" : "本地 strm 跟着挪。Emby 会把改名后的条目当新条目，播放记录可能丢失。"}${run.stats.plannedDelete > 0 ? `其中 ${run.stats.plannedDelete} 个文件是冲突选了删除 / 覆盖的，会进网盘回收站，撤销退不回来。` : ""}${unsure > 0 ? `有 ${unsure} 部识别把握不大，建议先确认。` : ""}`
                  : `只重试失败和没做的 ${applicable.count} 项（临时失败、风控中断、本地没跟上的），已完成的不会重做。${applicable.deletes ? `其中 ${applicable.deletes} 个是删除（冲突选了删掉 / 覆盖），会在网盘上删掉，进网盘回收站，撤销退不回来。` : ""}「预览后变了」「名字不被接受」的项不在里面，在上面的面板里单独处理。`)}
              {confirm === "revert" &&
                (reverting
                  ? "把还没退回的项接着退回原处；已经退回的不会重做。"
                  : `按记录把文件退回原来的位置和名字；已经被别的操作动过的项会跳过，之后可以放弃。${run.naming === "local" ? "本地 strm 也会挪回同步时的位置和名字。" : ""}`)}
              {confirm === "delete" && "只删这条记录，网盘和本地文件都不动；删掉之后就不能撤销这次整理了。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirm) void act(confirm);
              }}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : confirm === "apply" ? "执行" : confirm === "revert" ? "撤销" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
