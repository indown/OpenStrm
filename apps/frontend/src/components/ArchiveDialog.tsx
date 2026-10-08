"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Loader2, X } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { TreeSelectDialog } from "@/components/TreeSelectDialog";
import { api, type DriveArchiveOutcome, type DriveArchiveResult, type TaskRow } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { STAGING_DIRS } from "@/lib/openlist-copy";

/** 从别处（strm 管理页）带进来的预填：哪个任务、哪些路径（相对任务网盘目录） */
export interface ArchivePreset {
  taskId: string;
  paths: string[];
}

interface ArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: ArchivePreset | null;
  /** 收进去了（至少一条）之后叫一声：本地 strm 删了，浏览的目录要刷新 */
  onDone?: () => void;
}

const OUTCOME_META: Record<DriveArchiveOutcome, { label: string; tone: StatusTone }> = {
  archived: { label: "已归档", tone: "success" },
  kept: { label: "没动", tone: "neutral" },
  copying: { label: "正在复制，没动", tone: "warning" },
  missing: { label: "网盘上没有", tone: "warning" },
  failed: { label: "没成", tone: "danger" },
  skipped: { label: "没试", tone: "neutral" },
};

const stripSlashes = (p: string): string => p.replace(/^\/+|\/+$/g, "");

/**
 * 归档到暂存区：选任务 → 在它的网盘目录里勾目录 / 文件 → 确认 → 挪进任务目录下的「归档」。
 * 不管有没有复制到 OpenList、也不核对别处有没有副本：这部不想在库里了但先别删、已经用别的办法备份好了，都从这里收。
 * 挪完本地对应的 strm 就删了；每条路径的结果留在框里看。
 */
export function ArchiveDialog({ open, onOpenChange, preset, onDone }: ArchiveDialogProps) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [pickOpen, setPickOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DriveArchiveResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTaskId(preset?.taskId ?? "");
    setPaths(preset?.paths ?? []);
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
  const account = task?.account ?? "";
  const originPath = stripSlashes(task?.originPath ?? "");

  // TreeSelectDialog 打开时按 load 拉根目录：要稳定，不然每次渲染都重拉
  const loadSource = useCallback(
    async (p: string) => {
      const rows = await api.directory.remote(account, [originPath, p].filter(Boolean).join("/"), true);
      // 任务根下的暂存区（归档、重复文件）不列：本来就在暂存区里，选了提交也会被拒
      return p ? rows : rows.filter((r) => !STAGING_DIRS.includes(r.name));
    },
    [account, originPath],
  );

  const submit = async () => {
    if (!task || paths.length === 0) return;
    setBusy(true);
    try {
      const r = await api.drive.archive({ taskId: task.id, paths });
      setResult(r);
      if (r.done > 0) {
        toast.success(`收进暂存区 ${r.done} 项，本地对应的 strm 已删`);
        onDone?.();
      } else toast.info("没有收进任何一项，原因见列表");
    } catch (err) {
      toast.error(apiErrorMessage(err, "归档失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>归档到暂存区</DialogTitle>
            <DialogDescription>
              把任务网盘目录里的目录 / 文件挪进任务目录下的「归档」：原来的层级留着，本地对应的 strm 删掉，之后不再同步、监控、整理。不管有没有复制到 OpenList，也不核对别处有没有副本。想恢复的话到网盘里挪回去就行。
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-2">
              <p className="text-sm">{result.done > 0 ? `收进暂存区 ${result.done} 项，挪进了 ${result.archiveDir}；本地对应的 strm 已删。` : "没有收进任何一项。"}</p>
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
              {result.items.some((it) => it.outcome === "copying") && (
                <p className="text-xs text-muted-foreground">正在复制到 OpenList 的等复制完再来；要复制完就归档的，在云下载页的队列里点「归档源文件」。</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>任务</Label>
                <Select
                  value={taskId}
                  onValueChange={(v) => {
                    setTaskId(v);
                    // 路径是相对任务目录的，换了任务就得重选
                    setPaths([]);
                  }}
                  disabled={tasksLoading}
                >
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

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>要收起来的目录 / 文件</Label>
                  <Button type="button" variant="outline" size="sm" disabled={!task} onClick={() => setPickOpen(true)}>
                    <FolderOpen className="size-4" />
                    从网盘里选
                  </Button>
                </div>
                {paths.length === 0 ? (
                  <p className="text-xs text-muted-foreground">还没选。路径相对任务的网盘目录{task ? `（${task.originPath}）` : ""}。</p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {paths.map((p) => (
                      <li key={p} className="flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs">
                        <span className="break-all">{p}</span>
                        <button type="button" className="text-muted-foreground hover:text-foreground" title="去掉" onClick={() => setPaths(paths.filter((x) => x !== p))}>
                          <X className="size-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  会挪进{task ? `「${task.originPath}/归档」` : "任务目录下的「归档」"}，层级照旧。正在复制到 OpenList 的不会动；归档里已经有同名的也不动。
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {result ? "关闭" : "取消"}
            </Button>
            {!result && (
              <Button type="button" onClick={() => setConfirmOpen(true)} disabled={busy || !task || paths.length === 0}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {busy ? "归档中…" : `归档${paths.length > 0 ? `（${paths.length}）` : ""}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {task && (
        <TreeSelectDialog
          open={pickOpen}
          onOpenChange={setPickOpen}
          title="选要收起来的目录 / 文件"
          description={<>任务目录：{task.originPath}。点名字勾选，点箭头展开；目录、文件都能勾。</>}
          load={loadSource}
          multiple
          onConfirmMany={(picked) => setPaths((prev) => [...prev, ...picked.filter((p) => !prev.includes(p))])}
        />
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>把这 {paths.length} 项收进暂存区？</AlertDialogTitle>
            <AlertDialogDescription>
              网盘上的这 {paths.length} 项会挪进「{task?.originPath ?? ""}/归档」（原来的层级留着），本地对应的 strm 删掉，Emby 里也就看不到了。不核对别处有没有副本；正在复制到 OpenList 的不会动。想恢复的话到网盘里挪回去就行。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setConfirmOpen(false);
                void submit();
              }}
            >
              归档
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
