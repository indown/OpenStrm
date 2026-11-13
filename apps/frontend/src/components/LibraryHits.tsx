"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bookmark, ChevronDown, ChevronRight, Copy, Download, FolderOpen, Folders, Loader2, MoreHorizontal, Search } from "lucide-react";
import { toast } from "sonner";
import type { LibraryHit, LibrarySearchResult, LibraryShareHealth } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/status-badge";
import { ShareDetailDialog } from "@/components/ShareDetailDialog";
import { SaveToDriveDialog, type SaveToTaskChoice } from "@/components/SaveToDriveDialog";
import { isNearViewport, useNearViewport } from "@/hooks/use-near-viewport";
import { useShareDetail } from "@/hooks/use-share-detail";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { copyToClipboard } from "@/lib/clipboard";
import { formatSize } from "@/lib/format";
import { flagsFromTags } from "@/lib/media-flags";
import { displayTags } from "@/lib/resource";
import { notifyFollowResult, notifySaveToTaskResult } from "@/lib/save-result";
import { cn } from "@/lib/utils";
import { WorkPoster } from "@/components/work-poster";
import { MediaFlags } from "@/components/media-flags";

/** 一行最多挂几个标签 */
const TAGS_SHOWN = 6;
/** 搜完对结果里的分享查死活：超过这么久没查过的才去问（后端也按 6 小时判） */
const STALE_MS = 6 * 3600 * 1000;

/** 两个搜索词是不是一回事：大小写、空白、标点不计较 */
const sameWords = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 名字里的关键词加粗。名字是分享者写的：只当纯文本拼 */
function highlight(text: string, keyword: string): React.ReactNode {
  const terms = keyword.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (terms.length === 0) return text;
  const parts = text.split(new RegExp(`(${terms.join("|")})`, "gi"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-transparent font-semibold text-brand">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** 分享死活的徽标：能用的不挂，免得每行都一个 */
export function ShareHealthBadge({ health }: { health: LibraryShareHealth }) {
  if (health.status === "suspect") {
    return (
      <StatusBadge tone="warning" title={`最近一次打不开：${health.reason || "原因不明"}；在复查，还能试`}>
        可能已失效
      </StatusBadge>
    );
  }
  if (health.status === "locked") {
    return (
      <StatusBadge tone="danger" title="提取码不对：到收藏夹页改提取码">
        提取码不对
      </StatusBadge>
    );
  }
  if (health.status === "expired") {
    return (
      <StatusBadge tone="danger" title={health.reason || undefined}>
        已失效
      </StatusBadge>
    );
  }
  return null;
}

/** 分享标题常和第一层目录同名（「老K / 老K / 1. 电影」）：相邻重复的只留一个 */
function whereOf(hit: LibraryHit): string {
  return [hit.shareTitle, ...hit.crumbs.slice(0, -1).map((c) => c.name)].filter((seg, i, all) => seg && seg !== all[i - 1]).join(" / ");
}

async function copyText(text: string, what: string) {
  if (await copyToClipboard(text)) toast.success(`${what}已复制`);
  else toast.error("复制失败");
}

/** 从下拉菜单里开弹框要等菜单先关掉（见 search 页 ResultRow 的说明） */
const afterMenuClosed = (fn: () => void) => setTimeout(fn, 0);

interface RowProps {
  hit: LibraryHit;
  keyword: string;
  health: LibraryShareHealth;
  expired?: boolean;
  opening: boolean;
  onOpen: (hit: LibraryHit) => void;
  onSave: (hit: LibraryHit) => void;
  onFindAlt: (hit: LibraryHit) => void;
  /** 找替代会不会换个词搜：搜索页上关键词就是当前这个词时，替代的就列在同一页，按钮点了原地不动，不给 */
  canFindAlt: boolean;
}

const LibraryHitRow = memo(function LibraryHitRow({ hit, keyword, health, expired, opening, onOpen, onSave, onFindAlt, canFindAlt }: RowProps) {
  const tags = displayTags(hit.tags);
  const work = hit.work;
  const where = whereOf(hit);
  const indexed = hit.indexedAt ? new Date(hit.indexedAt * 1000).toLocaleString("zh-CN", { hour12: false }) : null;
  // 分享根（整包）没法当一个条目转存：点「转存」先打开挑
  const canSaveDirect = hit.nodeId !== "0";
  return (
    <div className={cn("flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4", expired && "opacity-60")}>
      <div className="flex min-w-0 flex-1 gap-3">
        {work && <WorkPoster url={work.posterUrl} mediaType={work.mediaType} className="w-11 shrink-0 self-start" sizes="44px" />}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-2">
            {!work && <FolderOpen className="mt-0.5 size-4 shrink-0 text-warning" />}
            <p className="line-clamp-2 min-w-0 text-sm leading-snug font-medium [overflow-wrap:anywhere]" title={hit.name}>
              {highlight(hit.name, keyword)}
            </p>
          </div>
          {/* 认出来的作品：TMDB 上的名字、年份；把握低的说「可能是」 */}
          {work && (
            <p className="text-xs text-muted-foreground">
              {work.confidence === "low" && "可能是 "}
              <span className="font-medium text-foreground">《{work.title}》</span>
              {[work.year, work.mediaType === "tv" ? "剧集" : "电影"].filter(Boolean).join(" · ")}
            </p>
          )}
          <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="max-w-[22rem] truncate" title={`${hit.path}${indexed ? `\n索引于 ${indexed}` : ""}`}>
              {where || "分享根目录"}
            </span>
            {hit.size != null && hit.size > 0 && <span className="tabular-nums">{formatSize(hit.size)}</span>}
            {hit.videoCount > 0 && <span className="tabular-nums">{hit.videoCount} 个视频</span>}
            {tags.length > 0 && <MediaFlags flags={flagsFromTags(tags)} max={TAGS_SHOWN} title={tags.join(" · ")} />}
            <ShareHealthBadge health={health} />
          </div>
          {/* 剧目录、分类目录：视频在下一层，先报下一层是些什么（季目录名里常有画质、集数、体积） */}
          {hit.subdirs.length > 0 && (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={hit.subdirs.join("\n")}>
              <Folders className="size-3.5 shrink-0" />
              <span className="truncate">
                {hit.subdirs.join(" · ")}
                {hit.subdirCount > hit.subdirs.length && ` 等 ${hit.subdirCount} 个`}
              </span>
            </p>
          )}
          {hit.files.length > 0 && (
            <p className="truncate font-mono text-xs text-muted-foreground" title={hit.files.map((f) => f.name).join("\n")}>
              {highlight(hit.files[0].name, keyword)}
              {hit.videoCount > 1 && <span className="font-sans"> 等 {hit.videoCount} 个</span>}
            </p>
          )}
          {/* 已经列出下一层目录名的不再说「里面还有几个也对得上」：看得见是哪几个 */}
          {hit.childHits > 0 && hit.subdirs.length === 0 && <p className="text-xs text-muted-foreground">里面还有 {hit.childHits} 个子目录也对得上</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
        {expired ? (
          canFindAlt && (
            <Button size="sm" variant="outline" onClick={() => onFindAlt(hit)}>
              <Search />
              找替代
            </Button>
          )
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => onOpen(hit)} disabled={opening}>
              {opening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              打开
            </Button>
            <Button size="sm" onClick={() => (canSaveDirect ? onSave(hit) : onOpen(hit))}>
              <Download />
              转存
            </Button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="更多操作">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void copyText(hit.shareUrl, "链接")}>
              <Copy />
              复制分享链接
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyText(hit.path, "路径")}>
              <Copy />
              复制在分享里的路径
            </DropdownMenuItem>
            {!expired && canFindAlt && (
              <DropdownMenuItem onSelect={() => afterMenuClosed(() => onFindAlt(hit))}>
                <Search />
                找别的资源
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});

export interface LibraryHitsSummary {
  total: number;
  expired: number;
  loading: boolean;
  error: string | null;
}

/** 搜索接口一次最多给这么多条（后端 routes/library/index.ts 的 searchSchema）：重搜已经展开的那一截要按它分块 */
const SEARCH_MAX_LIMIT = 100;

const hitKey = (h: LibraryHit): string => `${h.sourceId}:${h.nodeId}`;

/** 接在后面，已经列出来的不要第二条 */
function appendHits(have: LibraryHit[], more: LibraryHit[]): LibraryHit[] {
  const seen = new Set(have.map(hitKey));
  return [...have, ...more.filter((h) => !seen.has(hitKey(h)))];
}

interface Props {
  query: string;
  /** embedded：首页搜索顶上那一块，只列几条 + 「在影库里看全部」；page：影库页整页，往下滚自动接着加载 */
  variant?: "embedded" | "page";
  pageSize?: number;
  onSummary?: (s: LibraryHitsSummary) => void;
}

/**
 * 影库搜索结果：一行一个目录。首页搜索（嵌在最上面）和影库页共用。
 * 自带「打开」（分享弹框直接定位到那一层）和「转存到任务目录」；搜完对结果里的分享查一下死活，
 * 刚查出失效的挪进最下面折叠着的「已失效」
 */
export function LibraryHits({ query, variant = "page", pageSize = 20, onSummary }: Props) {
  const router = useRouter();
  const q = query.trim();
  const [result, setResult] = useState<LibrarySearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 接下一页没接上的原因：有它就停住不再自动试，等人点「重试」 */
  const [moreError, setMoreError] = useState<string | null>(null);
  /** 已经展开到第几条：下一页从这里接（接页时按条目去重，列出来的条数可能少） */
  const [shown, setShown] = useState(pageSize);
  const shownRef = useRef(pageSize);
  const loadingMoreRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, LibraryShareHealth>>({});
  const [showExpired, setShowExpired] = useState(false);
  const [expiredHits, setExpiredHits] = useState<LibraryHit[] | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [saving, setSaving] = useState<LibraryHit | null>(null);
  const share = useShareDetail();
  const seq = useRef(0);

  const run = useCallback(
    async (silent = false) => {
      const my = ++seq.current;
      if (!q) {
        setResult(null);
        setError(null);
        setLoading(false);
        return;
      }
      if (!silent) {
        setLoading(true);
        setMoreError(null);
        shownRef.current = pageSize;
      }
      // 静默重搜（查出有分享失效、打开 / 转存失败之后）拉回已经展开的那么多条：只拉第一页的话下面展开的几页会缩回去
      const count = Math.max(pageSize, shownRef.current);
      try {
        let r = await api.library.search({ q, limit: Math.min(count, SEARCH_MAX_LIMIT) });
        if (my !== seq.current) return;
        let got = r.hits.length;
        while (got > 0 && got < Math.min(count, r.total)) {
          const more = await api.library.search({ q, limit: Math.min(SEARCH_MAX_LIMIT, count - got), offset: got });
          if (my !== seq.current) return;
          if (more.hits.length === 0) break;
          r = { ...r, hits: appendHits(r.hits, more.hits), total: more.total };
          got += more.hits.length;
        }
        shownRef.current = got;
        setShown(got);
        setResult(r);
        setError(null);
      } catch (err) {
        if (my !== seq.current) return;
        setError(apiErrorMessage(err, "搜收藏夹失败"));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [q, pageSize],
  );

  useEffect(() => {
    setShowExpired(false);
    setExpiredHits(null);
    setHealth({});
    void run();
  }, [run]);

  useEffect(() => {
    onSummary?.({ total: result?.total ?? 0, expired: result?.expired ?? 0, loading, error });
  }, [result, loading, error, onSummary]);

  // 结果里的分享顺手查死活：好久没查过的才问；查出失效的重新搜一遍，让它们挪进「已失效」
  const checkedFor = useRef("");
  useEffect(() => {
    if (!result || result.hits.length === 0) return;
    // 只看第一页的：往下接页不该每接一页就再问一遍网盘（重搜以后第一页变了才会再问）
    const head = result.hits.slice(0, pageSize);
    const key = `${q}\n${head.map((h) => h.shareCode).join(",")}`;
    if (checkedFor.current === key) return;
    checkedFor.current = key;
    const now = Date.now();
    const codes = [
      ...new Set(
        head
          .filter((h) => h.health.status !== "expired" && (!h.health.checkedAt || now - h.health.checkedAt * 1000 > STALE_MS))
          .map((h) => h.shareCode),
      ),
    ].slice(0, 10);
    if (codes.length === 0) return;
    let alive = true;
    void api.library
      .checkShares(codes)
      .then(({ health: h }) => {
        if (!alive) return;
        setHealth((prev) => ({ ...prev, ...h }));
        if (Object.values(h).some((x) => x.status === "expired")) void run(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [result, q, run, pageSize]);

  /* ---- 接下一页：往下滚自动接；出错了停住等人点重试 ---- */
  const hasMore = variant === "page" && result !== null && shown < result.total;
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    // 换了关键词 / 重搜过：回来的这一页对不上号，丢掉
    const my = seq.current;
    const offset = shownRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const r = await api.library.search({ q, limit: pageSize, offset });
      if (my !== seq.current) return;
      // 一条都没回来：后面没有了，别原地打转
      const next = r.hits.length > 0 ? offset + r.hits.length : Math.max(offset, r.total);
      shownRef.current = next;
      setShown(next);
      setResult((prev) => (prev ? { ...prev, hits: appendHits(prev.hits, r.hits), total: r.total } : prev));
    } catch (err) {
      if (my === seq.current) setMoreError(apiErrorMessage(err, "网络或服务出了问题"));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [q, pageSize]);

  // 浏览器没有 IntersectionObserver 的（很老的）退回按钮：那种情况下哨兵永远算「在附近」，自动接会一口气全拉完
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
    // result 在依赖里：一页接完以后哨兵还在附近（屏幕高、一页没填满）就接着接
    if (!auto || !nearEnd || !hasMore || loading || loadingMore || moreError) return;
    // nearEnd 是观察者上一回说的，刚接完一页时还没改口：现量一下，不然每次都多接一页
    if (tailEl.current && !isNearViewport(tailEl.current)) return;
    void loadMore();
  }, [auto, nearEnd, hasMore, loading, loadingMore, moreError, loadMore, result]);

  const toggleExpired = async () => {
    const next = !showExpired;
    setShowExpired(next);
    if (next && expiredHits === null) {
      try {
        setExpiredHits((await api.library.search({ q, limit: 50, expired: true })).expiredHits ?? []);
      } catch (err) {
        toast.error(apiErrorMessage(err, "加载失败"));
        setExpiredHits([]);
      }
    }
  };

  const onOpen = useCallback(
    async (hit: LibraryHit) => {
      setOpeningKey(hitKey(hit));
      try {
        const root = hit.nodeId === "0";
        const r = await share.load(hit.shareUrl, {
          openImmediately: true,
          startCid: root ? undefined : hit.nodeId,
          startCrumbs: root ? undefined : hit.crumbs,
          failMessage: "打开分享失败",
        });
        // 打不开：后端已经顺带记了这个分享的死活，重新搜一遍就能看到
        if (!r.ok && !r.superseded) void run(true);
      } finally {
        setOpeningKey(null);
      }
    },
    [share, run],
  );

  const onFindAlt = useCallback(
    (hit: LibraryHit) => {
      const kw = hit.keyword || hit.name;
      router.push(`/search?q=${encodeURIComponent(kw)}`);
    },
    [router],
  );
  const canFindAlt = (hit: LibraryHit) => variant === "page" || sameWords(hit.keyword || hit.name) !== sameWords(q);

  const onSave = useCallback((hit: LibraryHit) => setSaving(hit), []);

  const confirmSave = async (choice: SaveToTaskChoice) => {
    const hit = saving;
    if (!hit) return;
    setSaving(null);
    const id = toast.loading(`正在转存「${hit.name}」…`);
    try {
      const result = await api.share.receive({
        url: hit.shareUrl,
        // 夸克的 token 是抄目录那次会话的，早过期了：带上所在目录，后端转存时重新列一遍换新的
        items: [{ id: hit.nodeId, name: hit.name, isDir: true, parentId: hit.parentId || "0", ...(hit.token ? { token: hit.token } : {}) }],
        taskId: choice.taskId,
        subPath: choice.subPath,
        mode: choice.mode,
        ...(choice.organize ? { organize: true } : {}),
        ...(choice.copy ? { copy: true } : {}),
        ...(choice.follow ? { follow: choice.follow, watchDirId: hit.nodeId, watchPath: hit.path, name: hit.keyword || hit.name } : {}),
      });
      toast.dismiss(id);
      notifySaveToTaskResult(result, router);
      notifyFollowResult(choice, result);
    } catch (err) {
      toast.dismiss(id);
      toast.error(apiErrorMessage(err, "转存失败"));
      void run(true);
    }
  };

  const healthOf = (h: LibraryHit) => health[h.shareCode] ?? h.health;
  const visible = useMemo(
    () => (result?.hits ?? []).filter((h) => (health[h.shareCode]?.status ?? h.health.status) !== "expired"),
    [result, health],
  );

  if (!q) return null;
  if (variant === "embedded" && !loading && !error && visible.length === 0 && !(result?.expired ?? 0)) return null;

  const header =
    variant === "embedded" ? (
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="flex items-center gap-2 text-sm font-medium whitespace-nowrap">
            <Bookmark className="size-4 text-brand" />
            收藏夹
            {result && <span className="text-xs font-normal text-muted-foreground tabular-nums">{result.total} 条</span>}
          </span>
          {(result?.indexing ?? 0) > 0 && <span className="text-xs text-muted-foreground">还有分享在建索引，结果可能不全</span>}
        </div>
        {result && result.total > 0 && (
          <Link href={`/library?q=${encodeURIComponent(q)}`} className="text-xs whitespace-nowrap text-muted-foreground hover:text-foreground">
            在收藏夹里看全部 →
          </Link>
        )}
      </div>
    ) : (result?.indexing ?? 0) > 0 ? (
      <div className="border-b px-4 py-2 text-xs text-muted-foreground">还有 {result!.indexing} 个分享在建索引，结果可能不全。</div>
    ) : null;

  return (
    <>
      <div className="overflow-hidden rounded-xl border bg-card">
        {header}
        {loading && !result ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            在收藏夹里找…
          </div>
        ) : error ? (
          <div className="px-4 py-6 text-sm text-destructive">{error}</div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            {(result?.expired ?? 0) > 0 ? `能转存的分享里没有和「${q}」对得上的，只有下面已失效的。` : `收藏夹里没有和「${q}」对得上的。`}
            换个写法（英文名、简称）再试。
          </div>
        ) : (
          <div className="divide-y">
            {visible.map((hit) => (
              <LibraryHitRow
                key={hitKey(hit)}
                hit={hit}
                keyword={q}
                health={healthOf(hit)}
                opening={openingKey === hitKey(hit)}
                onOpen={(h) => void onOpen(h)}
                onSave={onSave}
                onFindAlt={onFindAlt}
                canFindAlt={canFindAlt(hit)}
              />
            ))}
          </div>
        )}
        {hasMore && result ? (
          moreError ? (
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t px-4 py-2.5 text-xs text-destructive" role="alert">
              <span>后面的没加载出来：{moreError}</span>
              <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                重试
              </Button>
            </div>
          ) : auto ? (
            // 哨兵：这一行进到视口附近就接下一页
            <div ref={tailRef} className="flex items-center justify-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" />
              正在加载后面的 {result.total - shown} 条…
            </div>
          ) : (
            <div className="border-t px-4 py-2.5 text-center">
              <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore && <Loader2 className="animate-spin" />}
                再加载 {Math.min(pageSize, result.total - shown)} 条（共 {result.total} 条）
              </Button>
            </div>
          )
        ) : (
          // 一页就装下的不用说；往下接过页的，到底了说一声
          variant === "page" && result && shown > pageSize && (
            <div className="border-t px-4 py-2.5 text-center text-xs text-muted-foreground tabular-nums">共 {result.total} 条，都在这儿了</div>
          )
        )}
        {variant === "embedded" && result && result.total > visible.length && visible.length > 0 && (
          <div className="border-t px-4 py-2 text-right">
            <Link href={`/library?q=${encodeURIComponent(q)}`} className="text-xs text-muted-foreground hover:text-foreground">
              还有 {result.total - visible.length} 条，在收藏夹里看 →
            </Link>
          </div>
        )}
        {(result?.expired ?? 0) > 0 && (
          <div className="border-t">
            <div className="flex items-center justify-between gap-2 px-4 py-2">
              <button type="button" onClick={() => void toggleExpired()} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                {showExpired ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                已失效的分享里还有 {result!.expired} 条（转存不了）
              </button>
              <Link href="/library?view=expired" className="text-xs text-muted-foreground hover:text-foreground">
                去收藏夹清理 →
              </Link>
            </div>
            {showExpired && (
              <div className="divide-y border-t">
                {expiredHits === null ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    加载中…
                  </div>
                ) : (
                  expiredHits.map((hit) => (
                    <LibraryHitRow
                      key={`x:${hit.sourceId}:${hit.nodeId}`}
                      hit={hit}
                      keyword={q}
                      health={hit.health}
                      expired
                      opening={false}
                      onOpen={() => {}}
                      onSave={() => {}}
                      onFindAlt={onFindAlt}
                      canFindAlt={canFindAlt(hit)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <ShareDetailDialog {...share.dialogProps} />
      <SaveToDriveDialog
        open={saving != null}
        onOpenChange={(open) => !open && setSaving(null)}
        onConfirm={(choice) => void confirmSave(choice)}
        selectedCount={1}
        kind={saving?.shareKind}
        followHint={saving ? `之后定期检查「${saving.name}」里新增的文件，自动转存到同一位置并生成 strm。` : undefined}
      />
    </>
  );
}
