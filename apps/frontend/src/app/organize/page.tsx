"use client";

import * as React from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Bookmark, FolderOpen, FolderTree, History, ListChecks, Loader2, RefreshCw, Search, X } from "lucide-react";
import { toast } from "sonner";
import type { OrganizeRun } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading";
import { TreeSelectDialog } from "@/components/TreeSelectDialog";
import { FieldHint } from "@/components/field-hint";
import { api, type TaskRow } from "@/lib/api";
import { accountLabel } from "@/lib/drive";
import { apiErrorMessage } from "@/lib/axios";
import { handPicked, notifyOrganizeChanged } from "@/lib/organize";
import { AttentionList } from "./components/AttentionList";
import { HistoryDialog } from "./components/HistoryDialog";
import { MemoryDialog } from "./components/MemoryDialog";
import { RunView } from "./components/RunView";
import { toastRunError } from "./components/helpers";

const DESCRIPTION = "识别网盘里的影视文件，按 TMDB 规范命名并归到标准目录；先预览再执行，做过的能撤销";

const trimSlashes = (p: string) => p.replace(/^\/+|\/+$/g, "");

/**
 * 手输的范围换成相对任务目录的路径：以 / 开头的当网盘绝对路径，在任务目录下就去掉前缀、不在就报错；
 * 其余当相对路径。path 为空串是整个任务
 */
function toScope(input: string, originPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const raw = input.trim();
  const origin = trimSlashes(originPath);
  if (raw.startsWith("/")) {
    const abs = trimSlashes(raw);
    if (abs === origin) return { ok: true, path: "" };
    if (!origin) return { ok: true, path: abs };
    if (abs.startsWith(`${origin}/`)) return { ok: true, path: abs.slice(origin.length + 1) };
    return { ok: false, error: `「${raw}」不在任务目录 /${origin} 里；范围要在任务目录之内（也可以直接写相对路径）` };
  }
  return { ok: true, path: trimSlashes(raw.replace(/^\.\//, "")) };
}

/** 加一组范围：去重；套在别的范围里面的去掉（已经整个包含了） */
function addScopes(prev: string[], more: string[]): string[] {
  const all = [...new Set([...prev, ...more].filter(Boolean))];
  return all.filter((p) => !all.some((o) => o !== p && p.startsWith(`${o}/`)));
}

export default function OrganizePage() {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-6">
          <PageHeader icon={FolderTree} title="整理" description={DESCRIPTION} />
          <TableSkeleton rows={4} />
        </div>
      }
    >
      <OrganizeContent />
    </React.Suspense>
  );
}

function OrganizeContent() {
  const router = useRouter();
  const search = useSearchParams();
  const runId = search.get("run") ?? "";
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  /** 任务列表没读出来：和「一个任务都没有」分开说，给重试 */
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState(search.get("task") ?? "");
  /** 范围：相对任务目录的一组目录；空的是整个任务 */
  const [scopes, setScopes] = useState<string[]>(() => {
    const p = trimSlashes(search.get("path") ?? "");
    return p ? [p] : [];
  });
  /** 输入框里还没加进范围的那条 */
  const [draft, setDraft] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 这次预览跳过 TMDB 缓存（TMDB 上改了译名时用）；发起之后复位，不记忆 */
  const [refreshTmdb, setRefreshTmdb] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  const taskSelectId = useId();
  const scopeInputId = useId();
  const scopeInputRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);

  /** 读列表的回调只在挂载 / 重试时跑，闭包里的 taskId 是旧的；打开的整理可能已经把任务切过去了 */
  const taskIdRef = useRef(taskId);
  useEffect(() => {
    taskIdRef.current = taskId;
  }, [taskId]);

  const loadTasks = useCallback(() => {
    setTasksError(null);
    api.tasks
      .list()
      .then((rows) => {
        setTasks(rows);
        const cur = taskIdRef.current;
        if (cur && rows.some((t) => t.id === cur)) return;
        setTaskId(rows[0]?.id ?? "");
        if (cur) {
          // 链接里的任务已经不在了（删任务不删日志，日志页的「去整理这个目录」还指着它）：退回第一个任务，
          // 链接带来的范围是那个任务的目录，一起清掉，免得拿去预览别的任务里恰好同名的目录
          setScopes([]);
          setDraft("");
          toast.warning("链接里的任务已经不在了（可能被删了），换成了第一个任务", { id: "organize-missing-task" });
        }
      })
      .catch((err) => setTasksError(apiErrorMessage(err, "读取任务列表失败")));
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  /**
   * 去掉一个范围之后焦点落到哪：点的那个 ✕ 带着焦点一起卸载了，不接住就掉到 body 上。
   * 落到同一位置的下一个 ✕（没有就前一个），全删光了回输入框
   */
  const refocusChip = useRef<number | null>(null);
  useLayoutEffect(() => {
    const i = refocusChip.current;
    if (i === null) return;
    refocusChip.current = null;
    const buttons = chipsRef.current?.querySelectorAll<HTMLButtonElement>("button[data-remove-scope]");
    (buttons?.[Math.min(i, buttons.length - 1)] ?? scopeInputRef.current)?.focus();
  }, [scopes]);

  const task = useMemo(() => tasks?.find((t) => t.id === taskId) ?? null, [tasks, taskId]);
  const origin = task ? trimSlashes(task.originPath) : "";

  /** 打开一次整理（null 关掉）；runTaskId 是那次整理所属的任务，和当前选的不一样时顺手切过去 */
  const openRun = useCallback(
    (id: string | null, runTaskId?: string) => {
      const t = runTaskId || taskId;
      if (runTaskId && runTaskId !== taskId) {
        setTaskId(runTaskId);
        setScopes([]);
        setDraft("");
      }
      const params = new URLSearchParams();
      if (t) params.set("task", t);
      if (id) params.set("run", id);
      router.replace(`/organize${params.size ? `?${params}` : ""}`);
    },
    [router, taskId],
  );

  /** 打开的整理读到了：任务下拉框和范围切到它的（自动整理的新增路径不往范围框里填，那是另一种范围） */
  const syncFromRun = useCallback((run: OrganizeRun) => {
    setTaskId(run.taskId);
    setScopes(!handPicked(run.trigger) ? [] : run.scopePaths.length > 0 ? run.scopePaths : run.scopePath ? [run.scopePath] : []);
    setDraft("");
  }, []);

  /** 换任务：正在看的整理属于原来的任务，关掉 */
  const changeTask = (v: string) => {
    setTaskId(v);
    setScopes([]);
    setDraft("");
    if (runId) router.replace(`/organize?${new URLSearchParams({ task: v })}`);
  };

  /** 把输入框里的那条加进范围；不合法返回 null（已经提示过） */
  const takeDraft = (): string[] | null => {
    if (!draft.trim() || !task) return scopes;
    const r = toScope(draft, task.originPath);
    if (!r.ok) {
      toast.error(r.error);
      return null;
    }
    const next = r.path === "" ? [] : addScopes(scopes, [r.path]);
    setScopes(next);
    setDraft("");
    return next;
  };

  const loadUnderOrigin = useCallback(
    (p: string) => (task ? api.directory.remote(task.account, origin ? (p ? `${origin}/${p}` : origin) : p) : Promise.resolve([])),
    [task, origin],
  );

  const createRun = async () => {
    if (!taskId) return;
    const list = takeDraft();
    if (!list) return;
    setCreating(true);
    try {
      const scope = list.length > 1 ? { taskId, paths: list } : { taskId, subPath: list[0] ?? "" };
      const run = await api.organize.createRun(refreshTmdb ? { ...scope, refreshTmdb: true } : scope);
      setRefreshTmdb(false);
      openRun(run.id);
      toast.success(refreshTmdb ? "开始识别（刷新 TMDB 信息），请稍候" : "开始识别，请稍候");
      notifyOrganizeChanged();
    } catch (err) {
      toastRunError(err, "预览失败", openRun);
    } finally {
      setCreating(false);
    }
  };

  return (
    // relative z-0：RunView 里的海报背景挂在这层里面（自己是 -z-10）。用 z-0 不用 z-10，
    // 这样侧栏（fixed z-10）和顶栏（sticky z-20）还盖在它上面
    <div className="relative z-0 space-y-6">
      <PageHeader
        icon={FolderTree}
        title="整理"
        description={DESCRIPTION}
        actions={
          <>
            <Button variant="outline" onClick={() => setMemoryOpen(true)}>
              <Bookmark className="size-4" />
              识别记忆
            </Button>
            <Button variant="outline" onClick={() => setHistoryOpen(true)} disabled={!taskId}>
              <History className="size-4" />
              历史
            </Button>
          </>
        }
      />

      <section className="space-y-3 rounded-xl border bg-card p-4">
        {/*
          手机两列（范围 | 预览），md 三列（任务 | 范围 | 预览）。已选的范围在 DOM 里排在「预览」后面、单独一行挂在输入框下面，
          Tab 的顺序和看到的一样。每一格是「标签在上、控件在下」的 flex 列：「范围」那行字折行把这一行撑高时，
          两边的标签仍然顶着对齐，选择框、输入框、预览仍然底着对齐
        */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="col-span-2 flex flex-col justify-between gap-1.5 md:col-span-1">
            <label htmlFor={taskSelectId} className="text-xs font-medium text-muted-foreground">
              任务
            </label>
            {/* 没有任务时也摆着（灰掉），状态写在占位字里：控件一直是这个高度，标签也一直有个对象 */}
            <Select value={tasks?.length ? taskId : ""} onValueChange={changeTask} disabled={!tasks?.length}>
              <SelectTrigger id={taskSelectId} className="w-full">
                <SelectValue
                  placeholder={tasks === null ? (tasksError ? "读取失败" : "加载中…") : tasks.length === 0 ? "还没有任务" : "选择任务"}
                />
              </SelectTrigger>
              <SelectContent>
                {tasks?.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {accountLabel(t.account, t.accountType)} · {t.originPath} → {t.targetPath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col justify-between gap-1.5">
            <label htmlFor={scopeInputId} className="text-xs font-medium text-muted-foreground">
              范围（任务目录里的目录，可以多个；不填就是整个任务）
            </label>
            <InputGroup>
              <InputGroupInput
                id={scopeInputId}
                ref={scopeInputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    takeDraft();
                  }
                }}
                placeholder={task ? `相对 /${origin} 的路径，回车添加` : ""}
                disabled={!task}
              />
              <InputGroupButton onClick={() => setBrowsing(true)} disabled={!task} title="从任务目录里选（可以多选）">
                <FolderOpen />
              </InputGroupButton>
            </InputGroup>
          </div>
          {/* 和左边两格一样「上面一行小字、下面控件」：小字这里是「刷新 TMDB 信息」的勾选 */}
          <div className="flex flex-col items-end justify-between gap-1.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
                <Checkbox checked={refreshTmdb} onCheckedChange={(v) => setRefreshTmdb(v === true)} disabled={!task || creating} />
                刷新 TMDB 信息
              </label>
              <FieldHint>跳过缓存，重新拉每部作品的详情和季集：TMDB 上改了译名、海报时用；作品多会慢一些。</FieldHint>
            </span>
            <Button onClick={() => void createRun()} disabled={!taskId || creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              预览
            </Button>
          </div>
          {scopes.length > 0 && (
            // -mt-1.5 是 gap-3 的一半：已选的范围贴着输入框，不和上一行隔得像两组
            <div ref={chipsRef} className="col-span-2 -mt-1.5 flex flex-wrap items-center gap-1.5 md:col-span-1 md:col-start-2">
              {scopes.map((s, i) => (
                <span key={s} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-xs">
                  <span className="break-all">{s}</span>
                  <button
                    type="button"
                    data-remove-scope
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      refocusChip.current = i;
                      setScopes((prev) => prev.filter((x) => x !== s));
                    }}
                    aria-label={`去掉 ${s}`}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {scopes.length > 1 && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    refocusChip.current = 0;
                    setScopes([]);
                  }}
                >
                  清空
                </button>
              )}
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">预览只读网盘和 TMDB，不改任何东西；确认清单后点「执行」才会在网盘上改名 / 移动，本地 strm 会跟着走。</p>
      </section>

      {runId ? (
        <RunView key={runId} runId={runId} tasks={tasks} onClose={() => openRun(null)} onOpenRun={openRun} onLoaded={syncFromRun} />
      ) : tasksError ? (
        <EmptyState
          icon={FolderTree}
          title="读取任务列表失败"
          description={tasksError}
          action={
            <Button variant="outline" onClick={loadTasks}>
              <RefreshCw className="size-4" />
              重试
            </Button>
          }
        />
      ) : tasks?.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="还没有同步任务"
          description="整理按任务的网盘目录来；先到「任务」页新建一个。"
          action={
            <Button asChild variant="outline">
              <Link href="/home">去任务页</Link>
            </Button>
          }
        />
      ) : (
        <>
          <AttentionList tasks={tasks} onOpen={(run) => openRun(run.id, run.taskId)} />
          <EmptyState icon={FolderTree} title="还没有预览" description="选好任务和范围，点「预览」；或者从「历史」里打开之前的整理记录。" />
        </>
      )}

      {task && (
        <TreeSelectDialog
          open={browsing}
          onOpenChange={setBrowsing}
          title="选择范围"
          description={<>从任务目录 /{origin} 里选，可以多选；一个都不选就是整个任务</>}
          load={loadUnderOrigin}
          multiple
          onConfirmMany={(paths) => setScopes((prev) => addScopes(prev, paths.map(trimSlashes)))}
        />
      )}
      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        taskId={taskId}
        onPick={(id) => {
          setHistoryOpen(false);
          openRun(id);
        }}
      />
      <MemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} />
    </div>
  );
}
