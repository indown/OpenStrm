"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { MediaFlags } from "@/components/media-flags";
import { flagsFromHdhive } from "@/lib/media-flags";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Film,
  Tv,
  Lock,
  CheckCircle2,
  Unlock,
  Copy,
  ExternalLink,
  ArrowRightCircle,
} from "lucide-react";
import { api, type HdhiveResourceItem, type HdhiveTmdbItem, type HdhiveUnlockResult } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "sonner";

export type { HdhiveTmdbItem, HdhiveResourceItem, HdhiveUnlockResult } from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  query: string;
  tmdb: HdhiveTmdbItem | null;
  alternatives: HdhiveTmdbItem[];
  resources: HdhiveResourceItem[];
  total: number;
  errorMessage?: string | null;
  onPickAlternative: (item: HdhiveTmdbItem) => void;
  onPan115Unlocked?: (fullUrl: string, res: HdhiveResourceItem) => void;
}

function MediaTypeBadge({ type }: { type: "movie" | "tv" }) {
  const Icon = type === "movie" ? Film : Tv;
  return (
    <Badge variant="outline" className="gap-1 text-xs">
      <Icon className="h-3 w-3" />
      {type === "movie" ? "电影" : "剧集"}
    </Badge>
  );
}

const UNKNOWN_PAN_TYPE = "其他";
const ALL_TAB = "__all__";

function panTypeOf(resource: HdhiveResourceItem): string {
  const raw = (resource.pan_type ?? "").toString().trim();
  return raw || UNKNOWN_PAN_TYPE;
}

/** 这种网盘的分享能不能在本站打开：115 和夸克都接了分享转存 */
function is115(panType: string | null | undefined): boolean {
  if (!panType) return false;
  return /115|夸克|quark/i.test(panType);
}

async function copyText(text: string) {
  if (await copyToClipboard(text)) toast.success("已复制");
  else toast.error("复制失败");
}

interface ResourceCardProps {
  res: HdhiveResourceItem;
  unlocking: boolean;
  unlockResult: HdhiveUnlockResult | null;
  onUnlock: () => void;
  onOpenIn115?: (fullUrl: string) => void;
}

function ResourceCard({
  res,
  unlocking,
  unlockResult,
  onUnlock,
  onOpenIn115,
}: ResourceCardProps) {
  const remark = (res.remark ?? "").toString().trim();
  const pan115 = is115(res.pan_type);
  const hasUrl = Boolean(unlockResult?.full_url || unlockResult?.url);
  const fullUrl = unlockResult?.full_url || unlockResult?.url || "";

  return (
    <div className="break-inside-avoid mb-3 border rounded-md p-3 flex flex-col gap-1.5 bg-card hover:bg-muted/40 transition-colors">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-sm break-words">
          {res.title || "资源"}
        </span>
        {res.share_size && (
          <Badge variant="outline" className="text-xs">{res.share_size}</Badge>
        )}
        {res.is_unlocked || unlockResult?.already_owned ? (
          <StatusBadge tone="success">
            <CheckCircle2 />
            已解锁
          </StatusBadge>
        ) : res.unlock_points != null && res.unlock_points > 0 ? (
          <Badge variant="outline" className="text-xs gap-1">
            <Lock className="h-3 w-3" />
            {res.unlock_points} 积分
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs">免费</Badge>
        )}
      </div>
      {remark && (
        <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {remark}
        </div>
      )}
      <MediaFlags flags={flagsFromHdhive(res)} className="flex" />

      {hasUrl ? (
        <div className="mt-1 rounded border bg-muted/40 p-2 flex flex-col gap-1 text-xs">
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground shrink-0">链接</span>
            <span className="font-mono truncate flex-1" title={fullUrl}>{fullUrl}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={() => copyText(fullUrl)}
              title="复制完整链接"
            >
              <Copy className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={() => window.open(fullUrl, "_blank", "noopener,noreferrer")}
              title="在新标签打开"
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
          {unlockResult?.access_code && (
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground shrink-0">访问码</span>
              <span className="font-mono">{unlockResult.access_code}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                onClick={() => copyText(unlockResult.access_code)}
                title="复制访问码"
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          )}
          {pan115 && onOpenIn115 && (
            <div className="pt-1">
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-xs gap-1"
                onClick={() => onOpenIn115(fullUrl)}
              >
                <ArrowRightCircle className="h-3 w-3" />
                查看分享
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="pt-1">
          <Button
            size="sm"
            variant="default"
            className="h-7 text-xs gap-1"
            onClick={onUnlock}
            disabled={unlocking}
          >
            {unlocking ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                解锁中...
              </>
            ) : (
              <>
                <Unlock className="h-3 w-3" />
                {res.is_unlocked
                  ? "查看链接"
                  : res.unlock_points && res.unlock_points > 0
                  ? `解锁 (${res.unlock_points} 积分)`
                  : "解锁"}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

export function HdhiveSearchDialog({
  open,
  onOpenChange,
  loading,
  query,
  tmdb,
  alternatives,
  resources,
  total,
  errorMessage,
  onPickAlternative,
  onPan115Unlocked,
}: Props) {
  const panTypes = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const r of resources) {
      const k = panTypeOf(r);
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
    return order;
  }, [resources]);

  const countByPanType = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of resources) {
      const k = panTypeOf(r);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [resources]);

  const showAllTab = panTypes.length > 1;
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB);

  useEffect(() => {
    if (resources.length === 0) {
      setActiveTab(ALL_TAB);
      return;
    }
    setActiveTab((prev) => {
      if (prev === ALL_TAB) {
        return showAllTab ? ALL_TAB : panTypes[0] ?? ALL_TAB;
      }
      return panTypes.includes(prev) ? prev : showAllTab ? ALL_TAB : panTypes[0] ?? ALL_TAB;
    });
  }, [resources, panTypes, showAllTab]);

  const [unlockingSlugs, setUnlockingSlugs] = useState<Set<string>>(new Set());
  const [unlockResults, setUnlockResults] = useState<Map<string, HdhiveUnlockResult>>(new Map());

  useEffect(() => {
    setUnlockingSlugs(new Set());
    setUnlockResults(new Map());
  }, [resources]);

  const filteredResources = useMemo(() => {
    if (activeTab === ALL_TAB) return resources;
    return resources.filter((r) => panTypeOf(r) === activeTab);
  }, [resources, activeTab]);

  const handleUnlock = async (res: HdhiveResourceItem) => {
    if (unlockingSlugs.has(res.slug)) return;
    setUnlockingSlugs((prev) => {
      const next = new Set(prev);
      next.add(res.slug);
      return next;
    });
    try {
      const result = await api.hdhive.unlock(res.slug);
      setUnlockResults((prev) => {
        const next = new Map(prev);
        next.set(res.slug, result);
        return next;
      });
      if (result.already_owned) {
        toast.success("已解锁，已为你拉取链接");
      } else {
        toast.success("解锁成功");
      }
      const fullUrl = result.full_url || result.url;
      if (is115(res.pan_type) && fullUrl && onPan115Unlocked) {
        onPan115Unlocked(fullUrl, res);
      }
    } catch (err) {
      const msg = apiErrorMessage(err, (err as Error)?.message || "解锁失败");
      toast.error(msg);
    } finally {
      setUnlockingSlugs((prev) => {
        const next = new Set(prev);
        next.delete(res.slug);
        return next;
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] overflow-y-auto lg:max-w-[1100px]">
        <DialogHeader>
          <DialogTitle>HDHive 资源搜索</DialogTitle>
          <DialogDescription>
            通过关键词「{query || "—"}」查询 TMDB ID，再在 HDHive 查找网盘资源。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            搜索中...
          </div>
        ) : errorMessage ? (
          <div className="text-sm text-destructive py-4">{errorMessage}</div>
        ) : !tmdb ? (
          <div className="text-sm text-muted-foreground py-6">
            没有找到匹配的 TMDB 影视。可以换一个关键词，或者补充年份/原名再试。
          </div>
        ) : (
          <div className="space-y-4">
            <section className="flex gap-3 items-start border rounded-md p-3 bg-muted/30">
              <div className="relative w-20 h-28 flex-shrink-0 bg-muted rounded overflow-hidden">
                {tmdb.posterUrl ? (
                  <Image
                    src={tmdb.posterUrl}
                    alt={tmdb.title}
                    fill
                    sizes="80px"
                    unoptimized
                    className="object-cover"
                  />
                ) : (
                  <div className="flex items-center justify-center w-full h-full text-muted-foreground">
                    <Film className="h-6 w-6" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{tmdb.title || `TMDB #${tmdb.id}`}</span>
                  {tmdb.year && <Badge variant="secondary">{tmdb.year}</Badge>}
                  <MediaTypeBadge type={tmdb.mediaType} />
                  <Badge variant="outline" className="text-xs">TMDB {tmdb.id}</Badge>
                </div>
                {tmdb.overview && (
                  <p className="text-xs text-muted-foreground line-clamp-3">{tmdb.overview}</p>
                )}
              </div>
            </section>

            {alternatives.length > 0 && (
              <section>
                <div className="text-xs text-muted-foreground mb-1">其他可能的 TMDB 匹配</div>
                <div className="flex flex-wrap gap-2">
                  {alternatives.slice(0, 8).map((item) => (
                    <Button
                      key={`${item.mediaType}-${item.id}`}
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => onPickAlternative(item)}
                      title={item.overview || item.title}
                    >
                      {item.title || `#${item.id}`}
                      {item.year && <span className="ml-1 text-muted-foreground">({item.year})</span>}
                      <span className="ml-1 opacity-60">{item.mediaType === "movie" ? "电影" : "剧集"}</span>
                    </Button>
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium">HDHive 资源</h3>
                <span className="text-xs text-muted-foreground">共 {total} 条</span>
              </div>

              {resources.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center border rounded-md">
                  HDHive 暂无该影视的可用资源。
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-1 border-b">
                    {showAllTab && (
                      <TabButton
                        active={activeTab === ALL_TAB}
                        onClick={() => setActiveTab(ALL_TAB)}
                        label="全部"
                        count={resources.length}
                      />
                    )}
                    {panTypes.map((pt) => (
                      <TabButton
                        key={pt}
                        active={activeTab === pt}
                        onClick={() => setActiveTab(pt)}
                        label={pt}
                        count={countByPanType.get(pt) ?? 0}
                      />
                    ))}
                  </div>

                  {filteredResources.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-6 text-center border rounded-md">
                      当前分类下暂无资源。
                    </div>
                  ) : (
                    <div className="columns-1 sm:columns-2 lg:columns-3 gap-3">
                      {filteredResources.map((res) => (
                        <ResourceCard
                          key={res.slug}
                          res={res}
                          unlocking={unlockingSlugs.has(res.slug)}
                          unlockResult={unlockResults.get(res.slug) ?? null}
                          onUnlock={() => handleUnlock(res)}
                          onOpenIn115={
                            onPan115Unlocked
                              ? (fullUrl) => onPan115Unlocked(fullUrl, res)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "relative -mb-px px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 " +
        (active
          ? "text-foreground border-b-2 border-foreground"
          : "text-muted-foreground hover:text-foreground border-b-2 border-transparent")
      }
    >
      {label}
      <span
        className={
          "rounded px-1.5 py-0.5 text-xs " +
          (active ? "bg-foreground text-background" : "bg-muted text-muted-foreground")
        }
      >
        {count}
      </span>
    </button>
  );
}
