"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Activity, Loader2, Play, Radar, RotateCw, Square, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { FormSkeleton } from "@/components/loading";
import type { LifeMonitorSettings } from "@openstrm/shared";
import { api, type LifeEventMode as EventMode, type LifeEventRow, type LifeMonitorStatus as Status } from "@/lib/api";
import { usePolling } from "@/hooks/use-polling";
import { FieldHint } from "@/components/field-hint";
import { apiErrorMessage } from "@/lib/axios";

/**
 * 只放配置项，故意不含 enabled。
 * enabled 是「是否随服务自启」的运行态，由启动/停止按钮独占，
 * 表单若也带着它，保存时会用挂载那一刻的旧值把启停结果覆盖掉。
 */
type LifeMonitorConfig = Omit<LifeMonitorSettings, "enabled">;

type Account = { name: string; accountType: string };

const ALL_MODES: { value: EventMode; label: string; hint: string }[] = [
  { value: "create", label: "新增", hint: "上传 / 接收 / 复制 → 生成 strm" },
  { value: "move", label: "移动", hint: "移动网盘文件 → 同步移动本地" },
  { value: "rename", label: "改名", hint: "重命名 → 同步重命名本地" },
  { value: "remove", label: "删除", hint: "删除网盘文件 → 删除本地 strm" },
];

const PULL_MODES = [
  { value: "latest", label: "latest — 只处理启动之后的新事件" },
  { value: "all", label: "all — 拉取全部历史事件补齐" },
  { value: "last", label: "last — 从上次停止的位置继续" },
];

function fmtTime(sec?: number | null) {
  if (!sec) return "—";
  const ms = sec > 1e11 ? sec : sec * 1000;
  return new Date(ms).toLocaleString();
}

function relative(ms: number | null) {
  if (!ms) return "—";
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return `${d} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  return `${Math.floor(d / 3600)} 小时前`;
}

/**
 * 三个秒数以前是 `parseInt(e.target.value) || 默认值`：打错一个字符会被悄悄改回默认值，
 * 人还以为自己填进去了。现在合法性说出来。
 */
const seconds = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max, `填 ${min}–${max} 之间的整数秒`);

const configSchema = z.object({
  accounts: z.array(z.string()),
  pullMode: z.enum(["latest", "all", "last"]),
  eventModes: z.array(z.enum(["create", "move", "rename", "remove"])),
  intervalSeconds: seconds(5, 3600),
  mediaServerRefreshDelay: seconds(1, 3600),
  mediaServerRefreshMaxWait: seconds(1, 86400),
});

/** 三个秒数在表单里是字符串，提交时才转回数字——这样"空着"和"填了 0"分得开，也能说出为什么不合法 */
type ConfigValues = z.infer<typeof configSchema>;

const CONFIG_DEFAULTS: ConfigValues = {
  accounts: [],
  pullMode: "latest",
  eventModes: ALL_MODES.map((m) => m.value),
  intervalSeconds: "15",
  mediaServerRefreshDelay: "30",
  mediaServerRefreshMaxWait: "300",
};

/** 表单值 → 存进设置的形状 */
function toConfig(v: ConfigValues): LifeMonitorConfig {
  return {
    accounts: v.accounts,
    pullMode: v.pullMode,
    eventModes: v.eventModes,
    intervalSeconds: Number(v.intervalSeconds),
    mediaServerRefreshDelay: Number(v.mediaServerRefreshDelay),
    mediaServerRefreshMaxWait: Number(v.mediaServerRefreshMaxWait),
  };
}

export default function LifeMonitorPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [events, setEvents] = useState<LifeEventRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);

  const form = useForm<ConfigValues>({
    resolver: zodResolver(configSchema),
    defaultValues: CONFIG_DEFAULTS,
  });
  const saving = form.formState.isSubmitting;
  const cfg = form.watch();

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.life.status());
    } catch {
      /* 轮询失败静默，避免刷屏 */
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      setEvents((await api.life.events(30)).events || []);
    } catch {
      /* 同上 */
    }
  }, []);

  useEffect(() => {
    Promise.all([
      api.settings.get().then((s) => {
        // 运行态归启停按钮管，别让表单把它带回来
        const saved = s.lifeMonitor ?? {};
        // reset 而不是逐个 setValue：这同时是新的"未改动"基准。enabled 归启停按钮管，不进表单
        form.reset({
          accounts: saved.accounts ?? CONFIG_DEFAULTS.accounts,
          pullMode: saved.pullMode ?? CONFIG_DEFAULTS.pullMode,
          eventModes: saved.eventModes ?? CONFIG_DEFAULTS.eventModes,
          intervalSeconds: String(saved.intervalSeconds ?? CONFIG_DEFAULTS.intervalSeconds),
          mediaServerRefreshDelay: String(saved.mediaServerRefreshDelay ?? CONFIG_DEFAULTS.mediaServerRefreshDelay),
          mediaServerRefreshMaxWait: String(saved.mediaServerRefreshMaxWait ?? CONFIG_DEFAULTS.mediaServerRefreshMaxWait),
        });
      }),
      // 能做变更监控的账号：115（生活事件）和夸克（快照对比）；OpenList 没有
      api.accounts.list().then((list) => setAccounts((list || []).filter((a) => a.accountType !== "openlist"))),
      loadStatus(),
      loadEvents(),
    ])
      .catch((err) => toast.error(apiErrorMessage(err, "加载监控配置失败")))
      .finally(() => setLoading(false));
  }, [loadStatus, loadEvents, form]);

  // 运行时每 5s 刷新一次状态，停止时不必轮询
  usePolling(() => Promise.all([loadStatus(), loadEvents()]), 5000, { enabled: Boolean(status?.running) });

  const saveConfig = async (values: ConfigValues) => {
    try {
      // 只动 lifeMonitor 这一个键；enabled 由启停按钮维护，合并时保留库里的值
      const current = (await api.settings.get()).lifeMonitor ?? {};
      await api.settings.patch({ lifeMonitor: { ...current, ...toConfig(values) } });
      form.reset(values);
      toast.success("配置已保存");
      if (status?.running) toast.info("部分参数需要重启监控后生效");
    } catch {
      toast.error("保存失败");
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const r = await api.life.start(toConfig(cfg));
      // 起来了但有账号没起来：按警告提示，别让一条失败原因藏在绿色对勾后面
      if (r.partial) toast.warning(r.message);
      else toast.success(r.message || "已启动");
      await loadStatus();
    } catch (err: unknown) {
      toast.error(apiErrorMessage(err, "启动失败"));
      await loadStatus();
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const r = await api.life.stop();
      toast.success(r.message || "已停止");
      await loadStatus();
    } catch {
      toast.error("停止失败");
    } finally {
      setBusy(false);
    }
  };

  const probe = async () => {
    setProbing(true);
    try {
      const r = await api.life.probe(5);
      toast.success(`连通正常：${r.message || ""}`);
    } catch (err: unknown) {
      toast.error(apiErrorMessage(err, "连接失败"));
    } finally {
      setProbing(false);
    }
  };

  const toggleMode = (m: EventMode, on: boolean) => {
    const cur = new Set<EventMode>(cfg.eventModes);
    if (on) cur.add(m);
    else cur.delete(m);
    form.setValue("eventModes", ALL_MODES.map((x) => x.value).filter((v) => cur.has(v)), { shouldDirty: true });
  };

  const toggleAccount = (name: string, on: boolean) => {
    const cur = new Set(cfg.accounts);
    if (on) cur.add(name);
    else cur.delete(name);
    // 按账号表的顺序存，勾选的先后不影响结果；已不存在的账号名排最后
    const known = accounts.map((a) => a.name).filter((n) => cur.has(n));
    const unknown = [...cur].filter((n) => !accounts.some((a) => a.name === n));
    form.setValue("accounts", [...known, ...unknown], { shouldDirty: true });
  };

  const description = "盯着网盘的变动增量更新本地 strm 库，无需跑全量任务：115 走生活事件流，夸克定时对比任务目录；多个账号各自轮询";

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Radar} title="网盘监控" description={description} />
        <div className="max-w-3xl">
          <FormSkeleton />
        </div>
      </div>
    );
  }

  const modes = new Set<EventMode>(cfg.eventModes);
  const selected = new Set(cfg.accounts);
  const unknownAccounts = [...selected].filter((n) => !accounts.some((a) => a.name === n));
  const runningCount = status?.accounts.filter((a) => a.running).length ?? 0;
  // 只有一个账号时事件表不用多一列账号
  const showEventAccount =
    (status?.accounts.length ?? 0) > 1 || new Set(events.map((e) => e.accountName)).size > 1;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Radar}
        title="网盘监控"
        description={description}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={probe} disabled={probing}>
              {probing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              测试连接
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              title="刷新"
              onClick={() => { loadStatus(); loadEvents(); }}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            {status?.running ? (
              <>
                {/* 重启 = 用当前表单配置先停再起：改了账号列表、或某个账号修好 cookie 后重新带上它 */}
                <Button variant="outline" size="sm" onClick={start} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                  重启
                </Button>
                <Button variant="destructive" size="sm" onClick={stop} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                  停止
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={start} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                启动
              </Button>
            )}
          </>
        }
      />
      <div className="max-w-3xl space-y-6">
        {/* ---------------- 运行状态 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Activity className="h-4 w-4 text-muted-foreground" />
            运行状态
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            {status && <RunBadge running={status.running} />}
            {status && status.accounts.length > 0 && (
              <Badge variant="outline" className="tabular-nums">
                {runningCount} / {status.accounts.length} 个账号在跑
              </Badge>
            )}
            {status?.embyRefresh?.configured && status.embyRefresh.pendingCount > 0 && (
              <Badge variant="outline" className="tabular-nums">
                待通知 Emby：{status.embyRefresh.pendingCount} 处变更
              </Badge>
            )}
          </div>

          {status === null ? (
            <p className="text-sm text-muted-foreground">运行状态没能加载，点右上角的刷新按钮重试</p>
          ) : status.accounts.length > 0 ? (
            <>
              {/* 手机上一账号一张卡：九列的表格横向滚起来什么都看不全 */}
              <div className="space-y-3 md:hidden">
                {status.accounts.map((a) => {
                  const notice = accountNotice(a, status.running);
                  return (
                    <div key={a.name} className="rounded-xl border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="break-all text-sm font-medium">{a.name}</div>
                          <div className="text-xs text-muted-foreground">来源 {a.source}</div>
                        </div>
                        <div className="shrink-0">
                          <RunBadge running={a.running} />
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
                        <Stat label="轮询" value={a.stats.rounds} />
                        <Stat label="事件" value={a.stats.events} />
                        <Stat label="已处理" value={a.stats.handled} />
                        <Stat label="失败" value={a.stats.failed} />
                        <Stat label="最近轮询" value={relative(a.lastPollAt)} />
                        <Stat label="游标时间" value={fmtTime(a.cursor.time)} />
                      </div>
                      {notice && (
                        <div className={`mt-3 break-all text-xs ${notice.tone === "danger" ? "text-destructive" : "text-muted-foreground"}`}>
                          {notice.text}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>账号</TableHead>
                      <TableHead className="w-20">状态</TableHead>
                      <TableHead className="w-20">来源</TableHead>
                      <TableHead className="w-16 text-right">轮询</TableHead>
                      <TableHead className="w-16 text-right">事件</TableHead>
                      <TableHead className="w-16 text-right">已处理</TableHead>
                      <TableHead className="w-16 text-right">失败</TableHead>
                      <TableHead className="w-24">最近轮询</TableHead>
                      <TableHead className="w-40">游标时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {status.accounts.map((a) => {
                      const notice = accountNotice(a, status.running);
                      return (
                      <Fragment key={a.name}>
                        <TableRow>
                          <TableCell className="font-medium">{a.name}</TableCell>
                          <TableCell>
                            <RunBadge running={a.running} />
                          </TableCell>
                          <TableCell className="text-xs">{a.source}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.stats.rounds}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.stats.events}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.stats.handled}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.stats.failed}</TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {relative(a.lastPollAt)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {fmtTime(a.cursor.time)}
                          </TableCell>
                        </TableRow>
                        {notice && (
                          <TableRow>
                            <TableCell
                              colSpan={9}
                              className={`text-xs break-all whitespace-normal ${notice.tone === "danger" ? "text-destructive" : "text-muted-foreground"}`}
                            >
                              {notice.text}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              没有可监控的账号，请先到「账户」页添加带 cookie 的 115 或夸克账号
            </p>
          )}

          <div className="grid grid-cols-3 gap-3 rounded-lg bg-muted/40 p-3 text-sm md:grid-cols-7">
            <Stat label="轮询次数" value={status?.stats.rounds ?? 0} />
            <Stat label="已处理" value={status?.stats.handled ?? 0} />
            <Stat label="失败" value={status?.stats.failed ?? 0} />
            <Stat label="最近轮询" value={relative(status?.lastPollAt ?? null)} />
            <Stat label="事件表" value={status?.db.lifeEvents ?? 0} />
            <Stat label="路径缓存" value={status?.db.pathCache ?? 0} />
            <Stat label="目录快照" value={status?.db.snapshots ?? 0} />
          </div>

          {status?.logs && status.logs.length > 0 && (
            <details className="rounded-lg border bg-muted/30 p-3">
              <summary className="cursor-pointer text-sm select-none">
                运行日志（最近 {Math.min(status.logs.length, 50)} 条）
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground">
                {status.logs.slice(-50).join("\n")}
              </pre>
            </details>
          )}
        </section>

        {/* ---------------- 配置 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">配置</h2>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(saveConfig)} className="space-y-4">

            <div className="space-y-2">
              <Label>监控账号</Label>
              {accounts.length === 0 && unknownAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无可监控的账号，请先到「账户」页添加 115 或夸克账号</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {accounts.map((a) => (
                    <label key={a.name} className="flex items-center gap-2 rounded-md border p-3 cursor-pointer">
                      <Checkbox
                        checked={selected.has(a.name)}
                        onCheckedChange={(v) => toggleAccount(a.name, v === true)}
                      />
                      <span className="text-sm font-medium">{a.name}</span>
                    </label>
                  ))}
                  {unknownAccounts.map((name) => (
                    <label key={name} className="flex items-center gap-2 rounded-md border border-dashed p-3 cursor-pointer">
                      <Checkbox checked onCheckedChange={(v) => toggleAccount(name, v === true)} />
                      <span className="text-sm">
                        <span className="font-medium">{name}</span>
                        <span className="block text-xs text-muted-foreground">账号已不存在，取消勾选后保存</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                一个都不勾时监控全部 115 / 夸克账号
                <FieldHint label="账号是怎么监控的">
                  勾选的账号各跑一条轮询，互不影响。事件路径按该账号同步任务的原始路径前缀匹配。
                  夸克没有事件流，靠每轮比对任务目录里各个目录的指纹、只列变了的目录，最短 1 分钟一轮，每 12 小时再整棵对比一次。
                  同步任务在跑的目录，监控先把变化记下来，等它跑完再按先后补上，免得两边把对方刚改好的又改回去。
                </FieldHint>
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="pullMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>冷启动模式</FormLabel>
                    <Select value={field.value || "latest"} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PULL_MODES.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-xs">
                      首次启用建议 latest；all 会把历史事件全部补一遍，耗时较长
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                  control={form.control}
                  name="intervalSeconds"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>轮询间隔（秒）</FormLabel>
                      <FormControl>
                        <Input inputMode="numeric" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">默认 15 秒，太短容易触发 115 风控；夸克账号最短 1 分钟；每个账号各算各的</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
            </div>

            <div className="space-y-2">
              <Label>处理的事件类型</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {ALL_MODES.map((m) => (
                  <label key={m.value} className="flex items-start gap-2 rounded-md border p-3 cursor-pointer">
                    <Checkbox
                      checked={modes.has(m.value)}
                      onCheckedChange={(v) => toggleMode(m.value, v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="text-sm font-medium">{m.label}</span>
                      <span className="block text-xs text-muted-foreground">{m.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                关掉「删除」可以避免网盘误删连带清掉本地 strm
              </p>
            </div>

            <div className="space-y-4 border-t pt-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Emby 刷新</h3>
                <p className="text-xs text-muted-foreground">
                  /Library/Refresh 是全库扫描，变更事件逐条触发会打瘫 Emby，所以合并成一次再发。
                  未配置 Emby 地址时不会发出任何请求。
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="mediaServerRefreshDelay"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>安静期（秒）</FormLabel>
                      <FormControl>
                        <Input inputMode="numeric" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">最后一次变更后再等这么久才通知</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="mediaServerRefreshMaxWait"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>最长等待（秒）</FormLabel>
                      <FormControl>
                        <Input inputMode="numeric" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">变更持续不断时的封顶时间，防止刷新被无限推后</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <div className="pt-2">
              <Button type="submit" disabled={saving}>
                {saving ? "保存中..." : "保存"}
              </Button>
            </div>
            </form>
          </Form>
        </section>

        {/* ---------------- 最近事件 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">最近事件</h2>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有拉到任何事件</p>
          ) : (
            <>
              {/* 手机上一事件一张卡，文件名占满一行 */}
              <div className="space-y-2 md:hidden">
                {events.map((e) => (
                  <div key={e.id} className="rounded-xl border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="break-all text-sm font-medium">{e.path || e.fileName}</div>
                        {e.oldPath && <div className="break-all text-xs text-muted-foreground">来自 {e.oldPath}</div>}
                        <div className="text-xs text-muted-foreground">
                          {fmtTime(e.updateTime)}
                          {showEventAccount ? ` · ${e.accountName}` : ""} · {e.typeName}
                        </div>
                        {e.detail && <div className="break-all text-xs text-muted-foreground">{e.detail}</div>}
                      </div>
                      <div className="shrink-0">
                        <EventBadge status={e.status} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-40">时间</TableHead>
                      {showEventAccount && <TableHead className="w-28">账号</TableHead>}
                      <TableHead className="w-28">类型</TableHead>
                      <TableHead>路径</TableHead>
                      <TableHead className="w-20">结果</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {fmtTime(e.updateTime)}
                        </TableCell>
                        {showEventAccount && <TableCell className="text-xs">{e.accountName}</TableCell>}
                        <TableCell className="text-xs">{e.typeName}</TableCell>
                        <TableCell className="text-xs whitespace-normal">
                          <div className="break-all">{e.path || e.fileName}</div>
                          {e.oldPath && <div className="text-muted-foreground break-all">来自 {e.oldPath}</div>}
                          {e.detail && (
                            <div className="text-muted-foreground break-all">{e.detail}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <EventBadge status={e.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** 账号的运行状态标签：顶部总状态、状态表和手机卡片共用 */
function RunBadge({ running }: { running: boolean }) {
  return running ? (
    <StatusBadge tone="info" pulse>
      运行中
    </StatusBadge>
  ) : (
    <StatusBadge tone="neutral">已停止</StatusBadge>
  );
}

/** 账号行下面那句提示：最近错误优先；监控跑着时才勾上的账号会在列表里但还没被带上 */
function accountNotice(
  a: Status["accounts"][number],
  monitorRunning: boolean,
): { tone: "danger" | "muted"; text: string } | null {
  if (a.lastError) return { tone: "danger", text: `最近错误：${a.lastError}` };
  if (a.backlog > 0) {
    // 监控停着就没人补；在跑的话要么等同步结束，要么下一轮接着补（上次补失败了）
    const text = !a.running
      ? `还有 ${a.backlog} 条同步期间记下的变化没补上，监控启动后补上`
      : a.syncing.length > 0
        ? `同步任务在跑（${a.syncing.join("、")}）：这里面的 ${a.backlog} 条变化先记下了，跑完自动补上`
        : `还有 ${a.backlog} 条同步期间记下的变化没补上，下一轮接着补`;
    return { tone: "muted", text };
  }
  if (monitorRunning && !a.running) return { tone: "muted", text: "启动后才加进配置，重启监控后生效" };
  return null;
}

/** 事件处理结果：deferred 是同步任务在跑、先记下等它跑完再补的 */
const EVENT_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  done: { label: "已处理", tone: "success" },
  skipped: { label: "跳过", tone: "neutral" },
  failed: { label: "失败", tone: "danger" },
  deferred: { label: "等同步", tone: "info" },
  pending: { label: "处理中", tone: "neutral" },
};

function EventBadge({ status }: { status: string }) {
  const s = EVENT_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return (
    <StatusBadge tone={s.tone} title={status}>
      {s.label}
    </StatusBadge>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}
