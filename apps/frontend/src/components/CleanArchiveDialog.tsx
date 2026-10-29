"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { File, Folder, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { api, type DriveArchiveCleanOutcome, type DriveArchiveCleanResult, type DriveArchiveListResult, type TaskRow } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { fmtTime, fmtWhen, formatSize } from "@/lib/format";

/** 从别处（strm 管理页）带进来的预填：哪个任务 */
export interface CleanArchivePreset {
  taskId: string;
}

interface CleanArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: CleanArchivePreset | null;
}

const OUTCOME_META: Record<DriveArchiveCleanOutcome, { label: string; tone: StatusTone }> = {
  deleted: { label: "已删除", tone: "success" },
  missing: { label: "归档里没有", tone: "neutral" },
  failed: { label: "没成", tone: "danger" },
  skipped: { label: "没试", tone: "neutral" },
};

/**
 * 清理归档：选任务 → 列出它归档目录（任务目录下的「归档」）里一层的条目 → 勾选 → 红字确认 → 从网盘上删掉。
 * 归档只进不出的话腾不出空间；这里删的是网盘上的东西（115 / 夸克进回收站），不可逆，所以默认一个都不勾、确认框单独红字。
 * 归档里的东西没有本地 strm，Emby 不受影响。
 */
export function CleanArchiveDialog({ open, onOpenChange, preset }: CleanArchiveDialogProps) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [listing, setListing] = useState<DriveArchiveListResult | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DriveArchiveCleanResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTaskId(preset?.taskId ?? "");
    setListing(null);
    setListError(null);
    setPicked(new Set());
    setResult(null);
    setTasksLoading(true);
    api.tasks
      .list()
      .then((rows) => {
        if (!cancelled) setTasks(Array.isArray(rows) ? rows : []);
      })
      .catch((err) => {
        if (!cancelled) toast.error(apiErrorMessage(err, "读取任务列表失败"));
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, preset]);

  const task = tasks.find((t) => t.id === taskId);

  const loadListing = useCallback(async (id: string) => {
    setListLoading(true);
    setListError(null);
    setPicked(new Set());
    try {
      setListing(await api.drive.archiveList(id));
    } catch (err) {
      setListing(null);
      setListError(apiErrorMessage(err, "读取归档目录失败"));
    } finally {
      setListLoading(false);
    }
  }, []);

  // 换了任务就重列；弹框关着时不列（预填的任务要等打开了再列）
  useEffect(() => {
    if (!open || !taskId) {
      setListing(null);
      return;
    }
    void loadListing(taskId);
  }, [open, taskId, loadListing]);

  const items = useMemo(() => listing?.items ?? [], [listing]);
  const allPicked = items.length > 0 && items.every((it) => picked.has(it.path));
  const togglePick = (path: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  const submit = async () => {
    if (!task || picked.size === 0) return;
    setBusy(true);
    try {
      // 按勾选的路径删，不用 all：列出来之后归档里可能又进了新东西，那些用户没看过
      const r = await api.drive.archiveClean({ taskId: task.id, paths: items.filter((it) => picked.has(it.path)).map((it) => it.path) });
      setResult(r);
      if (r.done > 0) toast.success(`从网盘上删掉 ${r.done} 项`);
      else toast.info("没有删掉任何一项，原因见列表");
    } catch (err) {
      toast.error(apiErrorMessage(err, "清理归档失败"));
    } finally {
      setBusy(false);
    }
  };

  const backToList = () => {
    setResult(null);
    if (taskId) void loadListing(taskId);
  };

  const archiveLabel = task ? `「${task.originPath}/归档」` : "任务目录下的「归档」";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>清理归档</DialogTitle>
            <DialogDescription>
              归档到暂存区、复制后归档的东西都在任务目录下的「归档」里（原来的层级留着）。在这里挑不要了的，从网盘上删掉：115 / 夸克进回收站、过期清空，OpenList 看存储后端；不可逆。想留的先到网盘里挪回原处。归档里的东西没有本地 strm，Emby 不受影响。
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-2">
              <p className="text-sm">{result.done > 0 ? `从 ${result.archiveDir} 删掉 ${result.done} 项。` : "没有删掉任何一项。"}</p>
              <ul className="divide-y rounded-md border">
                {result.items.map((it) => {
                  const meta = OUTCOME_META[it.outcome];
                  return (
                    <li key={it.path} className="space-y-0.5 px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 break-all">{it.path}</span>
                        <StatusBadge tone={meta.tone} className="shrink-0">
                          {meta.label}
                        </StatusBadge>
                      </div>
                      {it.detail && <p className="text-xs text-muted-foreground">{it.detail}</p>}
                    </li>
                  );
                })}
              </ul>
              {result.items.some((it) => it.outcome === "failed" || it.outcome === "skipped") && (
                <p className="text-xs text-muted-foreground">没成的稍后再来一次就行：已经删掉的会显示「归档里没有」，不会重复删。</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>任务</Label>
                <Select value={taskId} onValueChange={(v) => v && setTaskId(v)} disabled={tasksLoading}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={tasksLoading ? "读取中…" : "选一个任务"} />
                  </SelectTrigger>
                  <SelectContent className="z-[60]">
                    {tasks.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.account} · {t.originPath}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {task && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="min-w-0 break-all">{archiveLabel}里有</Label>
                    <Button type="button" variant="ghost" size="sm" disabled={listLoading} onClick={() => void loadListing(task.id)} title="重新读取">
                      <RefreshCw className={`size-4 ${listLoading ? "animate-spin" : ""}`} />
                      刷新
                    </Button>
                  </div>
                  {listLoading ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      正在读网盘上的归档目录…
                    </p>
                  ) : listError ? (
                    <p className="text-sm text-destructive">{listError}</p>
                  ) : !listing ? null : !listing.exists ? (
                    <p className="text-sm text-muted-foreground">这个任务还没有归档目录：还没归档过东西。</p>
                  ) : items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">归档目录是空的。</p>
                  ) : (
                    <>
                      <ul className="divide-y rounded-md border">
                        <li className="flex items-center gap-3 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                          <Checkbox checked={allPicked} onCheckedChange={(v) => setPicked(v === true ? new Set(items.map((it) => it.path)) : new Set())} aria-label="全选" />
                          <span className="flex-1">全选（{items.length} 项，只列一层：原来的作品 / 目录名）</span>
                        </li>
                        {items.map((it) => (
                          <li key={it.path}>
                            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                              <Checkbox checked={picked.has(it.path)} onCheckedChange={(v) => togglePick(it.path, v === true)} />
                              {it.isDir ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
                              <span className="min-w-0 flex-1 break-all">{it.name}</span>
                              <span className="shrink-0 text-xs text-muted-foreground">{it.isDir ? "目录" : formatSize(it.size)}</span>
                              <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:inline" title={fmtTime(it.modifiedAt)}>
                                {fmtWhen(it.modifiedAt)}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">时间是网盘报的修改时间（115 没有）。目录的大小要进网盘看，这里不算。</p>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {result ? (
              <>
                <Button type="button" variant="outline" onClick={backToList}>
                  回到列表
                </Button>
                <Button type="button" onClick={() => onOpenChange(false)}>
                  关闭
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                  取消
                </Button>
                <Button type="button" variant="destructive" onClick={() => setConfirmOpen(true)} disabled={busy || !task || picked.size === 0}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {busy ? "删除中…" : `删除${picked.size > 0 ? `（${picked.size}）` : ""}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从网盘上删掉这 {picked.size} 项？</AlertDialogTitle>
            <AlertDialogDescription>
              会把{archiveLabel}里勾选的 {picked.size} 项从网盘上删掉：115 / 夸克进回收站（过期清空），OpenList 看存储后端（本地存储是直接删）。
              <span className="text-destructive">不可逆</span>；想留的先取消、到网盘里把它挪回原处。归档里的东西没有本地 strm，Emby 不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                setConfirmOpen(false);
                void submit();
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
