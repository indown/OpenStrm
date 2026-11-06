"use client";

/**
 * 影库的作品弹框：海报、名字、认的把握和理由；下面是这部作品在影库里的每个版本（哪个分享、哪个目录、几季、多大），
 * 每个版本能打开、转存、换匹配、标成不是影视、重新认。一部剧的几季分开放在同一个目录下的，上面多一行「一起转存」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Download, ExternalLink, EyeOff, FolderOpen, Loader2, MoreHorizontal, RefreshCw, Replace } from "lucide-react";
import { toast } from "sonner";
import type { LibraryOwned, LibraryUnit, LibraryWorkDetail } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/status-badge";
import { MediaFlags } from "@/components/media-flags";
import { ShareDetailDialog } from "@/components/ShareDetailDialog";
import { SaveToDriveDialog, type SaveToTaskChoice } from "@/components/SaveToDriveDialog";
import { MatchDialog, type MatchTarget } from "@/components/MatchDialog";
import { ShareHealthBadge } from "@/components/LibraryHits";
import { WorkPoster } from "@/components/work-poster";
import { useShareDetail } from "@/hooks/use-share-detail";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { copyToClipboard } from "@/lib/clipboard";
import { formatSize } from "@/lib/format";
import { flagsFromTags } from "@/lib/media-flags";
import { displayTags } from "@/lib/resource";
import { notifyFollowResult, notifySaveToTaskResult } from "@/lib/save-result";
import { cn } from "@/lib/utils";

const afterMenuClosed = (fn: () => void) => setTimeout(fn, 0);

async function copyText(text: string, what: string) {
  if (await copyToClipboard(text)) toast.success(`${what}已复制`);
  else toast.error("复制失败");
}

/** 「第 1、2 季」；太多了写范围 */
export function seasonsLabel(seasons: number[]): string {
  if (seasons.length === 0) return "";
  const list = seasons.map((s) => (s === 0 ? "特别篇" : String(s)));
  if (seasons.length > 4 && seasons.every((s, i) => i === 0 || s === seasons[i - 1] + 1)) return `第 ${seasons[0]}–${seasons[seasons.length - 1]} 季`;
  return seasons.every((s) => s === 0) ? "特别篇" : `第 ${list.join("、")} 季`;
}

/** 分享标题 + 路径，相邻重复的只留一个（「老K / 老K / 1. 电影」） */
function whereOf(u: LibraryUnit): string {
  return [u.shareTitle, ...u.crumbs.map((c) => c.name)].filter((seg, i, all) => seg && seg !== all[i - 1]).join(" / ");
}

const CONFIDENCE_NOTE: Record<string, string> = { high: "", medium: "", low: "待确认", none: "没认出" };

const seasonsOf = (list: LibraryUnit[]) => [...new Set(list.flatMap((u) => u.seasons))].sort((a, b) => a - b);

/** 「已经有了」的一处：本地的写任务和目录，从收藏夹存过的写存到哪、哪天 */
function ownedText(o: LibraryOwned): string {
  const seasons = o.seasons.length ? `（${seasonsLabel(o.seasons)}）` : "";
  if (o.via === "local") return `本地「${o.taskLabel}」里的 ${o.path}${seasons}`;
  const day = o.savedAt ? new Date(o.savedAt * 1000).toLocaleDateString() : "";
  return `从收藏夹存到了「${o.taskLabel}」的 ${o.path}${seasons}${day ? `（${day}）` : ""}`;
}

function UnitRow({
  unit,
  opening,
  onOpen,
  onSave,
  onMatch,
  onIgnore,
  onReidentify,
}: {
  unit: LibraryUnit;
  opening: boolean;
  onOpen: () => void;
  onSave: () => void;
  onMatch: () => void;
  onIgnore: () => void;
  onReidentify: () => void;
}) {
  const expired = unit.health.status === "expired";
  const tags = displayTags(unit.tags).slice(0, 6);
  return (
    <div className={cn("flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4", expired && "opacity-60")}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium [overflow-wrap:anywhere]" title={unit.path}>
          {whereOf(unit)}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {unit.size > 0 && <span className="tabular-nums">{formatSize(unit.size)}</span>}
          {unit.videoCount > 0 && <span className="tabular-nums">{unit.videoCount} 个视频</span>}
          {unit.seasons.length > 0 && <span>{seasonsLabel(unit.seasons)}</span>}
          {!unit.ownsDir && <span title="分类目录里散放的文件：转存这几个文件">散放的文件</span>}
          <MediaFlags flags={flagsFromTags(tags)} />
          <ShareHealthBadge health={unit.health} />
        </div>
        {unit.sampleFile && (
          <p className="truncate font-mono text-xs text-muted-foreground" title={unit.sampleFile}>
            {unit.sampleFile}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
        <Button size="sm" variant="outline" onClick={onOpen} disabled={opening || expired}>
          {opening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          打开
        </Button>
        <Button size="sm" onClick={onSave} disabled={expired || unit.saveItems.length === 0}>
          <Download />
          转存
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="更多操作">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => afterMenuClosed(onMatch)}>
              <Replace />
              换匹配
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onReidentify}>
              <RefreshCw />
              重新识别
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onIgnore}>
              <EyeOff />
              不是影视（不再识别）
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void copyText(unit.shareUrl, "链接")}>
              <Copy />
              复制分享链接
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyText(unit.path, "路径")}>
              <Copy />
              复制在分享里的路径
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function LibraryWorkDialog({
  workKey,
  onOpenChange,
  onChanged,
}: {
  workKey: string | null;
  onOpenChange: (open: boolean) => void;
  /** 换匹配 / 忽略 / 重认之后：海报墙重拉 */
  onChanged: () => void;
}) {
  const router = useRouter();
  const share = useShareDetail();
  const [detail, setDetail] = useState<LibraryWorkDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  // 一个版本，或者「一起转存」的那几季（同一个分享）
  const [saving, setSaving] = useState<LibraryUnit[] | null>(null);
  const [matching, setMatching] = useState<LibraryUnit | null>(null);
  // 关的时候 workKey 先变成 null：标题留着上一个，淡出时别闪空
  const [shownKey, setShownKey] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (key: string) => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api.library.workDetail(key);
      if (seq.current === my) setDetail(d);
    } catch (err) {
      if (seq.current === my) {
        setDetail(null);
        setError(apiErrorMessage(err, "加载失败"));
      }
    } finally {
      if (seq.current === my) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!workKey) return;
    setShownKey(workKey);
    setDetail(null);
    void load(workKey);
  }, [workKey, load]);

  /** 改完一个单元：作品弹框重拉（单元可能换到别的作品去了，这部作品空了就关掉），海报墙也重拉 */
  const afterChange = async () => {
    onChanged();
    if (!shownKey) return;
    try {
      const d = await api.library.workDetail(shownKey);
      setDetail(d);
    } catch {
      onOpenChange(false);
    }
  };

  const unitAction = async (unit: LibraryUnit, action: "ignore" | "reidentify") => {
    try {
      await api.library.unitAction({ action, sourceId: unit.sourceId, unitKey: unit.unitKey });
      toast.success(action === "ignore" ? "标成不是影视了，不再识别" : "放回去重新识别了");
      await afterChange();
    } catch (err) {
      toast.error(apiErrorMessage(err, "操作失败"));
    }
  };

  const onOpen = async (unit: LibraryUnit) => {
    const key = `${unit.sourceId}:${unit.unitKey}`;
    setOpeningKey(key);
    try {
      const root = unit.nodeId === "0";
      await share.load(unit.shareUrl, {
        openImmediately: true,
        startCid: root ? undefined : unit.nodeId,
        startCrumbs: root ? undefined : unit.crumbs,
        failMessage: "打开分享失败",
      });
    } finally {
      setOpeningKey(null);
    }
  };

  const confirmSave = async (choice: SaveToTaskChoice) => {
    const list = saving;
    if (!list || list.length === 0) return;
    setSaving(null);
    const unit = list[0];
    const single = list.length === 1 ? unit : null;
    const title = detail?.work.title || unit.rawName;
    const id = toast.loading(`正在转存「${title}」${single ? "" : seasonsLabel(seasonsOf(list))}…`);
    try {
      const result = await api.share.receive({
        url: unit.shareUrl,
        items: list.flatMap((u) => u.saveItems),
        taskId: choice.taskId,
        subPath: choice.subPath,
        mode: choice.mode,
        ...(choice.organize ? { organize: true } : {}),
        ...(choice.copy ? { copy: true } : {}),
        // 追更只盯一个目录：一起转存的几季不建
        ...(choice.follow && single?.ownsDir ? { follow: choice.follow, watchDirId: single.nodeId, watchPath: single.path, name: title } : {}),
      });
      toast.dismiss(id);
      notifySaveToTaskResult(result, router);
      notifyFollowResult(choice, result);
    } catch (err) {
      toast.dismiss(id);
      toast.error(apiErrorMessage(err, "转存失败"));
    }
  };

  const pickMatch = async (pick: { mediaType: "movie" | "tv"; tmdbId: number }): Promise<boolean> => {
    const unit = matching;
    if (!unit) return false;
    try {
      const r = await api.library.unitAction({ action: "match", sourceId: unit.sourceId, unitKey: unit.unitKey, ...pick });
      toast.success(`换成了「${r.unit?.work?.title ?? "新的匹配"}」`);
      // 换到别的作品去了：跟过去
      const nextKey = r.unit?.work ? `${r.unit.work.mediaType}:${r.unit.work.tmdbId}` : shownKey;
      onChanged();
      if (nextKey && nextKey !== shownKey) {
        setShownKey(nextKey);
        void load(nextKey);
      } else void afterChange();
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, "换匹配失败"));
      return false;
    }
  };

  const work = detail?.work;
  const first = detail?.units[0];
  const note = work ? (work.confidence === "none" ? "没认出" : CONFIDENCE_NOTE[work.confidence]) : "";
  // 换匹配弹框按 unit 这个对象重置输入和结果：只在换了单元时给新对象（海报墙在轮询，这里每几秒就重渲一次）
  const matchTarget = useMemo<MatchTarget | null>(
    () =>
      matching
        ? {
            rawName: matching.rawName,
            parsedTitle: matching.parsedTitle,
            parsedYear: matching.parsedYear,
            match: matching.work ? { ...matching.work, candidates: matching.candidates } : null,
          }
        : null,
    [matching],
  );
  // 一起转存的几组是后端算好的（智能体的 library_work 用同一份）：这里只把单元键换回单元
  const groups = useMemo(() => {
    const byKey = new Map((detail?.units ?? []).map((u) => [`${u.sourceId}:${u.unitKey}`, u]));
    return (detail?.seriesGroups ?? [])
      .map((g) => ({ ...g, list: g.units.map((k) => byKey.get(k)).filter((u): u is LibraryUnit => u !== undefined) }))
      .filter((g) => g.list.length === g.units.length);
  }, [detail]);
  const tmdbLink = work?.tmdbId && work.mediaType ? `https://www.themoviedb.org/${work.mediaType}/${work.tmdbId}` : "";

  return (
    <>
      <Dialog open={workKey != null} onOpenChange={onOpenChange}>
        <DialogContent size="lg" className="flex max-h-[85vh] flex-col gap-4">
          <DialogHeader>
            <div className="flex gap-4">
              <WorkPoster url={work?.posterUrl ?? ""} mediaType={work?.mediaType} className="w-20 shrink-0 sm:w-24" sizes="96px" />
              <div className="min-w-0 flex-1 space-y-1.5 text-left">
                <DialogTitle className="[overflow-wrap:anywhere]">{work?.title || (loading ? "加载中…" : "作品")}</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-1.5 text-sm text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {work?.year && <span>{work.year}</span>}
                      {work?.mediaType && <span>{work.mediaType === "tv" ? "剧集" : "电影"}</span>}
                      {work && work.seasons.length > 0 && <span>{seasonsLabel(work.seasons)}</span>}
                      {work && work.versions > 1 && <span>{work.versions} 个版本</span>}
                      {note && <StatusBadge tone={work?.confidence === "low" ? "warning" : "neutral"}>{note}</StatusBadge>}
                    </div>
                    {first?.work && (
                      <p className="text-xs">
                        {first.work.originalTitle && first.work.originalTitle !== first.work.title && <span className="mr-2">原名 {first.work.originalTitle}</span>}
                        <span>{first.work.reason}</span>
                      </p>
                    )}
                    {!first?.work && first && <p className="text-xs">目录名「{first.rawName}」在 TMDB 上没搜到：点版本右边的「⋯ → 换匹配」手动指定。</p>}
                    {detail && detail.owned.length > 0 && (
                      <p className="text-xs text-success [overflow-wrap:anywhere]" title={detail.owned.map(ownedText).join("\n")}>
                        已经有了：{detail.owned.slice(0, 2).map(ownedText).join("；")}
                        {detail.owned.length > 2 ? ` 等 ${detail.owned.length} 处` : ""}
                      </p>
                    )}
                    {tmdbLink && (
                      <a href={tmdbLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs hover:text-foreground">
                        <ExternalLink className="size-3" />
                        在 TMDB 上看
                      </a>
                    )}
                  </div>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
            {loading && !detail ? (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                加载中…
              </div>
            ) : error ? (
              <div className="px-4 py-6 text-sm text-destructive">{error}</div>
            ) : (
              <div className="divide-y">
                {groups.map((g) => (
                  <div key={g.units[0]} className="flex flex-col gap-2 bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                    <p className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
                      「{g.folder}」里分开放着{seasonsLabel(g.seasons)}（{g.list.length} 份），可以一起转存到同一个位置
                    </p>
                    <Button size="sm" className="shrink-0 self-end sm:self-auto" onClick={() => setSaving(g.list)}>
                      <Download />
                      一起转存
                    </Button>
                  </div>
                ))}
                {(detail?.units ?? []).map((u) => (
                  <UnitRow
                    key={`${u.sourceId}:${u.unitKey}`}
                    unit={u}
                    opening={openingKey === `${u.sourceId}:${u.unitKey}`}
                    onOpen={() => void onOpen(u)}
                    onSave={() => setSaving([u])}
                    onMatch={() => setMatching(u)}
                    onIgnore={() => void unitAction(u, "ignore")}
                    onReidentify={() => void unitAction(u, "reidentify")}
                  />
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ShareDetailDialog {...share.dialogProps} />
      <SaveToDriveDialog
        open={saving != null}
        onOpenChange={(open) => !open && setSaving(null)}
        onConfirm={(choice) => void confirmSave(choice)}
        selectedCount={saving?.reduce((n, u) => n + u.saveItems.length, 0) ?? 1}
        kind={saving?.[0]?.shareKind}
        followHint={saving?.length === 1 && saving[0].ownsDir ? `之后定期检查「${saving[0].rawName}」里新增的文件，自动转存到同一位置并生成 strm。` : undefined}
      />
      <MatchDialog unit={matchTarget} onOpenChange={(o) => !o && setMatching(null)} onPick={pickMatch} />
    </>
  );
}
