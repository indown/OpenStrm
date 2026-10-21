"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ExternalLink, Film, Loader2, Search, Tv } from "lucide-react";
import type { OrganizeCandidate, OrganizeMediaType, OrganizeUnit, OrganizeUnitPatch } from "@openstrm/shared";
import { api, type OrganizeTitleOptions } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/status-badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { CONFIDENCE_META } from "@/lib/organize";

/** 全部当字符串收：空串是「按 TMDB 的 / 按名字判断」，和填了 0 不是一回事 */
const schema = z.object({
  title: z
    .string()
    .trim()
    .max(200)
    .refine((v) => !v.includes("/"), "标题不能带 /"),
  year: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{4}$/.test(v), "年份是四位数字"),
  season: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{1,2}$/.test(v), "季填 0–99 的整数，留空表示按名字判断"),
  offset: z
    .string()
    .trim()
    .refine((v) => v === "" || /^-?\d{1,4}$/.test(v), "集偏移填整数，可以是负数"),
  remember: z.boolean(),
});

type Values = z.infer<typeof schema>;

/** 候选 / 当前匹配的小海报 */
function Poster({ url, type }: { url: string; type: OrganizeMediaType }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded bg-muted">
      {url && !broken ? (
        <Image src={url} alt="" fill className="object-cover" unoptimized onError={() => setBroken(true)} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">{type === "tv" ? <Tv className="size-4" /> : <Film className="size-4" />}</div>
      )}
    </div>
  );
}

/** 候选的 3 个，不含现在认成的 */
export function topCandidates(unit: Pick<OrganizeUnit, "match">, max = 3): OrganizeCandidate[] {
  const m = unit.match;
  return (m?.candidates ?? []).filter((c) => !(m && c.tmdbId === m.tmdbId && c.mediaType === m.mediaType)).slice(0, max);
}

/**
 * 编辑作品：识别（当前匹配、候选一点就换、搜索其他）、标题 / 年份、季与集偏移、记住，一个弹框里改完一次重新规划。
 * 候选和搜索是立刻生效的（换了作品后面几项按新作品算）；其余按「重新规划」一起提交
 */
export function EditUnitDialog({
  unit,
  onOpenChange,
  onSave,
  onPickCandidate,
  onSearch,
  pending,
}: {
  unit: OrganizeUnit | null;
  onOpenChange: (open: boolean) => void;
  /** 标题 / 年份 / 季 / 集偏移 / 记住一次提交；成功返回 true 才关弹框 */
  onSave: (patch: OrganizeUnitPatch) => Promise<boolean>;
  /** 点候选：立刻换匹配，弹框不关 */
  onPickCandidate: (pick: { mediaType: OrganizeMediaType; tmdbId: number }) => Promise<boolean>;
  /** 开搜索弹框（在这个弹框上面） */
  onSearch: () => void;
  /** 这个单元正在保存（换候选中） */
  pending: boolean;
}) {
  const open = unit != null;
  const m = unit?.match ?? null;
  const tv = m?.mediaType === "tv";
  const tmdbTitle = m?.title ?? "";
  const tmdbYear = m?.year ?? "";
  const [options, setOptions] = useState<OrganizeTitleOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { title: "", year: "", season: "", offset: "0", remember: false } });
  const saving = form.formState.isSubmitting;

  // 单元换了、或换了匹配（候选）之后按新的填：标题 / 年份是改过的或 TMDB 的
  const resetKey = unit ? `${unit.key}|${m?.mediaType ?? ""}:${m?.tmdbId ?? 0}|${unit.titleOverride}|${unit.yearOverride}|${unit.seasonOverride}|${unit.episodeOffset}|${unit.remember}` : "";
  useEffect(() => {
    if (!unit) return;
    form.reset({
      title: unit.titleOverride || unit.match?.title || "",
      year: unit.yearOverride || unit.match?.year || "",
      season: unit.seasonOverride == null ? "" : String(unit.seasonOverride),
      offset: String(unit.episodeOffset),
      remember: unit.remember,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, form]);

  const mediaType = m?.mediaType;
  const tmdbId = m?.tmdbId;
  useEffect(() => {
    if (!mediaType || !tmdbId) {
      setOptions(null);
      return;
    }
    let alive = true;
    setOptions(null);
    setLoadError(null);
    api.organize
      .tmdbTitles(mediaType, tmdbId)
      .then((o) => {
        if (alive) setOptions(o);
      })
      .catch((err) => {
        if (alive) setLoadError(apiErrorMessage(err, "读取别名失败"));
      });
    return () => {
      alive = false;
    };
  }, [mediaType, tmdbId]);

  const submit = async (values: Values) => {
    const patch: OrganizeUnitPatch = {
      remember: values.remember,
      ...(m
        ? {
            title: values.title && values.title !== tmdbTitle ? values.title : null,
            year: values.year && values.year !== tmdbYear ? values.year : null,
          }
        : {}),
      ...(tv ? { seasonOverride: values.season === "" ? null : Number(values.season), episodeOffset: values.offset === "" ? 0 : Number(values.offset) } : {}),
    };
    if (await onSave(patch)) onOpenChange(false);
  };

  const choices = options ? [...new Set([options.title, options.originalTitle, options.enTitle, ...options.aliases].filter(Boolean))] : [];
  const current = form.watch("title");
  const candidates = unit ? topCandidates(unit) : [];
  const conf = CONFIDENCE_META[m?.confidence ?? "none"];
  const busy = saving || pending;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent size="lg" className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>编辑作品</DialogTitle>
          <DialogDescription className="break-all">「{unit?.rawName}」</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Form {...form}>
            <form id="edit-unit-form" onSubmit={form.handleSubmit(submit)} className="space-y-5 py-1">
              <section className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">识别</h3>
                <div className="flex items-start gap-3 rounded-md border p-3">
                  {m ? (
                    <>
                      <Poster url={m.posterUrl} type={m.mediaType} />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">
                            {m.title}
                            {m.year ? ` (${m.year})` : ""}
                          </span>
                          <StatusBadge tone={conf.tone} title={conf.hint}>
                            {conf.label}
                          </StatusBadge>
                          <a href={`https://www.themoviedb.org/${m.mediaType}/${m.tmdbId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
                            {m.mediaType === "tv" ? "剧集" : "电影"} #{m.tmdbId}
                            <ExternalLink className="size-3" />
                          </a>
                        </div>
                        <div className="text-xs text-muted-foreground">{m.reason}</div>
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground">没识别出来：从候选里挑，或者搜一下。</div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {candidates.length > 0 && <span className="text-xs text-muted-foreground">也可能是：</span>}
                  {candidates.map((c) => (
                    <Button
                      key={`${c.mediaType}-${c.tmdbId}`}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 max-w-full text-xs"
                      disabled={busy}
                      onClick={() => void onPickCandidate({ mediaType: c.mediaType, tmdbId: c.tmdbId })}
                      title={`换成 ${c.title}${c.year ? ` (${c.year})` : ""}`}
                    >
                      {c.mediaType === "tv" ? <Tv className="size-3" /> : <Film className="size-3" />}
                      <span className="truncate">
                        {c.title}
                        {c.year ? ` (${c.year})` : ""}
                      </span>
                    </Button>
                  ))}
                  <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={onSearch} disabled={busy}>
                    <Search className="size-3" />
                    搜索其他…
                  </Button>
                  {pending && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      正在按新的匹配重新规划…
                    </span>
                  )}
                </div>
              </section>

              {m && (
                <section className="space-y-3">
                  <h3 className="text-xs font-medium text-muted-foreground">标题 / 年份（只改目录和文件名里的写法，识别不变）</h3>
                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>标题</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder={tmdbTitle} />
                        </FormControl>
                        <FormDescription className="text-xs">TMDB 的译名是「{tmdbTitle}」；留空也按它。勾了「记住」的，改的标题一起记住。</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">从 TMDB 的名字里挑：</div>
                    {loadError ? (
                      <p className="text-xs text-destructive">{loadError}</p>
                    ) : !options ? (
                      <p className="text-xs text-muted-foreground">读取中…</p>
                    ) : (
                      <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                        {choices.map((c) => (
                          <Button key={c} type="button" size="sm" variant={current === c ? "secondary" : "outline"} className="h-7 max-w-full text-xs" onClick={() => form.setValue("title", c, { shouldDirty: true, shouldValidate: true })}>
                            <span className="truncate">{c}</span>
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                  <FormField
                    control={form.control}
                    name="year"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>年份</FormLabel>
                        <FormControl>
                          <Input inputMode="numeric" className="w-32" {...field} placeholder={tmdbYear || "TMDB 上未知"} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </section>
              )}

              {tv && (
                <section className="space-y-3">
                  <h3 className="text-xs font-medium text-muted-foreground">季与集偏移（整个单元）</h3>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="season"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>季</FormLabel>
                          <FormControl>
                            <Input inputMode="numeric" placeholder="留空按文件名 / 目录名判断" {...field} />
                          </FormControl>
                          <FormDescription className="text-xs">强制把所有集归到这一季；0 是特别篇。单个文件要钉的在文件行上改。</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="offset"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>集偏移</FormLabel>
                          <FormControl>
                            <Input inputMode="numeric" {...field} />
                          </FormControl>
                          <FormDescription className="text-xs">在解析出的集数上加减：文件名里是 13 而它其实是第二季第 1 集，就填 -12。</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </section>
              )}

              {m && (
                <FormField
                  control={form.control}
                  name="remember"
                  render={({ field }) => (
                    <FormItem className="flex items-start gap-2 space-y-0 rounded-md border p-3">
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} className="mt-0.5" />
                      </FormControl>
                      <div className="space-y-0.5">
                        <FormLabel className="cursor-pointer">记住这个识别</FormLabel>
                        <FormDescription className="text-xs">下次整理同一个目录直接按它认（算把握大），改过的标题 / 季 / 集偏移一起记住；记错了到「识别记忆」里删。</FormDescription>
                      </div>
                    </FormItem>
                  )}
                />
              )}
            </form>
          </Form>
        </div>
        <DialogFooter>
          {m && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                form.setValue("title", tmdbTitle, { shouldDirty: true, shouldValidate: true });
                form.setValue("year", tmdbYear, { shouldDirty: true, shouldValidate: true });
              }}
              disabled={busy}
            >
              标题用 TMDB 的
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button type="submit" form="edit-unit-form" disabled={busy || !m}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "重新规划"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
