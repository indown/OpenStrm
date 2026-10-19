"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Loader2 } from "lucide-react";
import type { OrganizeItem } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { baseName, dirName } from "@/lib/organize";

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "填个文件名")
    .refine((v) => !v.includes("/"), "文件名不能带目录"),
});

type Values = z.infer<typeof schema>;

/** 冲突项「自己改名」、任意文件「改文件名」：目录还是整理算出来的位置，名字自己填 */
export function RenameDialog({
  item,
  title = "自己改名",
  initialName,
  onOpenChange,
  onSave,
  onClear,
}: {
  item: OrganizeItem | null;
  title?: string;
  /** 输入框的初始值；不给就用整理算出来的目标名 */
  initialName?: string;
  onOpenChange: (open: boolean) => void;
  /** 成功返回 true 才关弹框；失败的提示由调用方给 */
  onSave: (name: string) => Promise<boolean>;
  /** 已经改过名：撤掉、回到模板算的名字 */
  onClear?: () => Promise<boolean>;
}) {
  const open = item != null;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: "" } });
  const saving = form.formState.isSubmitting;

  useEffect(() => {
    if (item) form.reset({ name: initialName ?? baseName(item.dstPath) });
  }, [item, initialName, form]);

  const submit = async (values: Values) => {
    if (await onSave(values.name)) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-all">{item ? baseName(item.srcPath) : ""}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-2 py-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>整理后的文件名</FormLabel>
                  <FormControl>
                    <Input autoFocus {...field} />
                  </FormControl>
                  <FormDescription className="break-all text-xs">
                    放在 {item ? dirName(item.dstPath) : ""}/ 下；不写扩展名就沿用原来的。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className="pt-2">
              {onClear && (
                <Button type="button" variant="ghost" onClick={() => void onClear().then((ok) => ok && onOpenChange(false))} disabled={saving}>
                  撤掉改名
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
