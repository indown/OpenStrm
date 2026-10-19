"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TEMPLATE_PRESETS, type TemplatePreset } from "@/lib/organize-presets";

/** 「套用预设」下拉：选一个就把电影 / 剧集两个模板一起填上；选完回到占位，好再选一次 */
export function TemplatePresetPicker({ onPick, className }: { onPick: (preset: TemplatePreset) => void; className?: string }) {
  return (
    <Select
      value=""
      onValueChange={(key) => {
        const p = TEMPLATE_PRESETS.find((x) => x.key === key);
        if (p) onPick(p);
      }}
    >
      <SelectTrigger className={className ?? "h-8 w-full text-xs sm:w-56"} aria-label="套用模板预设">
        <SelectValue placeholder="套用预设…" />
      </SelectTrigger>
      <SelectContent className="z-[60] max-w-[min(26rem,calc(100vw-2rem))]">
        {TEMPLATE_PRESETS.map((p) => (
          <SelectItem key={p.key} value={p.key} className="flex-col items-start gap-0.5">
            <span className="text-xs font-medium">{p.label}</span>
            <span className="text-[11px] whitespace-normal text-muted-foreground">{p.hint}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
