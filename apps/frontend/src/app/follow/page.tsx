"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Pause, Pencil, Play, RefreshCw, Rss, Telescope, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { toast } from "sonner";
import type { ShareFollowRun, ShareFollowSummary } from "@openstrm/shared";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading";
import { api, type FollowListResponse } from "@/lib/api";
import { usePolling } from "@/hooks/use-polling";
import { apiErrorMessage } from "@/lib/axios";
import { FOLLOW_INTERVALS, intervalLabel, organizedLabel, organizedParts, scopeLabel } from "@/lib/follow";
import { keywordFromName, searchHref } from "@/lib/resource";

/** 有订阅正在检查时的刷新间隔 */
const POLL_INTERVAL_MS = 5000;

function fmtTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function relativePast(ms: number | null): string {
  if (!ms) return "还没检查过";
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

function relativeFuture(ms: number): string {
  const d = Math.floor((ms - Date.now()) / 1000);
  if (d <= 30) return "即将";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} 分钟后`;
  if (d < 86400) return `${Math.round(d / 3600)} 小时后`;
  return `${Math.round(d / 86400)} 天后`;
}

/** enabled + status 合成界面上的一个徽标 */
function statusMeta(f: ShareFollowSummary): { tone: StatusTone; label: string; pulse?: boolean } {
  if (f.status === "checking") return { tone: "info", label: "检查中", pulse: true };
  if (!f.enabled) {
    if (f.status === "expired") return { tone: "danger", label: "分享失效" };
    if (f.status === "stale") return { tone: "neutral", label: "已停更" };
    return { tone: "neutral", label: "已暂停" };
  }
  if (f.status === "error") return { tone: "danger", label: "出错" };
  return { tone: "brand", label: "追更中" };
}

export default function FollowPage() {
  const [data, setData] = useState<FollowListResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskPaths, setTaskPaths] = useState<Record<string, string> | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<ShareFollowSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ShareFollowSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 刷新和「立即检查」的响应可能交错，慢的旧列表不能盖掉新的
  const seqRef = useRef(0);

  useEffect(() => {
    api.tasks
      .list()
      .then((rows) => setTaskPaths(Object.fromEntries(rows.map((t) => [t.id, t.originPath]))))
      .catch(() => setTaskPaths({}));
  }, []);

  const load = useCallback(async (silent = false) => {
    const seq = ++seqRef.current;
    if (!silent) setRefreshing(true);
    try {
      const res = await api.follow.list();
      if (seq !== seqRef.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      const msg = apiErrorMessage(err, "读取追更列表失败");
      setError(msg);
      if (!silent) toast.error(msg);
    } finally {
      if (seq === seqRef.current) {
        setLoaded(true);
        if (!silent) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 有订阅在检查时每 5 秒刷一次；页面切到后台不刷
  const active = useMemo(
    () => Boolean(data?.follows.some((f) => f.status === "checking") || (data?.watcher.checking.length ?? 0) > 0),
    [data],
  );
  usePolling(() => load(true), POLL_INTERVAL_MS, { enabled: active });

  const mergeFollow = (next: ShareFollowSummary) =>
    setData((prev) => (prev ? { ...prev, follows: prev.follows.map((f) => (f.id === next.id ? next : f)) } : prev));

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await fn();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const doCheck = (f: ShareFollowSummary) =>
    withBusy(f.id, async () => {
      mergeFollow({ ...f, status: "checking" });
      try {
        const r = await api.follow.check(f.id);
        mergeFollow(r.follow);
        if (r.run?.added.length) {
          toast.success(`「${f.name}」新增 ${r.run.added.length} 个，生成 ${r.run.generated} 个 strm`);
        } else if (r.run?.error) {
          toast.error(`「${f.name}」检查出错：${r.run.error}`);
        } else if (r.run?.skipped.length) {
          toast.info(`「${f.name}」有 ${r.run.skipped.length} 项变化被跳过，详情见最近动态`);
        } else {
          toast.info(`「${f.name}」没有新增`);
        }
      } catch (err) {
        toast.error(apiErrorMessage(err, "检查失败"));
        void load(true);
      }
    });

  const doToggle = (f: ShareFollowSummary) =>
    withBusy(f.id, async () => {
      try {
        mergeFollow(await api.follow.update(f.id, { enabled: !f.enabled }));
        toast.success(f.enabled ? `已暂停「${f.name}」` : `已继续「${f.name}」，稍后就会检查一次`);
      } catch (err) {
        toast.error(apiErrorMessage(err, "操作失败"));
      }
    });

  const doDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.follow.remove(deleteTarget.id);
      toast.success(`已删除「${deleteTarget.name}」`);
      setData((prev) => (prev ? { ...prev, follows: prev.follows.filter((f) => f.id !== deleteTarget.id) } : prev));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
    } finally {
      setDeleting(false);
    }
  };

  const follows = data?.follows ?? [];
  const activeCount = follows.filter((f) => f.enabled).length;

  /** 表格行和手机卡片吃同一份 props，操作走同一套处理函数 */
  const itemProps = (f: ShareFollowSummary): FollowItemProps => ({
    follow: f,
    originPath: taskPaths ? (taskPaths[f.taskId] ?? null) : undefined,
    busy: busyIds.has(f.id),
    onCheck: () => void doCheck(f),
    onToggle: () => void doToggle(f),
    onEdit: () => setEditTarget(f),
    onDelete: () => setDeleteTarget(f),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Rss}
        title="追更"
        description="盯住分享里的剧集目录，定期把新增的文件自动转存到任务目录并生成 strm"
        actions={
          <Button variant="outline" onClick={() => load()} disabled={refreshing}>
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
            刷新
          </Button>
        }
      >
        {follows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
            <StatusBadge tone="neutral" className="tabular-nums">
              {activeCount} / {follows.length} 条在追
            </StatusBadge>
            {data?.watcher.lastError && (
              <span className="break-all text-xs text-destructive">循环最近一次出错：{data.watcher.lastError}</span>
            )}
          </div>
        )}
      </PageHeader>

      {!loaded ? (
        <TableSkeleton rows={4} />
      ) : follows.length === 0 ? (
        error ? (
          <EmptyState
            icon={Rss}
            title="列表加载失败"
            description={error}
            action={
              <Button variant="outline" onClick={() => load()} disabled={refreshing}>
                <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
                重试
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Rss}
            title="还没有追更订阅"
            description="转存分享时（分享详情或收藏夹的「保存到任务目录」）勾选「转存后追更」，新集就会自动跟过来。"
          />
        )
      ) : (
        <>
          {/* 手机上一条一张卡，状态和操作都摆在眼前；md 起还是表格 */}
          <div className="space-y-3 md:hidden">
            {follows.map((f) => (
              <FollowCard key={f.id} {...itemProps(f)} />
            ))}
          </div>
          <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-48">目标</TableHead>
                  <TableHead className="w-36">检查</TableHead>
                  <TableHead className="min-w-[160px]">最近动态</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-36 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {follows.map((f) => (
                  <FollowRow key={f.id} {...itemProps(f)} />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <EditFollowDialog
        target={editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
        onSaved={(next) => {
          mergeFollow(next);
          setEditTarget(null);
        }}
      />

      <AlertDialog open={deleteTarget != null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除追更</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              不再检查「{deleteTarget?.name}」的更新。已经转存到网盘和生成的 strm 不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doDelete();
              }}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type FollowItemProps = {
  follow: ShareFollowSummary;
  /** undefined = 任务列表还没拿到；null = 任务已删除 */
  originPath: string | null | undefined;
  busy: boolean;
  onCheck: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

/** 表格行和手机卡片都要算的展示字段 */
function followView(f: ShareFollowSummary, originPath: string | null | undefined) {
  const target =
    originPath === undefined
      ? "…"
      : `${originPath ?? "（任务已删除）"}${f.subPath ? `/${f.subPath}` : ""}`;
  return {
    meta: statusMeta(f),
    scope: scopeLabel(f),
    target,
    last: f.recent[0] as ShareFollowRun | undefined,
    checking: f.status === "checking",
  };
}

/** 分享失效、长期没更新而停掉的订阅：给个按订阅名去资源搜索的入口，找一个还在更的分享 */
function AltSearchLink({ follow: f, className }: { follow: ShareFollowSummary; className?: string }) {
  if (f.enabled || (f.status !== "expired" && f.status !== "stale")) return null;
  // 没起名字的订阅，名字是分享码或者盯着的目录：拿不出片名就不给这个入口，免得搜一串分享码
  const keyword = keywordFromName(f.name);
  if (!keyword) return null;
  return (
    <Link href={searchHref(keyword)} className={`flex w-fit items-center gap-1 text-xs text-brand hover:underline ${className ?? ""}`}>
      <Telescope className="size-3" />
      搜替代资源
    </Link>
  );
}

/** 一条整理沿用：片名照常换行，「· 第 2 季」「· 集偏移 -12」各自不断开 */
function OrganizedText({ parts }: { parts: string[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={p} className={i > 0 ? "whitespace-nowrap" : undefined}>
          {i > 0 ? ` · ${p}` : p}
        </span>
      ))}
    </>
  );
}

/** 整理沿用：新集交给整理时照着认的作品 / 季 / 集偏移；分享里好几个目录各有一条时只写第一条，其余放悬停提示 */
function OrganizedLine({ follow: f }: { follow: ShareFollowSummary }) {
  if (f.organized.length === 0) return null;
  const labels = f.organized.map((o) => `${o.dir ? `${o.dir}：` : ""}${organizedLabel(o)}`);
  return (
    <div className="break-words text-xs text-muted-foreground" title={`新集交给整理时照着认：\n${labels.join("\n")}`}>
      整理沿用：
      <OrganizedText parts={organizedParts(f.organized[0])} />
      {f.organized.length > 1 && <span className="whitespace-nowrap">{` 等 ${f.organized.length} 个目录`}</span>}
    </div>
  );
}

/** 最近一次有动静的检查：新增了什么、跳过了什么 */
function FollowRecent({ last }: { last: ShareFollowRun | undefined }) {
  if (!last) return <span className="text-xs text-muted-foreground">订阅以来还没有新增</span>;
  return (
    <div className="space-y-0.5 text-xs">
      {last.added.length > 0 && (
        <div className="break-all">
          <span className="font-medium text-success tabular-nums">+{last.added.length}</span>{" "}
          {last.added.slice(0, 2).join("、")}
          {last.added.length > 2 ? ` 等 ${last.added.length} 个` : ""}
        </div>
      )}
      {last.skipped.length > 0 && (
        <div className="break-all text-muted-foreground" title={last.skipped.join("\n")}>
          跳过 {last.skipped.length} 项（{last.skipped[0]}
          {last.skipped.length > 1 ? " 等" : ""}）
        </div>
      )}
      {last.error && (last.added.length > 0 || last.skipped.length > 0) && (
        <div className="break-all text-destructive">{last.error}</div>
      )}
      <div className="text-muted-foreground">{relativePast(last.at)}</div>
    </div>
  );
}

/** 操作按钮：表格里是一排图标，卡片里是带文字的大按钮，手指好点 */
function FollowActions({
  follow: f,
  busy,
  onCheck,
  onToggle,
  onEdit,
  onDelete,
  variant,
}: FollowItemProps & { variant: "row" | "card" }) {
  const checking = f.status === "checking";
  const checkIcon = busy || checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />;
  const toggleIcon = f.enabled ? <Pause className="size-4" /> : <Play className="size-4" />;
  if (variant === "row") {
    return (
      <div className="flex justify-end gap-0.5">
        <Button variant="ghost" size="icon" className="size-8" title="立即检查" onClick={onCheck} disabled={busy || checking}>
          {checkIcon}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          title={f.enabled ? "暂停" : "继续"}
          onClick={onToggle}
          disabled={busy || checking}
        >
          {toggleIcon}
        </Button>
        <Button variant="ghost" size="icon" className="size-8" title="编辑" onClick={onEdit} disabled={busy}>
          <Pencil className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-destructive hover:text-destructive"
          title="删除"
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    );
  }
  return (
    <>
      <Button variant="outline" size="sm" className="h-9 flex-1" onClick={onCheck} disabled={busy || checking}>
        {checkIcon}
        检查
      </Button>
      <Button variant="outline" size="sm" className="h-9 flex-1" onClick={onToggle} disabled={busy || checking}>
        {toggleIcon}
        {f.enabled ? "暂停" : "继续"}
      </Button>
      <Button variant="outline" size="sm" className="h-9 flex-1" onClick={onEdit} disabled={busy}>
        <Pencil className="size-4" />
        编辑
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-9 text-destructive hover:text-destructive"
        title="删除"
        onClick={onDelete}
        disabled={busy}
      >
        <Trash2 className="size-4" />
      </Button>
    </>
  );
}

function FollowRow(props: FollowItemProps) {
  const { follow: f, originPath } = props;
  const { meta, scope, target, last, checking } = followView(f, originPath);
  return (
    <TableRow>
      <TableCell className="min-w-[180px]">
        <div className="break-all text-sm font-medium">{f.name}</div>
        <div className="break-all text-xs text-muted-foreground">
          {f.watchPath || "分享根目录"}
          {scope !== "整个目录" && ` · 只追：${scope}`}
        </div>
      </TableCell>
      <TableCell className="break-all text-xs text-muted-foreground">
        <div>→ {target}</div>
        <OrganizedLine follow={f} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        <div>{intervalLabel(f.intervalMinutes)}</div>
        <div title={`上次：${fmtTime(f.lastCheckedAt)}`}>上次 {relativePast(f.lastCheckedAt)}</div>
        {f.enabled && !checking && <div title={fmtTime(f.nextCheckAt)}>下次 {relativeFuture(f.nextCheckAt)}</div>}
      </TableCell>
      <TableCell>
        <FollowRecent last={last} />
      </TableCell>
      <TableCell>
        <StatusBadge tone={meta.tone} pulse={meta.pulse}>
          {meta.label}
        </StatusBadge>
        {f.lastError && f.status !== "checking" && (
          <div className="mt-1 break-all text-xs text-muted-foreground" title={f.lastError}>
            {f.lastError.length > 60 ? `${f.lastError.slice(0, 60)}…` : f.lastError}
          </div>
        )}
        <AltSearchLink follow={f} className="mt-1" />
      </TableCell>
      <TableCell className="whitespace-nowrap text-right">
        <FollowActions {...props} variant="row" />
      </TableCell>
    </TableRow>
  );
}

/** 手机上的一条订阅：状态在右上角，检查节奏和最近动态在中间，底部一排大按钮 */
function FollowCard(props: FollowItemProps) {
  const { follow: f, originPath } = props;
  const { meta, scope, target, last, checking } = followView(f, originPath);
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="break-all text-sm font-medium">{f.name}</div>
          <div className="break-all text-xs text-muted-foreground">
            {f.watchPath || "分享根目录"}
            {scope !== "整个目录" && ` · 只追：${scope}`}
          </div>
          <div className="break-all text-xs text-muted-foreground">→ {target}</div>
          <OrganizedLine follow={f} />
        </div>
        <StatusBadge tone={meta.tone} pulse={meta.pulse} className="shrink-0">
          {meta.label}
        </StatusBadge>
      </div>
      <div className="mt-3 space-y-1 text-xs text-muted-foreground">
        <div>
          {intervalLabel(f.intervalMinutes)} · 上次 {relativePast(f.lastCheckedAt)}
          {f.enabled && !checking && ` · 下次 ${relativeFuture(f.nextCheckAt)}`}
        </div>
        <FollowRecent last={last} />
        {f.lastError && f.status !== "checking" && <div className="break-all text-destructive">{f.lastError}</div>}
        <AltSearchLink follow={f} />
      </div>
      <div className="mt-3 flex items-center gap-2 border-t pt-3">
        <FollowActions {...props} variant="card" />
      </div>
    </div>
  );
}

function EditFollowDialog({
  target,
  onOpenChange,
  onSaved,
}: {
  target: ShareFollowSummary | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: ShareFollowSummary) => void;
}) {
  const [name, setName] = useState("");
  const [interval, setIntervalMin] = useState("360");
  const [clearOrganized, setClearOrganized] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!target) return;
    setName(target.name);
    setIntervalMin(String(target.intervalMinutes));
    setClearOrganized(false);
  }, [target]);

  const save = async () => {
    if (!target) return;
    setSaving(true);
    try {
      onSaved(
        await api.follow.update(target.id, {
          name: name.trim() || target.name,
          intervalMinutes: Number(interval),
          ...(clearOrganized ? { clearOrganized: true } : {}),
        }),
      );
      toast.success("已保存");
    } catch (err) {
      toast.error(apiErrorMessage(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const presets = FOLLOW_INTERVALS.some((o) => String(o.value) === interval)
    ? FOLLOW_INTERVALS
    : [...FOLLOW_INTERVALS, { value: Number(interval), label: intervalLabel(Number(interval)) }];

  return (
    <Dialog open={target != null} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>编辑追更</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="订阅名称" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">检查间隔</label>
            <Select value={interval} onValueChange={setIntervalMin}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {target && target.organized.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium">整理沿用</label>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {target.organized.map((o) => (
                  <li key={o.dir} className="break-words">
                    {o.dir ? `${o.dir}：` : ""}
                    <OrganizedText parts={organizedParts(o)} />
                  </li>
                ))}
              </ul>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={clearOrganized} onCheckedChange={(v) => setClearOrganized(v === true)} />
                不再沿用，新集交给整理时重新识别
              </label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
