"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AlertTriangle, CheckCheck, ChevronDown, ChevronRight, ExternalLink, Film, Loader2, MoreHorizontal, PenLine, RefreshCw, ScanSearch, Search, SlidersHorizontal, Telescope, Tv } from "lucide-react";
import type { MediaProbeTags, OrganizeConflictChoice, OrganizeEpisodePin, OrganizeItem, OrganizeKindOverride, OrganizeNaming, OrganizeRunStage, OrganizeUnit, OrganizeUnitCounts, OrganizeUnitPatch } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/status-badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ACTION_META, CONFIDENCE_META, CONFLICT_CHOICES, CONFLICT_LABEL, ERROR_KIND_META, baseName, dirName } from "@/lib/organize";
import { keywordFromName, searchHref } from "@/lib/resource";
import { useRunItems } from "./helpers";

const NO_COUNTS: OrganizeUnitCounts = { total: 0, changing: 0, conflicts: 0, skipped: 0, keep: 0, failed: 0, done: 0, reverted: 0, excluded: 0 };

type UnitFilter = "all" | "attention" | "changing" | "noop";

const FILTERS: Array<{ key: UnitFilter; label: string; hint: string }> = [
  { key: "all", label: "全部", hint: "" },
  { key: "attention", label: "要处理", hint: "没识别、把握不大、有冲突、有失败或跳过里有问题的" },
  { key: "changing", label: "要动的", hint: "有文件要改名 / 移动的" },
  { key: "noop", label: "已规范", hint: "已经是规范命名，没什么要动的" },
];

interface Row {
  unit: OrganizeUnit;
  counts: OrganizeUnitCounts;
  attention: boolean;
  changing: boolean;
  noop: boolean;
}

/**
 * 单元在列表里算哪一类：要处理（没识别 / 待执行时把握不大 / 冲突 / 失败 / 跳过里有问题）、要动的、已规范（只有不变的项）。
 * local：按本地 strm 结构的清单，单元没有识别这一步，「没识别」不算要处理
 */
function rowOf(unit: OrganizeUnit, counts: OrganizeUnitCounts, ready: boolean, local: boolean): Row {
  const m = unit.match;
  const attention = (!m && !local) || (ready && !!m && m.confidence !== "high") || counts.conflicts > 0 || counts.failed > 0 || counts.skipped > 0;
  const changing = counts.changing > 0;
  const noop = (!!m || local) && unit.selected && !changing && counts.conflicts === 0 && counts.failed === 0 && counts.skipped === 0 && counts.excluded === 0;
  return { unit, counts, attention, changing, noop };
}

const rank = (r: Row) => (r.attention ? 0 : r.changing ? 1 : 2);

/**
 * 单元列表：工具条（筛选 / 按名字找 / 排序 / 批量勾选）+ 一部作品一张卡 + 不属于任何作品的目录操作。
 * 「全部」里已经规范的作品收成一行；文件清单展开时才拉；冲突的行上有「怎么办」下拉（改名保留 / 自己改名 /
 * 挪进重复文件 / 删掉 / 覆盖）
 */
export function UnitList({
  runId,
  units,
  counts,
  dirCount,
  stage,
  version,
  ready,
  editable,
  naming,
  patching,
  busy,
  onPatch,
  onBulk,
  onOnlyHigh,
  onToggleItems,
  onResolve,
  onMatch,
  onAdjust,
  onRefresh,
  onProbe,
  onProbeMissing,
  onTitle,
  onFileEdit,
}: {
  runId: string;
  units: OrganizeUnit[];
  counts: Record<string, OrganizeUnitCounts>;
  dirCount: number;
  stage: OrganizeRunStage;
  /** 详情刷新的次数：展开着的清单跟着重拉 */
  version: number;
  /** 待执行：把握不大的也算要处理 */
  ready: boolean;
  editable: boolean;
  /** 命名来源：local 的单元没有 TMDB 匹配，照样能勾选 / 执行 */
  naming: OrganizeNaming;
  /** 修改还在保存的单元 */
  patching: ReadonlySet<string>;
  /** 有修改在保存：批量按钮先禁用 */
  busy: boolean;
  onPatch: (unit: OrganizeUnit, patch: OrganizeUnitPatch) => void;
  onBulk: (keys: string[], selected: boolean) => void;
  onOnlyHigh: (units: OrganizeUnit[]) => void;
  onToggleItems: (unit: OrganizeUnit, ids: string[], selected: boolean) => void;
  /** 冲突行上选了办法（"stay" 是撤回选择，"custom" 由调用方弹框问名字） */
  onResolve: (unit: OrganizeUnit, item: OrganizeItem, how: OrganizeConflictChoice | "stay") => void;
  onMatch: (unit: OrganizeUnit) => void;
  onAdjust: (unit: OrganizeUnit) => void;
  /** 刷新这部的 TMDB 信息（跳过缓存重新拉详情和季集） */
  onRefresh: (unit: OrganizeUnit) => void;
  /** 探测这部全部视频的编码（读文件头），填进文件名里缺的标签 */
  onProbe: (unit: OrganizeUnit) => void;
  /** 探测这些单元里文件名缺模板标签的视频 */
  onProbeMissing: (keys: string[]) => void;
  /** 改这部的标题 / 年份（只影响命名） */
  onTitle: (unit: OrganizeUnit) => void;
  /** 文件行「…」里选的：钉季 / 集、改文件名、撤掉 */
  onFileEdit: (unit: OrganizeUnit, item: OrganizeItem, what: FileEdit) => void;
}) {
  const [filter, setFilter] = useState<UnitFilter>("all");
  const [query, setQuery] = useState("");
  const [byPath, setByPath] = useState(false);
  const [showNoop, setShowNoop] = useState(false);
  const local = naming === "local";
  const rows = useMemo(() => units.map((u) => rowOf(u, counts[u.key] ?? NO_COUNTS, ready, local)), [units, counts, ready, local]);
  const tally: Record<UnitFilter, number> = {
    all: rows.length,
    attention: rows.filter((r) => r.attention).length,
    changing: rows.filter((r) => r.changing).length,
    noop: rows.filter((r) => r.noop).length,
  };
  const q = query.trim().toLowerCase();
  const hit = (u: OrganizeUnit) => !q || [u.match?.title, u.match?.originalTitle, u.rawName, u.parsedTitle, u.rootPath, u.dstRoot].some((s) => !!s && s.toLowerCase().includes(q));
  const listed = rows.filter((r) => (filter === "all" || r[filter]) && hit(r.unit));
  const ordered = byPath ? listed : [...listed].sort((a, b) => rank(a) - rank(b));
  // 「全部」里已经规范的收成一行（按名字找的时候不收）
  const collapse = filter === "all" && !q && !showNoop;
  const folded = collapse ? ordered.filter((r) => r.noop) : [];
  const shown = collapse ? ordered.filter((r) => !r.noop) : ordered;
  // 批量勾选只对列出的、识别出来的单元（没识别的不能勾）
  const matched = listed.filter((r) => r.unit.match || local);

  return (
    <div className="space-y-3">
      {units.length > 1 && (
        <div className="space-y-2 rounded-xl border bg-card px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-1 text-xs">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  title={f.hint || undefined}
                  onClick={() => setFilter(f.key)}
                  className={`rounded px-2 py-1 tabular-nums ${filter === f.key ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {f.label} {tally[f.key]}
                </button>
              ))}
            </div>
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setByPath((v) => !v)} title="切换排序">
              {byPath ? "按路径排" : "要处理的在前"}
            </button>
            <div className="relative w-full sm:ml-auto sm:w-52">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="按片名或目录找" className="h-8 pl-7 text-xs" />
            </div>
          </div>
          {editable && matched.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 border-t pt-2 text-xs">
              <span className="mr-1 text-muted-foreground">对列出的 {matched.length} 部：</span>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onBulk(matched.map((r) => r.unit.key), true)}>
                全选
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onBulk(matched.map((r) => r.unit.key), false)}>
                全不选
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onOnlyHigh(matched.map((r) => r.unit))}>
                只选把握大的
              </Button>
              {!local && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={busy}
                  onClick={() => onProbeMissing(matched.filter((r) => r.unit.selected).map((r) => r.unit.key))}
                  title="勾着的作品里，文件名缺模板要用的分辨率 / 编码 / 音频 / HDR 标签的视频：读几 MB 文件头补上（读过的有缓存；上次没读到的不再读，按作品点「探测编码」才重试）"
                >
                  探测缺标签的视频
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {shown.map((r) => (
        <UnitCard
          key={r.unit.key}
          runId={runId}
          unit={r.unit}
          counts={r.counts}
          stage={stage}
          version={version}
          editable={editable}
          local={local}
          pending={patching.has(r.unit.key)}
          onToggle={(selected) => onPatch(r.unit, { selected })}
          onRemember={(remember) => onPatch(r.unit, { remember })}
          onToggleItems={(ids, selected) => onToggleItems(r.unit, ids, selected)}
          onResolve={(item, how) => onResolve(r.unit, item, how)}
          onMatch={() => onMatch(r.unit)}
          onAdjust={() => onAdjust(r.unit)}
          onRefresh={() => onRefresh(r.unit)}
          onProbe={() => onProbe(r.unit)}
          onTitle={() => onTitle(r.unit)}
          onFileEdit={(item, what) => onFileEdit(r.unit, item, what)}
        />
      ))}
      {folded.length > 0 && (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-xl border border-dashed bg-card/60 px-4 py-3 text-left text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setShowNoop(true)}
        >
          <CheckCheck className="size-4 shrink-0 text-success" />
          <span className="min-w-0 flex-1">{folded.length} 部已经是规范命名，没什么要动</span>
          <span className="text-xs">展开</span>
        </button>
      )}
      {filter === "all" && showNoop && !q && tally.noop > 0 && (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowNoop(false)}>
          收起 {tally.noop} 部已规范的
        </button>
      )}
      {listed.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">没有符合的作品</p>}
      {dirCount > 0 && <DirItems runId={runId} count={dirCount} stage={stage} version={version} />}
    </div>
  );
}

/** 探测出来的标签一行：2160p HEVC DV DDP */
const probeLine = (p: MediaProbeTags): string => [p.resolution, p.videoCodec, p.hdr, p.audio].filter(Boolean).join(" ");

function UnitCard({
  runId,
  unit,
  counts,
  stage,
  version,
  editable,
  local,
  pending,
  onToggle,
  onRemember,
  onToggleItems,
  onResolve,
  onMatch,
  onAdjust,
  onRefresh,
  onProbe,
  onTitle,
  onFileEdit,
}: {
  runId: string;
  unit: OrganizeUnit;
  counts: OrganizeUnitCounts;
  stage: OrganizeRunStage;
  version: number;
  editable: boolean;
  /** 按本地 strm 结构的清单：没有识别，换匹配 / 季集 / 刷新 / 记住都不给 */
  local: boolean;
  /** 这个单元的修改还在保存 */
  pending: boolean;
  onToggle: (selected: boolean) => void;
  onRemember: (remember: boolean) => void;
  onToggleItems: (ids: string[], selected: boolean) => void;
  onResolve: (item: OrganizeItem, how: OrganizeConflictChoice | "stay") => void;
  onMatch: () => void;
  onAdjust: () => void;
  onRefresh: () => void;
  onProbe: () => void;
  onTitle: () => void;
  onFileEdit: (item: OrganizeItem, what: FileEdit) => void;
}) {
  const [open, setOpen] = useState(false);
  // 海报加载失败（TMDB 图片被墙）就退回图标，别把 alt 文字画在卡片上
  const [posterBroken, setPosterBroken] = useState(false);
  const m = unit.match;
  const conf = CONFIDENCE_META[m?.confidence ?? "none"];
  const tmdbUrl = m ? `https://www.themoviedb.org/${m.mediaType}/${m.tmdbId}` : "";
  // 找资源按认出来的片名搜（TMDB 上的中文名最好搜），没认出来就用从文件名里拆出来的
  const searchKeyword = keywordFromName(m?.title || unit.parsedTitle || unit.rawName);

  return (
    <div className={`rounded-xl border bg-card p-4 ${unit.selected ? "" : "opacity-60"}`}>
      <div className="flex gap-3">
        <div className="relative hidden h-24 w-16 shrink-0 overflow-hidden rounded-md bg-muted sm:block">
          {m?.posterUrl && !posterBroken ? (
            <Image src={m.posterUrl} alt="" fill className="object-cover" unoptimized onError={() => setPosterBroken(true)} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">{m?.mediaType === "tv" ? <Tv className="size-5" /> : <Film className="size-5" />}</div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {editable &&
              (pending ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="保存中" />
              ) : (
                <Checkbox checked={unit.selected} onCheckedChange={(v) => onToggle(v === true)} disabled={!m && !local} title={m || local ? "勾上才会执行" : "没识别出来的不能执行"} />
              ))}
            <span className="break-all text-sm font-medium">{m ? `${m.title}${m.year ? ` (${m.year})` : ""}` : local ? unit.rawName : unit.parsedTitle || unit.rawName}</span>
            {local ? (
              <StatusBadge tone="info" title="名字和位置照本地 strm 的目录结构来，不经过 TMDB 识别">
                按本地结构
              </StatusBadge>
            ) : (
              <StatusBadge tone={conf.tone} title={conf.hint}>
                {conf.label}
              </StatusBadge>
            )}
            {m && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                {m.mediaType === "tv" ? <Tv className="size-3" /> : <Film className="size-3" />}
                {m.mediaType === "tv" ? "剧集" : "电影"}
                <a href={tmdbUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-foreground">
                  #{m.tmdbId}
                  <ExternalLink className="size-3" />
                </a>
              </span>
            )}
          </div>
          <div className="break-all text-xs text-muted-foreground">
            原：{unit.rootPath || "（任务根目录）"}
            {!local && unit.rootPath && unit.rawName !== baseName(unit.rootPath) ? ` · ${unit.rawName}` : ""}
          </div>
          {unit.dstRoot && <div className="break-all text-xs text-muted-foreground">→ {unit.dstRoot}</div>}
          {m && <div className="text-xs text-muted-foreground">{m.reason}</div>}
          {unit.notes.map((n, i) => (
            <div key={i} className="flex items-start gap-1 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span className="break-all">{n}</span>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <span>
              {unit.fileCount} 个文件（{unit.videoCount} 个视频）
            </span>
            {counts.changing > 0 && <span className="text-brand">{counts.changing} 项要动</span>}
            {counts.conflicts > 0 && <span className="text-destructive">{counts.conflicts} 项冲突</span>}
            {counts.failed > 0 && <span className="text-destructive">{counts.failed} 项{stage === "revert" ? "没退回" : "要处理"}</span>}
            {counts.excluded > 0 && <span>{counts.excluded} 个文件没勾选</span>}
            {unit.referencedBy > 0 && <span>被 {unit.referencedBy} 条追更 / 云下载引用，执行后自动改写</span>}
            {unit.titleOverride && <span className="break-all">标题 → {unit.titleOverride}</span>}
            {unit.yearOverride && <span>年份 → {unit.yearOverride}</span>}
            {unit.seasonOverride != null && <span>季 → {unit.seasonOverride}</span>}
            {unit.episodeOffset !== 0 && <span>集偏移 {unit.episodeOffset > 0 ? `+${unit.episodeOffset}` : unit.episodeOffset}</span>}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        {editable && (
          <>
            {!local && (
              <Button variant="outline" size="sm" className="h-8" onClick={onMatch} disabled={pending}>
                <Search className="size-4" />
                换匹配
              </Button>
            )}
            {!local && m?.mediaType === "tv" && (
              <Button variant="outline" size="sm" className="h-8" onClick={onAdjust} disabled={pending}>
                <SlidersHorizontal className="size-4" />
                季 / 集偏移
              </Button>
            )}
            {m && !local && (
              <Button variant="outline" size="sm" className="h-8" onClick={onTitle} disabled={pending} title="只改目录和文件名里的标题 / 年份：从 TMDB 的译名、原名、别名里挑，或自己填；识别不变">
                <PenLine className="size-4" />
                改标题
              </Button>
            )}
            {m && !local && (
              <Button variant="outline" size="sm" className="h-8" onClick={onRefresh} disabled={pending} title="不换作品：跳过缓存重新拉这部的详情和季集，按新信息重新规划">
                <RefreshCw className="size-4" />
                刷新 TMDB
              </Button>
            )}
            {m && !local && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={onProbe}
                disabled={pending}
                title="读这部每个视频的文件头（几 MB，不下载整个文件）拿到真实的分辨率 / 编码 / 音频 / HDR，填进文件名里缺的标签并重新规划；读过的有缓存"
              >
                <ScanSearch className="size-4" />
                探测编码
              </Button>
            )}
            {m && !local && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={unit.remember} onCheckedChange={(v) => onRemember(v === true)} disabled={pending} />
                记住这个识别
              </label>
            )}
          </>
        )}
        {!local && searchKeyword && (
          <Button asChild variant="ghost" size="sm" className="h-8 text-muted-foreground">
            <Link href={searchHref(searchKeyword)} title={`到资源搜索页搜「${searchKeyword}」：缺集、想换个画质时用`}>
              <Telescope className="size-4" />
              找资源
            </Link>
          </Button>
        )}
        <button type="button" className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {open ? "收起" : "看文件"}（{counts.total}）
        </button>
      </div>
      {open && (
        <UnitFiles
          runId={runId}
          unit={unit}
          stage={stage}
          version={version}
          editable={editable && unit.selected && (!!m || local)}
          local={local}
          tv={m?.mediaType === "tv"}
          pending={pending}
          onToggleItems={onToggleItems}
          onResolve={onResolve}
          onFileEdit={onFileEdit}
        />
      )}
    </div>
  );
}

function FilesLoading() {
  return (
    <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      加载中…
    </p>
  );
}

/** 一个单元的文件清单：展开时才拉；待执行时每个文件能单独勾掉 */
function UnitFiles({
  runId,
  unit,
  stage,
  version,
  editable,
  local,
  tv,
  pending,
  onToggleItems,
  onResolve,
  onFileEdit,
}: {
  runId: string;
  unit: OrganizeUnit;
  stage: OrganizeRunStage;
  version: number;
  editable: boolean;
  /** 按本地 strm 结构的清单：能改文件名，不能钉季集 */
  local: boolean;
  /** 剧集：视频能钉季 / 集 */
  tv: boolean;
  pending: boolean;
  onToggleItems: (ids: string[], selected: boolean) => void;
  onResolve: (item: OrganizeItem, how: OrganizeConflictChoice | "stay") => void;
  onFileEdit: (item: OrganizeItem, what: FileEdit) => void;
}) {
  const { items, error } = useRunItems(runId, { unit: unit.key }, true, version);
  const excluded = useMemo(() => new Set(unit.excluded), [unit.excluded]);
  if (error) return <p className="mt-3 break-all text-xs text-destructive">{error}</p>;
  if (!items) return <FilesLoading />;
  return (
    <ItemsTable
      items={items}
      stage={stage}
      unitSelected={unit.selected}
      editable={editable}
      excluded={excluded}
      resolutions={unit.resolutions ?? {}}
      pins={unit.pins ?? {}}
      renames={unit.renames ?? {}}
      kinds={unit.kinds ?? {}}
      local={local}
      tv={tv}
      pending={pending}
      onToggleItems={onToggleItems}
      onResolve={onResolve}
      onFileEdit={onFileEdit}
    />
  );
}

/** 状态只描述文件在哪，类别说为什么：done 带 mirror 是网盘好了本地没跟上，撤销阶段 done 带别的类别是没退回 */
function ItemStatus({ it, stage }: { it: OrganizeItem; stage: OrganizeRunStage }) {
  const kind = it.errorKind ? ERROR_KIND_META[it.errorKind] : null;
  if (it.givenUp) return <StatusBadge tone="neutral" title={it.error}>{it.status === "done" ? (it.errorKind === "mirror" ? "完成，放弃补本地" : "已放弃撤销") : "已放弃"}</StatusBadge>;
  if (it.status === "done") {
    if (it.errorKind === "mirror") return <StatusBadge tone="warning" title={it.error}>完成，本地未同步</StatusBadge>;
    if (stage === "revert" && it.curPath) return <StatusBadge tone="warning" title={it.error || it.curPath}>已挪回，待改名</StatusBadge>;
    if (stage === "revert" && kind) return <StatusBadge tone="danger" title={it.error}>未退回 · {kind.label}</StatusBadge>;
    return <StatusBadge tone="success" title={it.error || undefined}>完成</StatusBadge>;
  }
  if (it.status === "failed") {
    if (stage === "revert" && it.errorKind === "stale") return <StatusBadge tone="danger" title={it.error}>没退回 · 已找不到</StatusBadge>;
    return <StatusBadge tone="danger" title={it.error}>失败{kind ? ` · ${kind.label}` : ""}</StatusBadge>;
  }
  if (it.curPath) return <StatusBadge tone="warning" title={it.error || it.curPath}>已改名，待移动</StatusBadge>;
  if (it.status === "reverted") {
    if (it.errorKind === "mirror") return <StatusBadge tone="warning" title={it.error}>已退回，本地未同步</StatusBadge>;
    return <StatusBadge tone="neutral" title={it.error || undefined}>已退回</StatusBadge>;
  }
  if (it.status === "skipped") return <StatusBadge tone="neutral" title={it.error}>跳过</StatusBadge>;
  const a = ACTION_META[it.action];
  return <StatusBadge tone={a.tone}>{a.label}</StatusBadge>;
}

/** 原因的颜色：冲突是问题（错误色），跳过要看一眼（警告色；单元没勾选、文件没勾选这种自己的选择是灰色），不动的只是说明（灰） */
function reasonClass(it: OrganizeItem, unitSelected: boolean, userExcluded: boolean): string {
  if (it.action === "conflict") return "text-destructive";
  if (it.action === "skip" && unitSelected && !userExcluded) return "text-warning";
  return "text-muted-foreground";
}

/** 冲突怎么办：下拉菜单，当前选了什么就显示什么 */
/** 钉的季 / 集一眼能看：S02E05、只钉集是 E05 */
const pad2 = (n: number) => String(n).padStart(2, "0");
const pinText = (p: OrganizeEpisodePin): string => `${p.season !== undefined ? `S${pad2(p.season)}` : ""}${p.episode !== undefined ? `E${pad2(p.episode)}` : ""}`;

/** 文件行「…」里能做的 */
export type FileEdit = "pin" | "rename" | "clearPin" | "clearRename" | "kindVideo" | "kindExtra" | "clearKind";

/** 文件行的「…」：钉季 / 集（剧集的视频）、改文件名、改判正片 / 花絮（视频），钉过 / 改过的能撤 */
function FileMenu({
  canPin,
  canKind,
  pinned,
  renamed,
  kind,
  disabled,
  onPick,
}: {
  canPin: boolean;
  canKind: boolean;
  pinned: boolean;
  renamed: boolean;
  kind?: OrganizeKindOverride;
  disabled: boolean;
  onPick: (what: FileEdit) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="mt-1 size-6" disabled={disabled} aria-label="更多改法">
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
        {canPin && (
          <DropdownMenuItem onSelect={() => onPick("pin")} className="flex-col items-start gap-0.5">
            <span className="text-xs font-medium">{pinned ? "改钉的季 / 集…" : "钉季 / 集…"}</span>
            <span className="text-[11px] whitespace-normal text-muted-foreground">看不出集数的文件靠它排进去；钉了的不受季覆盖 / 集偏移影响</span>
          </DropdownMenuItem>
        )}
        {canPin && pinned && (
          <DropdownMenuItem onSelect={() => onPick("clearPin")} className="text-xs">
            撤掉钉的季 / 集
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onPick("rename")} className="flex-col items-start gap-0.5">
          <span className="text-xs font-medium">改文件名…</span>
          <span className="text-[11px] whitespace-normal text-muted-foreground">目录照旧是整理算出来的；跟着它的字幕 / nfo 按新名字跟</span>
        </DropdownMenuItem>
        {renamed && (
          <DropdownMenuItem onSelect={() => onPick("clearRename")} className="text-xs">
            撤掉改名，回到模板的名字
          </DropdownMenuItem>
        )}
        {canKind && kind !== "video" && (
          <DropdownMenuItem onSelect={() => onPick("kindVideo")} className="flex-col items-start gap-0.5">
            <span className="text-xs font-medium">当正片</span>
            <span className="text-[11px] whitespace-normal text-muted-foreground">被当成花絮的其实是正片：按集 / 按电影命名</span>
          </DropdownMenuItem>
        )}
        {canKind && kind !== "extra" && (
          <DropdownMenuItem onSelect={() => onPick("kindExtra")} className="flex-col items-start gap-0.5">
            <span className="text-xs font-medium">当花絮</span>
            <span className="text-[11px] whitespace-normal text-muted-foreground">预告 / 花絮被当成了正片：进作品目录下的 extras/</span>
          </DropdownMenuItem>
        )}
        {canKind && kind && (
          <DropdownMenuItem onSelect={() => onPick("clearKind")} className="text-xs">
            撤掉改判，按规则判断
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConflictMenu({ current, disabled, onPick }: { current?: string; disabled: boolean; onPick: (how: OrganizeConflictChoice | "stay") => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="mt-1 h-6 gap-1 px-1.5 text-[11px] font-normal" disabled={disabled}>
          {current ?? "怎么办"}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
        {CONFLICT_CHOICES.map((c) => (
          <DropdownMenuItem key={c.key} onSelect={() => onPick(c.key)} className={`flex-col items-start gap-0.5 ${c.danger ? "text-destructive focus:text-destructive" : ""}`}>
            <span className="text-xs font-medium">{c.label}</span>
            <span className="text-[11px] whitespace-normal text-muted-foreground">{c.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemsTable({
  items,
  stage,
  unitSelected,
  editable,
  excluded,
  resolutions,
  pins,
  renames,
  kinds,
  local,
  tv,
  pending,
  onToggleItems,
  onResolve,
  onFileEdit,
}: {
  items: OrganizeItem[];
  stage: OrganizeRunStage;
  unitSelected: boolean;
  /** 待执行、单元勾着：每个文件能单独勾掉 */
  editable: boolean;
  /** 单独取消勾选的文件（网盘绝对路径） */
  excluded: ReadonlySet<string>;
  /** 冲突项选过的办法（网盘绝对路径 → 办法） */
  resolutions: OrganizeUnit["resolutions"];
  /** 钉的季 / 集、改的文件名（网盘绝对路径 → 值） */
  pins: OrganizeUnit["pins"];
  renames: OrganizeUnit["renames"];
  kinds: OrganizeUnit["kinds"];
  local: boolean;
  tv: boolean;
  pending: boolean;
  onToggleItems: (ids: string[], selected: boolean) => void;
  onResolve: (item: OrganizeItem, how: OrganizeConflictChoice | "stay") => void;
  onFileEdit: (item: OrganizeItem, what: FileEdit) => void;
}) {
  // 能单独勾的：要改名 / 移动的、冲突的（勾掉一份另一份就能走），和已经被勾掉的
  const toggleable = (it: OrganizeItem) => it.kind !== "dir" && (excluded.has(it.srcPath) || it.action === "rename" || it.action === "move" || it.action === "conflict");
  return (
    <div className="mt-3 overflow-x-auto rounded-md border">
      <table className="w-full min-w-[640px] text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            {editable && <th className="w-8 px-2 py-1.5" aria-label="勾选" />}
            <th className="px-2 py-1.5 text-left font-medium">动作</th>
            <th className="px-2 py-1.5 text-left font-medium">原来</th>
            <th className="px-2 py-1.5 text-left font-medium">整理后</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const changed = it.action === "rename" || it.action === "move";
            const userExcluded = excluded.has(it.srcPath);
            return (
              <tr key={it.id} className={`border-t align-top ${userExcluded ? "opacity-60" : ""}`}>
                {editable && (
                  <td className="px-2 py-1.5">
                    {toggleable(it) && (
                      <Checkbox checked={!userExcluded} disabled={pending} onCheckedChange={(v) => onToggleItems([it.id], v === true)} title={userExcluded ? "勾上才会动这个文件" : "取消勾选：这个文件留在原处"} />
                    )}
                  </td>
                )}
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <ItemStatus it={it} stage={stage} />
                  {it.attempts > 1 && <div className="mt-0.5 text-muted-foreground tabular-nums">已试 {it.attempts} 轮</div>}
                  {editable && !userExcluded && (it.action === "conflict" || resolutions[it.srcPath]) && (
                    <ConflictMenu
                      current={resolutions[it.srcPath] ? CONFLICT_LABEL[resolutions[it.srcPath].how] : undefined}
                      disabled={pending}
                      onPick={(how) => onResolve(it, how)}
                    />
                  )}
                  {editable && it.kind !== "dir" && (
                    <FileMenu
                      canPin={tv && !local && it.kind === "video"}
                      canKind={!local && it.kind === "video"}
                      pinned={!!pins[it.srcPath]}
                      renamed={!!renames[it.srcPath]}
                      kind={kinds[it.srcPath]}
                      disabled={pending}
                      onPick={(what) => onFileEdit(it, what)}
                    />
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <div className="break-all">{baseName(it.srcPath)}</div>
                  <div className="break-all text-muted-foreground">{dirName(it.srcPath)}</div>
                  {it.probe && <div className="text-muted-foreground">探测到 {probeLine(it.probe)}</div>}
                  {pins[it.srcPath] && <div className="text-muted-foreground">钉在 {pinText(pins[it.srcPath])}</div>}
                  {renames[it.srcPath] && <div className="break-all text-muted-foreground">改名为 {renames[it.srcPath]}</div>}
                  {kinds[it.srcPath] && <div className="text-muted-foreground">{kinds[it.srcPath] === "video" ? "改判为正片" : "改判为花絮"}</div>}
                  {it.error ? (
                    <div className="break-all text-destructive">{it.error}</div>
                  ) : it.reason ? (
                    <div className={`break-all ${reasonClass(it, unitSelected, userExcluded)}`}>{it.reason}</div>
                  ) : null}
                </td>
                <td className="px-2 py-1.5">
                  {changed || it.action === "conflict" ? (
                    <>
                      <div className={`break-all ${changed ? "font-medium" : ""}`}>{baseName(it.dstPath)}</div>
                      <div className="break-all text-muted-foreground">{dirName(it.dstPath)}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 建目录 / 删空目录：不属于某个作品，单独列；展开时才拉 */
function DirItems({ runId, count, stage, version }: { runId: string; count: number; stage: OrganizeRunStage; version: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border bg-card p-4">
      <button type="button" className="flex w-full items-center gap-1 text-sm" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        目录操作（{count}）
        <span className="ml-2 text-xs text-muted-foreground">建目标目录、删腾空的源目录</span>
      </button>
      {open && <DirFiles runId={runId} stage={stage} version={version} />}
    </div>
  );
}

function DirFiles({ runId, stage, version }: { runId: string; stage: OrganizeRunStage; version: number }) {
  const { items, error } = useRunItems(runId, { unit: "" }, true, version);
  if (error) return <p className="mt-3 break-all text-xs text-destructive">{error}</p>;
  if (!items) return <FilesLoading />;
  return (
    <ul className="mt-3 space-y-1 text-xs">
      {items.map((it) => (
        <li key={it.id} className="flex items-start gap-2">
          <ItemStatus it={it} stage={stage} />
          <span className="break-all">{it.action === "rmdir" ? it.srcPath : it.dstPath}</span>
          {it.error && <span className="break-all text-destructive">{it.error}</span>}
        </li>
      ))}
    </ul>
  );
}
