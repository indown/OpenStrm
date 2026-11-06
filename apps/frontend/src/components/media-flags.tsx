"use client";

import { AudioLines, Captions, Disc3, Monitor } from "lucide-react";
import type { FlagFamily, MediaFlag } from "@/lib/media-flags";
import { cn } from "@/lib/utils";

/**
 * 一排媒体旗标：蓝光封底那种小方旗，等宽大写、细边淡底。颜色只走 globals.css 的 --flag-* 和 warning token。
 * grouped 时按画面 / 声音 / 字幕 / 片源分组、组首一枚 lucide 分类图标（作品卡片、文件表）；不分组就按传入顺序平铺（搜索行、收藏夹）。
 * 没有按标签的图标：4K / HDR / Atmos 这些只做文字旗标，图标只标分组（方案 .claude/plans/media-flags.md）
 */
const FAMILY_CLASS: Record<FlagFamily, string> = {
  video: "border-flag-video/35 bg-flag-video/10 text-flag-video",
  hdr: "border-flag-hdr/40 bg-flag-hdr/12 text-flag-hdr",
  audio: "border-flag-audio/35 bg-flag-audio/10 text-flag-audio",
  subs: "text-muted-foreground",
  source: "text-muted-foreground",
  plain: "text-muted-foreground",
  warn: "border-warning/30 bg-warning/12 font-sans tracking-normal normal-case text-warning",
};

interface FlagGroup {
  key: string;
  families: FlagFamily[];
  Icon?: typeof Monitor;
  label: string;
}

const GROUPS: FlagGroup[] = [
  { key: "picture", families: ["video", "hdr"], Icon: Monitor, label: "画面" },
  { key: "audio", families: ["audio"], Icon: AudioLines, label: "声音" },
  { key: "subs", families: ["subs"], Icon: Captions, label: "字幕" },
  { key: "source", families: ["source"], Icon: Disc3, label: "片源" },
  { key: "plain", families: ["plain"], label: "" },
  { key: "warn", families: ["warn"], label: "" },
];

/** 不分组就是一组、没有图标 */
const ALL: FlagGroup = { key: "all", families: ["video", "hdr", "audio", "subs", "source", "plain", "warn"], label: "" };

export function Flag({ flag, className }: { flag: MediaFlag; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded border px-1.5 font-mono text-[11px] font-medium tracking-wide whitespace-nowrap uppercase tabular-nums",
        FAMILY_CLASS[flag.family],
        flag.active && "ring-1 ring-current",
        className,
      )}
      title={flag.title}
    >
      {flag.label}
    </span>
  );
}

export function MediaFlags({ flags, grouped = false, max, className, title }: { flags: MediaFlag[]; grouped?: boolean; max?: number; className?: string; title?: string }) {
  if (flags.length === 0) return null;
  const shown = max !== undefined && flags.length > max ? flags.slice(0, max) : flags;
  const more = flags.length - shown.length;
  const all = title ?? (more > 0 ? flags.map((f) => f.label).join(" · ") : undefined);
  const key = (f: MediaFlag, i: number) => `${f.family}-${f.label}-${i}`;
  const groups = (grouped ? GROUPS : [ALL]).map((g) => ({ ...g, flags: shown.filter((f) => g.families.includes(f.family)) })).filter((g) => g.flags.length > 0);
  return (
    <span className={cn("inline-flex flex-wrap items-center", grouped ? "gap-x-3 gap-y-1" : "gap-1", className)} title={all}>
      {groups.map((g) => (
        <span key={g.key} className="inline-flex flex-wrap items-center gap-1">
          {g.Icon && <g.Icon className="mr-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={g.label} />}
          {g.flags.map((f, i) => (
            <Flag key={key(f, i)} flag={f} />
          ))}
        </span>
      ))}
      {more > 0 && <span className="text-[11px] text-muted-foreground">+{more}</span>}
    </span>
  );
}
