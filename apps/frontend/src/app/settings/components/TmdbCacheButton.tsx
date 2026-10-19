"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";

/**
 * 设置页 TMDB 一节的「清空 TMDB 缓存」：TMDB 上改了译名 / 海报，不等详情那 7 天过期就重新拉。
 * 是一个动作不是表单字段：不碰表单的脏状态，按钮要 type="button" 免得把整页设置提交了
 */
export function TmdbCacheButton() {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);

  const clear = async () => {
    setWorking(true);
    try {
      const { cleared } = await api.organize.clearTmdbCache();
      toast.success(cleared > 0 ? `已清空 ${cleared} 条 TMDB 缓存，下次预览 / 识别会重新拉取` : "TMDB 缓存本来就是空的");
      setOpen(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, "清空 TMDB 缓存失败"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        搜索结果、作品详情和季集信息会缓存在库里（详情 7 天）。TMDB 上改了译名 / 海报不想等过期，就清掉，下次预览、识别和海报墙重新拉取。
      </p>
      <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setOpen(true)} disabled={working}>
        {working ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        清空 TMDB 缓存
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !o && !working && setOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空 TMDB 缓存？</AlertDialogTitle>
            <AlertDialogDescription>
              库里缓存的搜索结果、作品详情和季集信息全部删掉。已经整理好的文件和识别记忆都不受影响；下次预览、识别和海报墙会重新向 TMDB 拉取，作品多的话要多等一会儿。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void clear();
              }}
              disabled={working}
            >
              {working ? <Loader2 className="size-4 animate-spin" /> : "清空"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
