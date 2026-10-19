"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Film, Loader2, Trash2, Tv } from "lucide-react";
import { toast } from "sonner";
import type { OrganizeMatchMemory } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Spinner } from "@/components/loading";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { fmtTime } from "@/lib/format";

/**
 * 识别记忆：预览里勾了「记住这个识别」的目录，下次整理同一个目录直接按它认（算把握大）。
 * 记错了的在这里删掉，下次就重新识别
 */
export function MemoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [list, setList] = useState<OrganizeMatchMemory[] | null>(null);
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<OrganizeMatchMemory | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setList(null);
    setQuery("");
    api.organize
      .matches()
      .then((r) => setList(r.matches))
      .catch((err) => {
        setList([]);
        toast.error(apiErrorMessage(err, "读取识别记忆失败"));
      });
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = list ?? [];
    return q ? all.filter((m) => `${m.accountName} ${m.srcPath} ${m.title} ${m.tmdbId}`.toLowerCase().includes(q)) : all;
  }, [list, query]);

  const forget = async () => {
    if (!removing) return;
    setWorking(true);
    try {
      await api.organize.forgetMatch(removing.accountName, removing.srcPath);
      setList((prev) => (prev ?? []).filter((m) => !(m.accountName === removing.accountName && m.srcPath === removing.srcPath)));
      toast.success("已删除这条识别记忆");
      setRemoving(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>识别记忆</DialogTitle>
          <DialogDescription>预览里勾了「记住这个识别」的目录：下次整理同一个目录直接按它认（算把握大）。记住的季 / 集偏移只补给文件名没写季的文件，别的季和已经整理好的文件不受影响。记错了的删掉，下次就重新识别。</DialogDescription>
        </DialogHeader>
        {list && list.length > 0 && <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="按目录、片名或编号找" className="h-8 text-xs" />}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list === null ? (
            <Spinner label="加载中…" />
          ) : list.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有记住的识别</p>
          ) : shown.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">没有符合的记录</p>
          ) : (
            <ul className="divide-y">
              {shown.map((m) => (
                <li key={`${m.accountName}:${m.srcPath}`} className="flex items-start gap-2 py-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 text-sm">
                      {m.mediaType === "tv" ? <Tv className="size-3.5 shrink-0 text-muted-foreground" /> : <Film className="size-3.5 shrink-0 text-muted-foreground" />}
                      <span className="font-medium">
                        {m.title || "（没有片名）"}
                        {m.year ? ` (${m.year})` : ""}
                      </span>
                      <a
                        href={`https://www.themoviedb.org/${m.mediaType}/${m.tmdbId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums hover:text-foreground"
                      >
                        #{m.tmdbId}
                        <ExternalLink className="size-3" />
                      </a>
                      {m.season != null && <span className="text-xs text-muted-foreground">季 → {m.season}</span>}
                      {m.episodeOffset !== 0 && <span className="text-xs text-muted-foreground">集偏移 {m.episodeOffset > 0 ? `+${m.episodeOffset}` : m.episodeOffset}</span>}
                      {m.titleOverride && <span className="break-all text-xs text-muted-foreground">标题 → {m.titleOverride}</span>}
                      {m.yearOverride && <span className="text-xs text-muted-foreground">年份 → {m.yearOverride}</span>}
                    </div>
                    <div className="break-all text-xs text-muted-foreground">
                      {m.accountName} · {m.srcPath}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">{fmtTime(m.updatedAt * 1000)}</div>
                  </div>
                  <Button variant="ghost" size="icon" className="size-8 shrink-0 text-destructive hover:text-destructive" title="删除这条记忆" onClick={() => setRemoving(m)}>
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
      <AlertDialog open={removing != null} onOpenChange={(o) => !o && !working && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条识别记忆？</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              「{removing?.srcPath}」下次整理时重新识别，不再直接认成「{removing?.title}」。网盘和已经整理好的文件都不动。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void forget();
              }}
              disabled={working}
            >
              {working ? <Loader2 className="size-4 animate-spin" /> : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
