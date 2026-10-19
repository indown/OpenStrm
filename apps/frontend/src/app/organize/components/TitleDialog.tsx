"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Loader2 } from "lucide-react";
import type { OrganizeUnit } from "@openstrm/shared";
import { api, type OrganizeTitleOptions } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

const schema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "填个标题，或者点「用 TMDB 的」")
    .max(200)
    .refine((v) => !v.includes("/"), "标题不能带 /"),
  year: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{4}$/.test(v), "年份是四位数字"),
});

type Values = z.infer<typeof schema>;

/** 改标题 / 年份：只影响目录和文件名，TMDB 的识别不变；从译名 / 原名 / 英文名 / 别名里挑，或自己填 */
export function TitleDialog({
  unit,
  onOpenChange,
  onSave,
}: {
  unit: OrganizeUnit | null;
  onOpenChange: (open: boolean) => void;
  /** 成功返回 true 才关弹框；null 是回到 TMDB 的 */
  onSave: (patch: { title: string | null; year: string | null }) => Promise<boolean>;
}) {
  const open = unit != null;
  const tmdbTitle = unit?.match?.title ?? "";
  const tmdbYear = unit?.match?.year ?? "";
  const mediaType = unit?.match?.mediaType;
  const tmdbId = unit?.match?.tmdbId;
  const [options, setOptions] = useState<OrganizeTitleOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { title: "", year: "" } });
  const saving = form.formState.isSubmitting;

  useEffect(() => {
    if (!unit) return;
    form.reset({ title: unit.titleOverride || unit.match?.title || "", year: unit.yearOverride || unit.match?.year || "" });
  }, [unit, form]);

  useEffect(() => {
    if (!mediaType || !tmdbId) return;
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
    const title = values.title !== tmdbTitle ? values.title : null;
    const year = values.year && values.year !== tmdbYear ? values.year : null;
    if (await onSave({ title, year })) onOpenChange(false);
  };
  const choices = options ? [...new Set([options.title, options.originalTitle, options.enTitle, ...options.aliases].filter(Boolean))] : [];
  const current = form.watch("title");

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>改标题 / 年份</DialogTitle>
          <DialogDescription className="break-all">「{unit?.rawName}」：只改目录和文件名里的写法，识别结果不变</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4 py-2">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>标题</FormLabel>
                  <FormControl>
                    <Input autoFocus {...field} />
                  </FormControl>
                  <FormDescription className="text-xs">TMDB 的译名是「{tmdbTitle}」；勾了「记住这个识别」的，改的标题也一起记住。</FormDescription>
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
                <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                  {choices.map((c) => (
                    <Button
                      key={c}
                      type="button"
                      size="sm"
                      variant={current === c ? "secondary" : "outline"}
                      className="h-7 max-w-full text-xs"
                      onClick={() => form.setValue("title", c, { shouldDirty: true, shouldValidate: true })}
                    >
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
                    <Input inputMode="numeric" className="w-32" {...field} />
                  </FormControl>
                  <FormDescription className="text-xs">TMDB 上是 {tmdbYear || "未知"}；留空也按 TMDB 的。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  form.setValue("title", tmdbTitle, { shouldDirty: true, shouldValidate: true });
                  form.setValue("year", tmdbYear, { shouldDirty: true, shouldValidate: true });
                }}
                disabled={saving}
              >
                用 TMDB 的
              </Button>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : "重新规划"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
