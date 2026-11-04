"use client";

/**
 * 影库的「作品」视图：海报墙，同一个 tmdbId 的单元合成一张卡（「N 个版本」），没认出的在「没认出」里。
 * 还有单元在认时隔几秒重拉一次；影库有变动（加了分享、换了匹配）也重拉。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { Loader2, Settings as SettingsIcon, Sparkles } from "lucide-react";
import type { LibraryWork, LibraryWorksResult, LibraryWorksSort, LibraryWorksView } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { ViewChip } from "@/components/view-chip";
import { WorkPoster } from "@/components/work-poster";
import { LibraryWorkDialog, seasonsLabel } from "@/components/LibraryWorkDialog";
import { api } from "@/lib/api";
import { usePolling } from "@/hooks/use-polling";
import { apiErrorMessage } from "@/lib/axios";
import { LIBRARY_CHANGED_EVENT } from "@/lib/library";

const PAGE = 60;
const POLL_MS = 5000;
/** 待认数连续这么多轮没变（TMDB 不通、识别卡住了）：轮询放慢到这个间隔 */
const POLL_SLOW_MS = 15_000;
const SLOW_AFTER_ROUNDS = 6;
const GRID = "grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8";

const SORTS: Array<{ key: LibraryWorksSort; label: string }> = [
  { key: "recent", label: "最近入库" },
  { key: "year", label: "年份" },
  { key: "title", label: "名称" },
];

function WorkCard({ work, onOpen }: { work: LibraryWork; onOpen: () => void }) {
  const unidentified = work.tmdbId == null;
  const meta = [work.year, work.seasons.length > 0 ? seasonsLabel(work.seasons) : "", work.versions > 1 ? `${work.versions} 个版本` : ""].filter(Boolean).join(" · ");
  return (
    <button type="button" onClick={onOpen} className="group min-w-0 text-left" title={work.title}>
      <div className="relative">
        <WorkPoster url={work.posterUrl} mediaType={work.mediaType} label={unidentified ? work.title : undefined} className="transition group-hover:ring-2 group-hover:ring-brand" />
        {work.confidence === "low" && (
          <StatusBadge tone="warning" className="absolute top-1.5 left-1.5 bg-background/85 backdrop-blur">
            待确认
          </StatusBadge>
        )}
        {work.versions > 1 && (
          <span className="absolute top-1.5 right-1.5 rounded bg-background/85 px-1.5 text-[11px] leading-5 font-medium tabular-nums backdrop-blur">{work.versions}</span>
        )}
        {work.owned && (
          <StatusBadge tone="success" className="absolute bottom-1.5 left-1.5 bg-background/85 backdrop-blur" title="本地已经有了，或者从收藏夹存过">
            已有
          </StatusBadge>
        )}
      </div>
      <div className="mt-1.5 space-y-0.5">
        <p className="truncate text-sm font-medium">{work.title}</p>
        <p className="truncate text-xs text-muted-foreground">{meta || (work.mediaType === "tv" ? "剧集" : work.mediaType === "movie" ? "电影" : "没认出")}</p>
      </div>
    </button>
  );
}

export function LibraryWorks({
  sourcesLoaded = true,
  onShowShares,
  openWork,
  onWorkClosed,
}: {
  /** 来源列表回来了没有（页面和作品墙并行拉）：没回来前墙上空着只画骨架，别先闪一下空状态——来源一个都没有时页面会换成自己的空状态 */
  sourcesLoaded?: boolean;
  onShowShares: () => void;
  /** 地址里带着的作品键（`/library?work=tv:1399`，智能体给的「在 OpenStrm 里打开」）：进来就打开它的弹框 */
  openWork?: string | null;
  onWorkClosed?: () => void;
}) {
  const [view, setView] = useState<LibraryWorksView>("all");
  const [sort, setSort] = useState<LibraryWorksSort>("recent");
  const [result, setResult] = useState<LibraryWorksResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(openWork ?? null);
  useEffect(() => {
    if (openWork) setOpenKey(openWork);
  }, [openWork]);
  const seq = useRef(0);
  // 轮询 / 重拉时拉回已经展开的那么多条，别一刷新就缩回第一页
  const shownRef = useRef(PAGE);
  // 在飞的那一次：新一轮开始、换筛选 / 排序、切走时都取消掉，服务端不用再算，浏览器的连接也让出来
  const abortRef = useRef<AbortController | null>(null);
  const moreRef = useRef<AbortController | null>(null);

  const fetchWorks = useCallback(
    async (limit = shownRef.current): Promise<LibraryWorksResult | null> => {
      const my = ++seq.current;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const r = await api.library.works({ view, sort, offset: 0, limit }, ac.signal);
        if (seq.current !== my) return null;
        setResult(r);
        setError(null);
        return r;
      } catch (err) {
        if (seq.current === my && !axios.isCancel(err)) setError(apiErrorMessage(err, "加载作品失败"));
        return null;
      }
    },
    [view, sort],
  );

  useEffect(() => {
    shownRef.current = PAGE;
    setResult(null);
    void fetchWorks(PAGE);
    return () => abortRef.current?.abort();
  }, [fetchWorks]);
  useEffect(() => () => moreRef.current?.abort(), []);

  useEffect(() => {
    const onChanged = () => void fetchWorks();
    window.addEventListener(LIBRARY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, onChanged);
  }, [fetchWorks]);

  // 还有单元在认：隔几秒重拉（认出来的一张张冒出来）。待认数连续几轮没变就放慢，别一直打后端
  const pending = result?.counts.pending ?? 0;
  const polling = pending > 0 && result?.tmdbConfigured === true;
  const [slow, setSlow] = useState(false);
  const roundsRef = useRef({ pending: -1, rounds: 0 });
  useEffect(() => {
    if (polling) return;
    roundsRef.current = { pending: -1, rounds: 0 };
    setSlow(false);
  }, [polling]);
  usePolling(
    async () => {
      const r = await fetchWorks();
      if (!r) return;
      const s = roundsRef.current;
      if (r.counts.pending === s.pending) s.rounds += 1;
      else roundsRef.current = { pending: r.counts.pending, rounds: 0 };
      setSlow(roundsRef.current.rounds >= SLOW_AFTER_ROUNDS);
    },
    slow ? POLL_SLOW_MS : POLL_MS,
    { enabled: polling },
  );

  // 本地已有的第一次要扫一遍各任务的本地目录：没扫好时后端只标了存过的，过几秒再拉一次补上「已有」（在轮询的话下一次就有了）
  const ownedPending = result?.ownedPending === true && !polling;
  useEffect(() => {
    if (!ownedPending) return;
    const t = setTimeout(() => void fetchWorks(), POLL_MS);
    return () => clearTimeout(t);
  }, [ownedPending, fetchWorks]);

  const loadMore = async () => {
    if (!result) return;
    setLoadingMore(true);
    moreRef.current?.abort();
    const ac = new AbortController();
    moreRef.current = ac;
    try {
      const r = await api.library.works({ view, sort, offset: result.works.length, limit: PAGE }, ac.signal);
      shownRef.current = result.works.length + r.works.length;
      setResult((prev) => (prev ? { ...r, works: [...prev.works, ...r.works] } : r));
    } catch (err) {
      if (!axios.isCancel(err)) setError(apiErrorMessage(err, "加载更多失败"));
    } finally {
      setLoadingMore(false);
    }
  };

  const counts = result?.counts;
  const nothing = counts && counts.all + counts.none + counts.pending === 0;

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <ViewChip active={view === "all"} onClick={() => setView("all")} label="全部" count={counts?.all ?? 0} />
      <ViewChip active={view === "movie"} onClick={() => setView("movie")} label="电影" count={counts?.movie ?? 0} />
      <ViewChip active={view === "tv"} onClick={() => setView("tv")} label="剧集" count={counts?.tv ?? 0} />
      {(counts?.low ?? 0) > 0 && <ViewChip active={view === "low"} onClick={() => setView("low")} label="待确认" count={counts?.low ?? 0} />}
      {(counts?.none ?? 0) > 0 && <ViewChip active={view === "none"} onClick={() => setView("none")} label="没认出" count={counts?.none ?? 0} />}
      <div className="ml-auto flex items-center gap-2">
        {result?.tmdbConfigured && pending > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            还有 {pending} 个在识别
          </span>
        )}
        <Select value={sort} onValueChange={(v) => setSort(v as LibraryWorksSort)}>
          <SelectTrigger size="sm" className="w-28" aria-label="排序">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  const skeleton = (
    <div className={GRID}>
      {Array.from({ length: 14 }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="aspect-[2/3] w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ))}
    </div>
  );

  if (!result) {
    return error ? (
      <EmptyState icon={Sparkles} title="作品加载失败" description={error} action={<Button variant="outline" onClick={() => void fetchWorks(PAGE)}>重试</Button>} />
    ) : (
      skeleton
    );
  }

  // 墙上空着、来源列表又还没回来：先画骨架。来源确认为空时页面换成自己的空状态，有来源才显示下面这两种
  if (!sourcesLoaded && (nothing || (!result.tmdbConfigured && result.counts.all === 0))) return skeleton;

  if (!result.tmdbConfigured && result.counts.all === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="配上 TMDB 就能按作品看"
        description={`收藏夹里${pending > 0 ? `切出了 ${pending} 部作品，` : ""}要用 TMDB 认出是哪一部（海报、正式名、英文名都能搜）。到设置页填入 TMDB 的 API Key，配上以后自动开始认；分享和搜索现在就能用。`}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href="/settings#tmdb">
                <SettingsIcon />
                去设置
              </Link>
            </Button>
            <Button variant="outline" onClick={onShowShares}>
              看分享列表
            </Button>
          </div>
        }
      />
    );
  }

  if (nothing) {
    return (
      <EmptyState
        icon={Sparkles}
        title="还没有作品"
        description="加进来的分享抄完目录树以后，会切出一部部作品、用 TMDB 认出来，出现在这里。"
        action={
          <Button variant="outline" onClick={onShowShares}>
            看分享列表
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {toolbar}
      {view === "low" && <p className="text-xs text-muted-foreground">这些只是 TMDB 搜索结果里最像的，点开看一下：不对就「换匹配」，确实不是影视就「不是影视」。</p>}
      {view === "none" && <p className="text-xs text-muted-foreground">名字在 TMDB 上没搜到。点开「换匹配」手动指定，或者标成「不是影视」。</p>}
      {result.works.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">这一类里没有作品。</p>
      ) : (
        <div className={GRID}>
          {result.works.map((w) => (
            <WorkCard key={w.key} work={w} onOpen={() => setOpenKey(w.key)} />
          ))}
        </div>
      )}
      {result.works.length < result.total && (
        <div className="text-center">
          <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Loader2 className="animate-spin" />}
            再加载 {Math.min(PAGE, result.total - result.works.length)} 部（共 {result.total} 部）
          </Button>
        </div>
      )}
      <LibraryWorkDialog
        workKey={openKey}
        onOpenChange={(o) => {
          if (o) return;
          setOpenKey(null);
          if (openWork) onWorkClosed?.();
        }}
        onChanged={() => void fetchWorks()}
      />
    </div>
  );
}
