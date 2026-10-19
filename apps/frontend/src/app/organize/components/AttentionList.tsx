"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Inbox } from "lucide-react";
import type { OrganizeAttention, OrganizeRun } from "@openstrm/shared";
import { StatusBadge } from "@/components/status-badge";
import { api, type TaskRow } from "@/lib/api";
import { usePolling } from "@/hooks/use-polling";
import { accountLabel } from "@/lib/drive";
import { fmtTime, fmtWhen } from "@/lib/format";
import { ATTENTION_META, ORGANIZE_CHANGED_EVENT, RUN_STATUS_META, TRIGGER_LABEL, notifyOrganizeChanged, scopeLabel } from "@/lib/organize";
import { POLL_MS } from "./helpers";

/** 一条待处理的 run 怎么概括：待执行说要动多少，失败说几项、没做完几项，撤销说没退回几项 */
function attentionSummary({ run, reason }: OrganizeAttention): string {
  const s = run.stats;
  const k = s.failedByKind;
  switch (reason) {
    case "ready":
      return `${s.units} 部 · ${s.planned} 项要动${s.conflicts > 0 ? ` · ${s.conflicts} 项冲突` : ""}`;
    case "busy":
      return run.progress?.message || RUN_STATUS_META[run.status].label;
    case "failures": {
      const failed = k.transient + k.blocked + k.stale + k.rejected;
      const parts = [failed > 0 ? `${failed} 项失败` : "", s.pending > 0 ? `${s.pending} 项没做完` : "", k.mirror > 0 ? `${k.mirror} 项本地未同步` : ""];
      return parts.filter(Boolean).join(" · ") || "要处理";
    }
    case "revert":
      return [s.notReverted > 0 ? `${s.notReverted} 项没退回` : "", k.mirror > 0 ? `${k.mirror} 项本地未同步` : ""].filter(Boolean).join(" · ") || "没退回完";
    case "preview-failed":
      return run.error || "预览失败";
  }
}

/** 范围一句话 + 具体是哪几个目录（鼠标停上去看） */
function scopeTitle(run: OrganizeRun): string {
  const paths = run.scopePaths.length > 0 ? run.scopePaths : run.scopePath ? [run.scopePath] : [];
  return paths.length > 0 ? paths.join("\n") : "整个任务目录";
}

/** 没打开 run 时列出要人管的整理（跨任务）：自动整理的待确认清单、有失败要处理的、撤销没退完的 */
export function AttentionList({ tasks, onOpen }: { tasks: TaskRow[] | null; onOpen: (run: OrganizeRun) => void }) {
  const [list, setList] = useState<OrganizeAttention[] | null>(null);
  // 上一次拉到的清单：这里先发现变了（监控刚建了待确认的预览这种），就让侧栏角标也刷一下，别等它一分钟一轮
  const seenKey = useRef<string | null>(null);
  const load = useCallback(
    () =>
      api.organize
        .attention()
        .then((r) => {
          setList(r.runs);
          const key = r.runs.map((a) => `${a.run.id}:${a.reason}`).join(",");
          if (seenKey.current !== null && key !== seenKey.current) notifyOrganizeChanged();
          seenKey.current = key;
        })
        .catch(() => setList([])),
    [],
  );
  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener(ORGANIZE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ORGANIZE_CHANGED_EVENT, onChanged);
  }, [load]);
  usePolling(load, POLL_MS * 5);
  if (!list || list.length === 0) return null;
  // 115 和夸克上都可以有个叫 tv 的任务：只写目录名分不出是哪个网盘的
  const label = (run: OrganizeRun) => {
    const task = tasks?.find((t) => t.id === run.taskId);
    return task ? `${accountLabel(task.account, task.accountType)} · ${task.originPath}` : accountLabel(run.accountName);
  };
  return (
    <section className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Inbox className="size-4 text-muted-foreground" />
        待处理（{list.length}）
      </div>
      <ul className="divide-y">
        {list.map((a) => {
          const meta = ATTENTION_META[a.reason];
          const r = a.run;
          return (
            <li key={r.id}>
              <button type="button" className="flex w-full flex-wrap items-center gap-2 px-1 py-2 text-left text-sm hover:bg-accent" onClick={() => onOpen(r)}>
                <StatusBadge tone={meta.tone} pulse={a.reason === "busy"}>
                  {meta.label}
                </StatusBadge>
                <span className="min-w-0 flex-1 break-all">
                  {label(r)}
                  <span className="text-muted-foreground" title={scopeTitle(r)}>
                    {" "}
                    · {scopeLabel(r)}
                  </span>
                  {/* 同一个任务、同一个范围的好几条长得一模一样，时间紧跟在后面才分得清是哪一条 */}
                  <span className="ml-1.5 text-xs text-muted-foreground tabular-nums" title={fmtTime(r.createdAt * 1000)}>
                    {fmtWhen(r.createdAt * 1000)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {attentionSummary(a)} · {TRIGGER_LABEL[r.trigger]}
                  {r.naming === "local" ? " · 按本地 strm 结构" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
