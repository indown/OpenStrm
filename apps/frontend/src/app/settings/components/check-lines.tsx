"use client";

import { AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { TONE_CLASS } from "@/components/status-badge";
import { cn } from "@/lib/utils";

/** ok：对得上；warn：能用但要知道的事；bad：得改 */
export type CheckTone = "ok" | "warn" | "bad";
export type CheckLine = { tone: CheckTone; text: string };

const ICON = { ok: CheckCircle2, warn: AlertCircle, bad: XCircle } as const;
const COLOR: Record<CheckTone, string> = { ok: TONE_CLASS.success.text, warn: TONE_CLASS.warning.text, bad: TONE_CLASS.danger.text };

/**
 * 「检查」的结果，一条一行摆在页面上。
 * 原来是拼成一条 toast：四五段连在一起看不全，几秒就没了，也分不清是哪一行填错了。
 * 对得上的字用灰色，只有要处理的才上色，扫一眼就知道该看哪条
 */
export function CheckLines({ lines, className }: { lines: CheckLine[]; className?: string }) {
  if (lines.length === 0) return null;
  return (
    <ul className={cn("space-y-1 text-xs", className)}>
      {lines.map((l, i) => {
        const Icon = ICON[l.tone];
        return (
          <li key={i} className="flex items-start gap-1.5">
            <Icon aria-hidden className={cn("mt-px size-3.5 shrink-0", COLOR[l.tone])} />
            <span className={l.tone === "ok" ? "text-muted-foreground" : COLOR[l.tone]}>{l.text}</span>
          </li>
        );
      })}
    </ul>
  );
}
