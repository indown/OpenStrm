"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { OrganizeRun } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/status-badge";
import { Spinner } from "@/components/loading";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { fmtTime, fmtWhen } from "@/lib/format";
import { RUN_STATUS_META, TRIGGER_LABEL, scopeLabel } from "@/lib/organize";

const HISTORY_PAGE = 30;

export function HistoryDialog({ open, onOpenChange, taskId, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; taskId: string; onPick: (id: string) => void }) {
  const [runs, setRuns] = useState<OrganizeRun[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    if (!open) return;
    setRuns(null);
    setMore(false);
    api.organize
      .listRuns(taskId, HISTORY_PAGE)
      .then((r) => {
        setRuns(r.runs);
        setMore(r.runs.length === HISTORY_PAGE);
      })
      .catch((err) => {
        setRuns([]);
        toast.error(apiErrorMessage(err, "读取整理历史失败"));
      });
  }, [open, taskId]);
  const loadMore = async () => {
    if (!runs) return;
    setLoadingMore(true);
    try {
      const r = await api.organize.listRuns(taskId, HISTORY_PAGE, runs.length);
      // 翻页期间新建了 run 会让 offset 错开一位：按 id 去重
      const seen = new Set(runs.map((x) => x.id));
      setRuns([...runs, ...r.runs.filter((x) => !seen.has(x.id))]);
      setMore(r.runs.length === HISTORY_PAGE);
    } catch (err) {
      toast.error(apiErrorMessage(err, "读取整理历史失败"));
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>整理历史</DialogTitle>
          <DialogDescription>这个任务的整理记录，新的在前。要是后面的整理又动过某次挪好的文件，得先撤销后面那次才能撤它。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {runs === null ? (
            <Spinner label="加载中…" />
          ) : runs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有整理记录</p>
          ) : (
            <ul className="divide-y">
              {runs.map((r) => {
                const meta = RUN_STATUS_META[r.status];
                return (
                  <li key={r.id}>
                    <button type="button" className="flex w-full flex-wrap items-center gap-2 px-1 py-2 text-left text-sm hover:bg-accent" onClick={() => onPick(r.id)}>
                      <StatusBadge tone={meta.tone} pulse={meta.pulse}>
                        {meta.label}
                      </StatusBadge>
                      {r.stage === "apply" && r.stats.failed > 0 && <StatusBadge tone="danger" className="tabular-nums">{r.stats.failed} 失败</StatusBadge>}
                      {r.stage === "revert" && r.stats.notReverted > 0 && <StatusBadge tone="danger" className="tabular-nums">{r.stats.notReverted} 没退回</StatusBadge>}
                      {r.stats.failedByKind.mirror > 0 && <StatusBadge tone="warning" className="tabular-nums">{r.stats.failedByKind.mirror} 本地未同步</StatusBadge>}
                      <span className="min-w-0 flex-1 break-all">{scopeLabel(r)}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {r.stats.units} 部 · {r.stats.done > 0 ? `完成 ${r.stats.done}` : `${r.stats.planned} 项`} · {TRIGGER_LABEL[r.trigger]}
                        {r.naming === "local" ? " · 按本地 strm 结构" : ""} ·{" "}
                        <span title={fmtTime(r.createdAt * 1000)}>{fmtWhen(r.createdAt * 1000)}</span>
                      </span>
                      {(r.status === "cancelled" || r.status === "failed") && r.error && <span className="w-full break-all text-xs text-muted-foreground">{r.error}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {more && (
            <div className="flex justify-center py-2">
              <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore && <Loader2 className="size-4 animate-spin" />}
                加载更多
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
