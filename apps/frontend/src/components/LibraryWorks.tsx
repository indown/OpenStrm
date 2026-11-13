"use client";

/**
 * 影库的「作品」视图：海报墙，同一个 tmdbId 的单元合成一张卡（「N 个版本」），没认出的在「没认出」里。
 * 还有单元在认时隔几秒重拉一次；影库有变动（加了分享、换了匹配）也重拉。
 *
 * 翻页是往下滚自动接的：墙末尾那几格骨架进到视口附近就拉下一页，不用点（方案 .claude/plans/library-paging.md）。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
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
import { Flag } from "@/components/media-flags";
import { LibraryWorkDialog, seasonsLabel } from "@/components/LibraryWorkDialog";
import { api } from "@/lib/api";
import { mapLimit } from "@/lib/async";
import { isNearViewport, useNearViewport } from "@/hooks/use-near-viewport";
import { usePolling } from "@/hooks/use-polling";
import { apiErrorMessage } from "@/lib/axios";
import { LIBRARY_CHANGED_EVENT } from "@/lib/library";
import { posterMarks } from "@/lib/media-flags";
import { cn } from "@/lib/utils";

const PAGE = 60;
/** 接口一次最多给这么多条（后端 routes/library/index.ts 的 worksSchema）：重拉已经展开的那一截要按它分块 */
const MAX_LIMIT = 200;
/** 分块重拉时同时发几块 */
const REFRESH_CONCURRENCY = 3;
/**
 * 后面还有的时候墙末尾补一行骨架，第一格同时是「快到底了」的哨兵。下标是第几格、值是它从哪个断点起才出现：
 * 和 GRID 的列数一一对上（3 / 4 / 5 / 6 / 7 / 8 列），所以任何宽度下都正好一行。
 * 只留一行、而且骨架不参与滚动锚定（overflow-anchor: none），是踩过的坑：手机上骨架多了能占满一屏，浏览器拿骨架当锚点，
 * 新卡片插在它前面时视口跟着骨架一起往下走，哨兵永远在视口里，滚到底一次就把整个库拉完了
 */
const TAIL_SHOW = ["", "", "", "hidden sm:block", "hidden md:block", "hidden lg:block", "hidden xl:block", "hidden 2xl:block"];
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

/** memo：接下一页时前面几百上千张不用跟着重画（onOpen 传的是同一个 setState） */
const WorkCard = memo(function WorkCard({ work, onOpen }: { work: LibraryWork; onOpen: (key: string) => void }) {
  const unidentified = work.tmdbId == null;
  const meta = [work.year, work.seasons.length > 0 ? seasonsLabel(work.seasons) : "", work.versions > 1 ? `${work.versions} 个版本` : ""].filter(Boolean).join(" · ");
  const marks = posterMarks(work.tags);
  return (
    <button type="button" onClick={() => onOpen(work.key)} className="group min-w-0 text-left" title={work.title}>
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
        {marks.length > 0 && (
          <span className="absolute right-1.5 bottom-1.5 flex gap-1" title={`各版本标题里写的：${marks.map((m) => m.title ?? m.label).join(" / ")}`}>
            {marks.map((m) => (
              <Flag key={m.label} flag={m} className="bg-background/85 backdrop-blur" />
            ))}
          </span>
        )}
      </div>
      <div className="mt-1.5 space-y-0.5">
        <p className="truncate text-sm font-medium">{work.title}</p>
        <p className="truncate text-xs text-muted-foreground">{meta || (work.mediaType === "tv" ? "剧集" : work.mediaType === "movie" ? "电影" : "没认出")}</p>
      </div>
    </button>
  );
});

/** 墙上现在的东西 */
interface Wall {
  result: LibraryWorksResult;
  /** 已经展开到第几条：下一页从这里接。和墙上的张数不是一回事——接页时按作品键去重（识别进行中条目会挪位置），张数可能少 */
  next: number;
}

/** 接在后面，已经在墙上的不要第二张 */
function appendWorks(have: LibraryWork[], more: LibraryWork[]): LibraryWork[] {
  const seen = new Set(have.map((w) => w.key));
  return [...have, ...more.filter((w) => !seen.has(w.key))];
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
  const [wall, setWall] = useState<Wall | null>(null);
  const result = wall?.result ?? null;
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 接下一页没接上的原因：有它就停住不再自动试，等人点「重试」 */
  const [moreError, setMoreError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(openWork ?? null);
  useEffect(() => {
    if (openWork) setOpenKey(openWork);
  }, [openWork]);
  // 换筛选 / 排序、整窗重拉都加一：在飞的「接下一页」「只问计数」回来对不上号就丢掉
  const seq = useRef(0);
  // 轮询 / 重拉时拉回已经展开的那么多条，别一刷新就缩回第一页（不少于一页：这一类眼下不满一页，等会儿多了也要拉得到）
  const shownRef = useRef(PAGE);
  /** 下一页从第几条接（和 wall.next 同步）；放 ref 里是为了接页的回调不用跟着墙重建 */
  const nextRef = useRef(0);
  /** 正在整窗重拉的那一轮的序号（没有是 0）：这期间不接下一页，免得重拉回来把刚接的那页盖掉 */
  const refreshing = useRef(0);
  const loadingMoreRef = useRef(false);
  // 在飞的那一次：新一轮开始、换筛选 / 排序、切走时都取消掉，服务端不用再算，浏览器的连接也让出来
  const abortRef = useRef<AbortController | null>(null);
  const moreRef = useRef<AbortController | null>(null);
  const countsRef = useRef<AbortController | null>(null);

  /** 把 [0, count) 这一截拉回来：一次请求最多 MAX_LIMIT 条，展开得多了就分块并发拉、按顺序拼上 */
  const fetchWindow = useCallback(
    async (count: number, signal: AbortSignal): Promise<LibraryWorksResult> => {
      const first = await api.library.works({ view, sort, offset: 0, limit: Math.min(count, MAX_LIMIT) }, signal);
      const want = Math.min(count, first.total);
      const offsets: number[] = [];
      for (let o = MAX_LIMIT; o < want; o += MAX_LIMIT) offsets.push(o);
      if (offsets.length === 0) return first;
      const rest = await mapLimit(offsets, REFRESH_CONCURRENCY, (o) => api.library.works({ view, sort, offset: o, limit: Math.min(MAX_LIMIT, want - o) }, signal));
      return { ...first, works: rest.reduce((all, r) => appendWorks(all, r.works), first.works) };
    },
    [view, sort],
  );

  /** 整窗重拉：首屏、轮询、收藏夹有变动都走它。count 省略就是已经展开的那么多 */
  const fetchWorks = useCallback(
    async (count = shownRef.current): Promise<LibraryWorksResult | null> => {
      const my = ++seq.current;
      refreshing.current = my;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const r = await fetchWindow(count, ac.signal);
        if (seq.current !== my) return null;
        nextRef.current = Math.min(count, r.total);
        shownRef.current = Math.max(PAGE, nextRef.current);
        setWall({ result: r, next: nextRef.current });
        setError(null);
        // 整窗拉得回来说明后端是通的：上一回「接下一页」没接上的提示撤掉，让它自己接着接
        setMoreError(null);
        return r;
      } catch (err) {
        if (seq.current === my && !axios.isCancel(err)) setError(apiErrorMessage(err, "加载作品失败"));
        return null;
      } finally {
        if (refreshing.current === my) refreshing.current = 0;
      }
    },
    [fetchWindow],
  );

  useEffect(() => {
    shownRef.current = PAGE;
    nextRef.current = 0;
    setWall(null);
    setMoreError(null);
    void fetchWorks(PAGE);
    return () => {
      abortRef.current?.abort();
      moreRef.current?.abort();
      countsRef.current?.abort();
    };
  }, [fetchWorks]);

  useEffect(() => {
    const onChanged = () => void fetchWorks();
    window.addEventListener(LIBRARY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, onChanged);
  }, [fetchWorks]);

  /**
   * 只问计数、墙不动：展开超过一次请求的上限以后，识别中的轮询走这个。
   * 人已经滚到几百张以后，头上冒新卡也看不见，不值得每几秒把几百上千条重拉一遍；筛选药丸上的数和「还有 N 个在识别」照样跟着走
   */
  const fetchCounts = useCallback(async (): Promise<LibraryWorksResult | null> => {
    const my = seq.current;
    countsRef.current?.abort();
    const ac = new AbortController();
    countsRef.current = ac;
    try {
      const r = await api.library.works({ view, sort, offset: 0, limit: 1 }, ac.signal);
      if (seq.current !== my) return null;
      setWall((prev) => (prev ? { ...prev, result: { ...prev.result, total: r.total, counts: r.counts, tmdbConfigured: r.tmdbConfigured, ownedPending: r.ownedPending } } : prev));
      return r;
    } catch {
      return null;
    }
  }, [view, sort]);

  // 还有单元在认：隔几秒重拉（认出来的一张张冒出来）。待认数连续几轮没变就放慢，别一直打后端
  const pending = result?.counts.pending ?? 0;
  const polling = pending > 0 && result?.tmdbConfigured === true;
  const [slow, setSlow] = useState(false);
  const roundsRef = useRef({ pending: -1, rounds: 0 });
  const wasPolling = useRef(false);
  useEffect(() => {
    if (polling) {
      wasPolling.current = true;
      return;
    }
    roundsRef.current = { pending: -1, rounds: 0 };
    setSlow(false);
    // 认完了：展开得多、轮询期间墙一直没动的，这时候整窗拉一次补齐
    if (wasPolling.current && shownRef.current > MAX_LIMIT) void fetchWorks();
    wasPolling.current = false;
  }, [polling, fetchWorks]);
  usePolling(
    async () => {
      const r = shownRef.current > MAX_LIMIT ? await fetchCounts() : await fetchWorks();
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

  /* ---- 接下一页：往下滚自动接；出错了停住等人点重试 ---- */
  const shown = wall?.next ?? 0;
  const hasMore = wall !== null && shown < wall.result.total;
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || refreshing.current) return;
    const my = seq.current;
    const offset = nextRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    moreRef.current?.abort();
    const ac = new AbortController();
    moreRef.current = ac;
    try {
      const r = await api.library.works({ view, sort, offset, limit: PAGE }, ac.signal);
      if (seq.current !== my) return;
      // 一条都没回来：后面没有了，别原地打转
      const next = r.works.length > 0 ? offset + r.works.length : Math.max(offset, r.total);
      nextRef.current = next;
      shownRef.current = Math.max(PAGE, next);
      setWall((prev) => (prev ? { result: { ...r, works: appendWorks(prev.result.works, r.works) }, next } : prev));
    } catch (err) {
      if (seq.current === my && !axios.isCancel(err)) setMoreError(apiErrorMessage(err, "网络或服务出了问题"));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [view, sort]);

  // 浏览器没有 IntersectionObserver 的（很老的）退回按钮：那种情况下哨兵永远算「在附近」，自动接会一口气把整个库拉完
  const [auto] = useState(() => typeof IntersectionObserver !== "undefined");
  const [observeTail, nearEnd] = useNearViewport<HTMLDivElement>();
  const tailEl = useRef<HTMLDivElement | null>(null);
  const tailRef = useCallback(
    (el: HTMLDivElement | null) => {
      tailEl.current = el;
      observeTail(el);
    },
    [observeTail],
  );
  useEffect(() => {
    // wall / error 在依赖里：一页接完、一轮重拉结束（成不成）以后哨兵还在附近的话，要再看一眼接着接
    if (!auto || !nearEnd || !hasMore || loadingMore || moreError) return;
    // nearEnd 是观察者上一回说的，刚接完一页时还没改口：现量一下，不然每次都多接一页
    if (tailEl.current && !isNearViewport(tailEl.current)) return;
    void loadMore();
  }, [auto, nearEnd, hasMore, loadingMore, moreError, loadMore, wall, error]);

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
            <WorkCard key={w.key} work={w} onOpen={setOpenKey} />
          ))}
          {/* 后面还有：末尾补一行骨架，真卡片来了原地换上、不跳。第一格是哨兵，它进到视口附近就接下一页 */}
          {auto &&
            hasMore &&
            !moreError &&
            Array.from({ length: Math.min(TAIL_SHOW.length, result.total - shown) }).map((_, i) => (
              <div key={`more-${i}`} ref={i === 0 ? tailRef : undefined} className={cn("space-y-1.5 [overflow-anchor:none]", TAIL_SHOW[i])} aria-hidden="true">
                <Skeleton className="aspect-[2/3] w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ))}
        </div>
      )}
      {moreError ? (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-destructive" role="alert">
          <span>后面的没加载出来：{moreError}</span>
          <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            重试
          </Button>
        </div>
      ) : hasMore ? (
        // 没有 IntersectionObserver 的浏览器：还是点一下接一页
        !auto && (
          <div className="text-center">
            <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore && <Loader2 className="animate-spin" />}
              再加载 {Math.min(PAGE, result.total - shown)} 部（共 {result.total} 部）
            </Button>
          </div>
        )
      ) : (
        // 一页就装下的不用说；往下接过页的，到底了说一声
        shown > PAGE && <p className="text-center text-xs text-muted-foreground tabular-nums">共 {result.total} 部，都在这儿了</p>
      )}
      <span className="sr-only" role="status">
        {loadingMore ? "正在加载更多作品" : ""}
      </span>
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
