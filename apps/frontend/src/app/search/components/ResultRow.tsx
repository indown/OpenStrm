"use client";

import { memo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { CloudDownload, Copy, Download, ExternalLink, KeyRound, Loader2, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { ResourceHit } from "@openstrm/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/status-badge";
import { MediaFlags } from "@/components/media-flags";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LinkCheckState } from "@/hooks/use-link-check";
import { copyToClipboard } from "@/lib/clipboard";
import { flagsFromTags } from "@/lib/media-flags";
import { LINK_STATE, displayTags, fmtAgo, sourceLabel } from "@/lib/resource";
import { cn } from "@/lib/utils";

/** 一行最多挂几个标签：再多就挤了，全的在悬停提示里 */
const TAGS_SHOWN = 6;

interface ResultRowProps {
  hit: ResourceHit;
  /** 标题里要加粗的词（搜索的关键词，按空格拆开；选了 TMDB 候选时连年份一起） */
  keyword: string;
  /** 正在按它们筛的标签：行上的这几个标签跟着亮 */
  activeTags: ReadonlySet<string>;
  /** 磁力 / 电驴多选：有 115 账号的才给勾 */
  pickable: boolean;
  picked: boolean;
  onPickChange: (hit: ResourceHit, picked: boolean) => void;
  /** 有效性：没查是 undefined */
  state?: LinkCheckState;
  /** 这一条要不要查有效性（115 / 夸克的分享，且设置里开着） */
  checkable: boolean;
  observe: (hit: Pick<ResourceHit, "key" | "url" | "password">, el: Element | null) => void;
  /** 能云下载的 115 账号；多个时「云下载」先选账号 */
  offlineAccounts: string[];
  /** 这一条的分享正在打开 */
  opening: boolean;
  onShare: (hit: ResourceHit) => void;
  /** account 是 undefined：账号列表没读到，交给页面去办（它会转到云下载页） */
  onOffline: (hit: ResourceHit, account: string | undefined) => void;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 标题里的关键词加粗。标题是第三方写的：只当纯文本拼，不走 HTML */
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

async function copyText(text: string, what: string) {
  if (await copyToClipboard(text)) toast.success(`${what}已复制`);
  else toast.error("复制失败");
}

/**
 * 从下拉菜单里打开弹框要等菜单先关掉：菜单和弹框用的是两份 Radix 遮罩层代码，菜单还没关时打开弹框，
 * 弹框会把菜单给 body 加的 pointer-events: none 当成原样记下、关框时写回去，整页就再也点不动了
 */
const afterMenuClosed = (fn: () => void) => setTimeout(fn, 0);

const NO_ACCOUNT: Record<string, string> = {
  "115": "还没有 115 账号：到「账户」页添加一个才能转存",
  quark: "还没有夸克账号：到「账户」页添加一个才能转存",
  magnet: "还没有 115 账号：云下载要用 115",
  ed2k: "还没有 115 账号：云下载要用 115",
};

/**
 * 搜索结果的一行：标题、时间、来源、提取码、有效性，右边一个主按钮（转存 / 云下载 / 复制链接）加 ⋯ 菜单。
 * 115 / 夸克的分享挂上 observe：露出来才去查有效性。
 * memo 住：输入框每打一个字页面都重渲染，列表「显示更多」几次之后有上百行，每行还带着下拉菜单
 */
export const ResultRow = memo(function ResultRow({
  hit,
  keyword,
  activeTags,
  pickable,
  picked,
  onPickChange,
  state,
  checkable,
  observe,
  offlineAccounts,
  opening,
  onShare,
  onOffline,
}: ResultRowProps) {
  // 跟着提取码走：后面几轮给这个分享补上了提取码，要按新的重新查
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (checkable) observe({ key: hit.key, url: hit.url, password: hit.password }, el);
    },
    [checkable, observe, hit.key, hit.url, hit.password],
  );
  const dead = state === "bad";
  const isShare = hit.kind === "115" || hit.kind === "quark";
  const isOffline = hit.kind === "magnet" || hit.kind === "ed2k";
  const ago = fmtAgo(hit.publishedAt);
  const source = sourceLabel(hit.source);
  const dot = state ?? (checkable ? undefined : null);
  const isWeb = /^https?:\/\//i.test(hit.url);
  const tags = displayTags(hit.tags, activeTags);
  const router = useRouter();
  /**
   * 没有账号接得住的：按钮照样能点，点了说为什么。禁用的按钮碰不到悬停提示（样式里带着 pointer-events-none），
   * 手机上也没有悬停
   */
  const noAccount = () => toast.error(NO_ACCOUNT[hit.kind], { action: { label: "去添加", onClick: () => router.push("/account") } });

  let primary: React.ReactNode;
  if (isShare) {
    primary = (
      <Button
        size="sm"
        onClick={() => (hit.action ? onShare(hit) : noAccount())}
        disabled={opening}
        title={hit.action ? undefined : NO_ACCOUNT[hit.kind]}
        className={cn(!hit.action && "opacity-60")}
      >
        {opening ? <Loader2 className="animate-spin" /> : <Download />}
        转存
      </Button>
    );
  } else if (isOffline && offlineAccounts.length > 1 && hit.action) {
    primary = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            <CloudDownload />
            云下载
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs text-muted-foreground">用哪个 115 账号</DropdownMenuLabel>
          {offlineAccounts.map((name) => (
            <DropdownMenuItem key={name} onSelect={() => afterMenuClosed(() => onOffline(hit, name))}>
              {name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  } else if (isOffline) {
    primary = (
      <Button
        size="sm"
        onClick={() => (hit.action ? onOffline(hit, offlineAccounts[0]) : noAccount())}
        title={hit.action ? undefined : NO_ACCOUNT[hit.kind]}
        className={cn(!hit.action && "opacity-60")}
      >
        <CloudDownload />
        云下载
      </Button>
    );
  } else {
    primary = (
      <Button size="sm" variant="outline" onClick={() => void copyText(hit.url, "链接")}>
        <Copy />
        复制链接
      </Button>
    );
  }

  return (
    <div
      ref={ref}
      className={cn("flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4", dead && "opacity-60")}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start gap-2">
          {pickable && (
            <Checkbox
              className="mt-0.5"
              checked={picked}
              onCheckedChange={(v) => onPickChange(hit, v === true)}
              aria-label={`选中「${(hit.title || hit.url).slice(0, 60)}」`}
            />
          )}
          {dot !== null && (
            <span
              role="img"
              className={cn("mt-1.5 size-2 shrink-0 rounded-full", dot ? LINK_STATE[dot].dot : "bg-muted-foreground/30")}
              title={dot ? LINK_STATE[dot].label : "还没检测"}
              aria-label={dot ? LINK_STATE[dot].label : "还没检测"}
            />
          )}
          {hit.kind === "other" && (
            <Badge variant="outline" className="shrink-0 text-xs">
              {hit.panLabel}
            </Badge>
          )}
          <p className="line-clamp-2 min-w-0 text-sm leading-snug font-medium [overflow-wrap:anywhere]" title={hit.title || hit.url}>
            {highlight(hit.title || hit.url, keyword)}
          </p>
        </div>
        {/* 最小高度按带徽标的那种算：检测结果回来加上「已失效」时行不会被撑高、列表不跳 */}
        <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {ago && <span title={hit.publishedAt ? new Date(hit.publishedAt).toLocaleString("zh-CN", { hour12: false }) : undefined}>{ago}</span>}
          {source && <span className="max-w-[16rem] truncate">{source}</span>}
          {hit.password && (
            <span>
              提取码 <span className="font-mono text-foreground">{hit.password}</span>
            </span>
          )}
          {tags.length > 0 && <MediaFlags flags={flagsFromTags(tags, activeTags)} max={TAGS_SHOWN} title={tags.join(" · ")} />}
          {hit.followed === "active" && (
            <StatusBadge tone="info" title="这个分享已经在追更了：再转存会多存一份，也不用再订追更">
              已在追更
            </StatusBadge>
          )}
          {hit.followed === "stopped" && (
            <StatusBadge tone="neutral" title="订过这个分享的追更，现在停着（分享失效、长期没更新或暂停了）：要接着追到追更页点「继续」，别再订一个">
              追更已停
            </StatusBadge>
          )}
          {dead && <StatusBadge tone="danger">已失效</StatusBadge>}
          {state === "locked" && <StatusBadge tone="warning">提取码不对或缺</StatusBadge>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
        {primary}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="更多操作">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void copyText(hit.url, "链接")}>
              <Copy />
              复制链接
            </DropdownMenuItem>
            {hit.password && (
              <DropdownMenuItem onSelect={() => void copyText(hit.password!, "提取码")}>
                <KeyRound />
                复制提取码
              </DropdownMenuItem>
            )}
            {isWeb && (
              <DropdownMenuItem asChild>
                <a href={hit.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  在网盘网页打开
                </a>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});
