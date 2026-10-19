"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Loader2 } from "lucide-react";
import type { OrganizeEpisodePin, OrganizeItem } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { baseName } from "@/lib/organize";

/** 两个字段都当字符串收：空字符串是「按原来的算」，和填了 0 不是一回事 */
const schema = z
  .object({
    season: z
      .string()
      .trim()
      .refine((v) => v === "" || /^\d{1,2}$/.test(v), "季填 0–99 的整数，留空按原来的算"),
    episode: z
      .string()
      .trim()
      .refine((v) => v === "" || /^\d{1,4}$/.test(v), "集填整数，留空按原来的算"),
  })
  .refine((v) => v.season !== "" || v.episode !== "", { message: "季和集至少填一个", path: ["episode"] });

type Values = z.infer<typeof schema>;

/** 把一个视频钉成第几季第几集：看不出集数的文件靠它排进去；钉了的不再受文件名、季覆盖 / 集偏移影响 */
export function PinDialog({
  target,
  onOpenChange,
  onSave,
}: {
  target: { item: OrganizeItem; pin?: OrganizeEpisodePin } | null;
  onOpenChange: (open: boolean) => void;
  /** 成功返回 true 才关弹框；null 是撤掉 */
  onSave: (pin: OrganizeEpisodePin | null) => Promise<boolean>;
}) {
  const open = target != null;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { season: "", episode: "" } });
  const saving = form.formState.isSubmitting;

  useEffect(() => {
    if (!target) return;
    form.reset({
      season: target.pin?.season === undefined ? "" : String(target.pin.season),
      episode: target.pin?.episode === undefined ? "" : String(target.pin.episode),
    });
  }, [target, form]);

  const submit = async (values: Values) => {
    const ok = await onSave({
      ...(values.season === "" ? {} : { season: Number(values.season) }),
      ...(values.episode === "" ? {} : { episode: Number(values.episode) }),
    });
    if (ok) onOpenChange(false);
  };
  const clear = async () => {
    if (await onSave(null)) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>钉季 / 集</DialogTitle>
          <DialogDescription className="break-all">{target ? baseName(target.item.srcPath) : ""}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="season"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>季</FormLabel>
                    <FormControl>
                      <Input inputMode="numeric" placeholder="按原来的" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="episode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>集</FormLabel>
                    <FormControl>
                      <Input inputMode="numeric" placeholder="按原来的" autoFocus {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <p className="text-xs text-muted-foreground">钉了的文件不再受文件名、季覆盖和集偏移影响；0 季是特别篇。只填集就只钉集，季照旧算。</p>
            <DialogFooter>
              {target?.pin && (
                <Button type="button" variant="ghost" onClick={() => void clear()} disabled={saving}>
                  撤掉
                </Button>
              )}
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
