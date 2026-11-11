"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import type { Cd2Settings, CopyAfterCopy, OpenlistCopySettings } from "@openstrm/shared";
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
import { api, type CopyAddOutcome, type CopyAddResult, type TaskRow } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { isMountLayerKind } from "@/lib/drive";
import { AFTER_COPY_LABEL, COPY_ENGINE_LABEL, copyLayer, normTargetDir, STAGING_DIRS, taskAfterCopy } from "@/lib/openlist-copy";

/** 从别处（strm 管理页）带进来的预填：哪个任务、哪些路径（相对任务网盘目录） */
export interface CopyPreset {
  taskId: string;
  paths: string[];
}

interface AddCopyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: CopyPreset | null;
  /** 排上了（至少一条）之后叫一声，队列面板好刷新 */
  onQueued?: () => void;
}

const AFTER_COPY_HINT: Record<CopyAfterCopy, string> = {
  keep: "网盘上那份留着。Emby 里同一集会同时有云上的 strm 和本地那份。",
  archive: "复制成功、目标里确认看得见之后，把网盘上那份挪进任务目录下的「归档」（原来的层级留着），本地 strm 删掉。想恢复挪回去就行。",
  delete: "复制成功、目标里确认看得见之后，删掉网盘上那份（115 / 夸克进回收站，过期清空）和本地 strm。不可逆。",
};
const OUTCOME_META: Record<CopyAddOutcome, { label: string; tone: StatusTone }> = {
  queued: { label: "已排队", tone: "success" },
  filled: { label: "补了缺的", tone: "success" },
  complete: { label: "目标里已经齐了", tone: "neutral" },
  exists: { label: "目标里已有同名", tone: "neutral" },
  duplicate: { label: "已经排着", tone: "neutral" },
  covered: { label: "整目录复制会带过去", tone: "neutral" },
  missing: { label: "网盘上没有", tone: "warning" },
};

const stripSlashes = (p: string): string => p.replace(/^\/+|\/+$/g, "");

/**
 * 手动发起「复制到 OpenList / CD2」：选任务 → 在它的网盘目录里勾目录 / 文件 → 复制到哪、复制完源文件怎么办 → 提交。
 * 转存时没勾复制、后来才开了复制、看片卡顿想把某部片放到本地磁盘，都从这里补。
 * 目标里已经有同名目录的，后端只补缺的文件；提交后每条路径的结果留在框里看。
 */
export function AddCopyDialog({ open, onOpenChange, preset, onQueued }: AddCopyDialogProps) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [settings, setSettings] = useState<OpenlistCopySettings | null>(null);
  /** 设置里的 cd2 那一份：复制引擎选了 CloudDrive2 时，选目标子目录要列 CD2 账号 */
  const [cd2Settings, setCd2Settings] = useState<Cd2Settings | null>(null);
  const [taskId, setTaskId] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  /** 在目标根下面选的子目录（相对目标根）；空串 = 就放目标根 */
  const [dstSub, setDstSub] = useState("");
  /** 空串 = 跟任务设置 */
  const [afterCopy, setAfterCopy] = useState<CopyAfterCopy | "">("");
  const [pickOpen, setPickOpen] = useState(false);
  const [dstOpen, setDstOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CopyAddResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTaskId(preset?.taskId ?? "");
    setPaths(preset?.paths ?? []);
    setDstSub("");
    setAfterCopy("");
    setResult(null);
    setTasksLoading(true);
    api.tasks
      .list()
      .then((rows) => {
        // 不过滤：strm 管理页可能带着任何任务进来，列表里没有它的话下拉框会空着、什么也说不出来；复制不了的由 copyBlocked 说清楚
        if (!cancelled) setTasks(Array.isArray(rows) ? rows : []);
      })
      .catch((err) => {
        if (!cancelled) toast.error(apiErrorMessage(err, "读取任务列表失败"));
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    api.settings
      .get()
      .then((s) => {
        if (!cancelled) {
          setSettings(s.openlistCopy ?? {});
          setCd2Settings(s.cd2 ?? {});
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettings({});
          setCd2Settings({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, preset]);

  const task = tasks.find((t) => t.id === taskId);
  const account = task?.account ?? "";
  const originPath = stripSlashes(task?.originPath ?? "");
  /** 复制用的那一家（引擎是 CD2 就是设置页「网盘挂载」里选的 CD2 账号）：选目标子目录从它里面列 */
  const layer = copyLayer(settings ?? undefined, cd2Settings ?? undefined);
  const layerAccount = layer.account;
  /** 设置还没读到时两家都说上，免得先闪一下 OpenList */
  const engineName = settings ? COPY_ENGINE_LABEL[layer.engine] : "OpenList / CloudDrive2";
  // OpenList 根 / 算没填（和后端同一条规则）
  const base = normTargetDir(task?.copyToOpenlist?.dstDir) || normTargetDir(settings?.dstDir);
  const dstDir = dstSub ? `${base}/${dstSub}` : base;
  const effectiveAfter: CopyAfterCopy = afterCopy || taskAfterCopy(task?.copyToOpenlist);
  // 卡在哪：任务列表带着后端算好的 copyBlocked（和真干活时同一套判断），这里不再自己猜一遍
  const blocked = task?.copyBlocked ?? null;

  // TreeSelectDialog 打开时按 load 拉根目录：这两个要稳定，不然每次渲染都重拉
  const loadSource = useCallback(
    async (p: string) => {
      const rows = await api.directory.remote(account, [originPath, p].filter(Boolean).join("/"), true);
      // 任务根下的暂存区（归档、重复文件）不列：选了提交也会被拒
      return p ? rows : rows.filter((r) => !STAGING_DIRS.includes(r.name));
    },
    [account, originPath],
  );
  const loadDst = useCallback((p: string) => api.directory.remote(layerAccount, [base, p].filter(Boolean).join("/")), [layerAccount, base]);

  const submit = async () => {
    if (!task || paths.length === 0 || blocked) return;
    setBusy(true);
    try {
      const r = await api.copy.add({
        taskId: task.id,
        paths,
        ...(dstSub ? { dstDir } : {}),
        ...(afterCopy ? { afterCopy } : {}),
      });
      setResult(r);
      if (r.queued > 0) {
        toast.success(`排上了 ${r.queued} 条复制`);
        onQueued?.();
      } else toast.info(r.reason ?? "没有排上");
    } catch (err) {
      toast.error(apiErrorMessage(err, "发起复制失败"));
    } finally {
      setBusy(false);
    }
  };

  const onSubmitClick = () => {
    if (effectiveAfter === "delete") setConfirmDelete(true);
    else void submit();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新建复制</DialogTitle>
            <DialogDescription>
              把任务网盘目录里已经有的目录 / 文件交给 {engineName}，复制到另一个存储（比如挂载的本地磁盘）。目标里已经有同名目录的只补缺的文件。
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-2">
              <p className="text-sm">
                {result.queued > 0 ? `排上了 ${result.queued} 条，复制到 ${result.dstDir} 下（按任务目录的层级摆）` : result.reason ?? "没有排上"}
                {result.queued > 0 && result.afterCopy === "delete" ? "；复制成功后会删掉网盘上的源文件" : ""}
                {result.queued > 0 && result.afterCopy === "archive" ? "；复制成功后会把网盘上的源文件挪进「归档」" : ""}
              </p>
              <ul className="divide-y rounded-md border">
                {result.items.map((it) => {
                  const meta = OUTCOME_META[it.outcome];
                  return (
                    <li key={it.path} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 break-all">{it.path}</span>
                      <StatusBadge tone={meta.tone} className="shrink-0">
                        {meta.label}
                        {it.outcome === "filled" ? `（${it.queued}）` : ""}
                      </StatusBadge>
                    </li>
                  );
                })}
              </ul>
              {result.queued > 0 && (
                <p className="text-xs text-muted-foreground">复制在后台跑，大约 30 秒推进一轮；进度在云下载页的「复制到 OpenList / CD2」里看。</p>
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
                    setDstSub("");
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
                        {t.copyBlocked ? "（复制没生效）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {blocked && (
                  <p className="text-xs text-warning">
                    {blocked}。{isMountLayerKind(task?.accountType) ? "" : "到设置页的「网盘挂载」「复制」两节里补上就好。"}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>要复制的目录 / 文件</Label>
                  <Button type="button" variant="outline" size="sm" disabled={!task || Boolean(blocked)} onClick={() => setPickOpen(true)}>
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
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>复制到哪</Label>
                  <Button type="button" variant="outline" size="sm" disabled={!task || !base || !layerAccount} onClick={() => setDstOpen(true)}>
                    <FolderOpen className="size-4" />
                    选子目录
                  </Button>
                </div>
                <p className="break-all text-sm">
                  {base ? dstDir : "任务上和设置页都没填目标目录"}
                  {dstSub && (
                    <button type="button" className="ml-2 text-xs text-muted-foreground underline" onClick={() => setDstSub("")}>
                      回到 {base}
                    </button>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">只能是任务上 / 设置页的目标目录或它下面的目录；任务目录里的层级会原样带过去。</p>
              </div>

              <div className="space-y-2">
                <Label>复制成功后，网盘上的源文件</Label>
                <Select value={afterCopy || "__task__"} onValueChange={(v) => setAfterCopy(v === "__task__" ? "" : (v as CopyAfterCopy))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[60]">
                    <SelectItem value="__task__">跟任务设置{task ? `（${AFTER_COPY_LABEL[taskAfterCopy(task.copyToOpenlist)]}）` : ""}</SelectItem>
                    <SelectItem value="keep">不动</SelectItem>
                    <SelectItem value="archive">归档</SelectItem>
                    <SelectItem value="delete">删除</SelectItem>
                  </SelectContent>
                </Select>
                <p className={`text-xs ${effectiveAfter === "delete" ? "text-destructive" : "text-muted-foreground"}`}>{AFTER_COPY_HINT[effectiveAfter]}</p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {result ? "关闭" : "取消"}
            </Button>
            {!result && (
              <Button type="button" onClick={onSubmitClick} disabled={busy || !task || paths.length === 0 || Boolean(blocked)}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {busy ? "登记中…" : `开始复制${paths.length > 0 ? `（${paths.length}）` : ""}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {task && (
        <TreeSelectDialog
          open={pickOpen}
          onOpenChange={setPickOpen}
          title="选要复制的目录 / 文件"
          description={<>任务目录：{task.originPath}。点名字勾选，点箭头展开；目录、文件都能勾。</>}
          load={loadSource}
          multiple
          onConfirmMany={(picked) => setPaths((prev) => [...prev, ...picked.filter((p) => !prev.includes(p))])}
        />
      )}
      {task && base && layerAccount && (
        <TreeSelectDialog
          open={dstOpen}
          onOpenChange={setDstOpen}
          title="复制到哪"
          description={
            <>
              在 {base} 下面选一个目录（{engineName} 账号 {layerAccount}）
            </>
          }
          load={loadDst}
          onConfirm={(p) => setDstSub(p)}
        />
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>复制完删掉网盘上的源文件？</AlertDialogTitle>
            <AlertDialogDescription>
              这 {paths.length} 项复制成功、目标里确认看得见之后，网盘上那份会被删掉（115 / 夸克进回收站，过期清空），本地对应的 strm 也一起删。要留一份的话选「归档」。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setConfirmDelete(false);
                void submit();
              }}
            >
              复制并删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
