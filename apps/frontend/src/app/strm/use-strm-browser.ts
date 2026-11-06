"use client";

/**
 * strm 管理页的浏览状态。URL 是唯一真源：`/strm?taskId=…&path=Show/Season 1`，
 * 进目录 = router.push，浏览器后退就是回上一级；体检结果里的"打开所在目录"也只是改 URL。
 * 删除走一个页面级的确认弹框：五个入口（选择栏 / 行 / 详情 / 体检 / 校验）都 await requestDelete，
 * 拿到结果自己收拾自己的列表。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { MediaBrief, StrmDeleteResult, StrmEntry } from "@openstrm/shared";
import { api, type TaskRow } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { DELETE_CHUNK, joinPath, parentOf, strmErrorMessage, type RequestDelete } from "@/lib/strm";

export type StrmRow = StrmEntry & { path: string };
export type BrowseMode = "browse" | "search";
export type DeleteRequest = { paths: string[]; label: string };

/** 去掉首尾斜杠和空段，URL 里手改成 `/a//b/` 也能对上后端的归一化 */
function normalizePath(p: string): string {
  return p.split("/").filter(Boolean).join("/");
}

function isUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(`${dir}/`);
}

export function useStrmBrowser() {
  const router = useRouter();
  const params = useSearchParams();
  const taskId = params.get("taskId") ?? "";
  const path = normalizePath(params.get("path") ?? "");

  /* ------------------------------ 任务 ------------------------------ */
  // null = 还没拿到；拿失败了 tasksError 有值
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const task = useMemo(() => tasks?.find((t) => t.id === taskId), [tasks, taskId]);

  const loadTasks = useCallback(async () => {
    try {
      setTasksError(null);
      const rows = await api.tasks.list();
      setTasks(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setTasksError(apiErrorMessage(err, "读取任务列表失败"));
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  /* ------------------------------ 导航 ------------------------------ */
  const go = useCallback(
    (next: { taskId?: string; path?: string }, replace = false) => {
      const nextTask = next.taskId ?? taskId;
      // 换任务时目录从根开始，除非明确给了 path
      const nextPath = normalizePath(next.path ?? (next.taskId && next.taskId !== taskId ? "" : path));
      const sp = new URLSearchParams();
      if (nextTask) sp.set("taskId", nextTask);
      if (nextPath) sp.set("path", nextPath);
      const url = sp.size > 0 ? `/strm?${sp.toString()}` : "/strm";
      if (replace) router.replace(url);
      else router.push(url);
    },
    [router, taskId, path],
  );

  // 没带 taskId 进来：默认第一个任务；replace 免得后退又回到这个空页
  useEffect(() => {
    if (tasks && tasks.length > 0 && !taskId) go({ taskId: tasks[0].id, path: "" }, true);
  }, [tasks, taskId, go]);

  const segments = useMemo(() => path.split("/").filter(Boolean), [path]);

  /* ------------------------------ 目录内容 ------------------------------ */
  const [entries, setEntries] = useState<StrmRow[]>([]);
  const [exists, setExists] = useState(true);
  // 只有首次加载显示骨架；之后换目录时列表区域转圈，刷新时按钮转圈
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const entriesRef = useRef<StrmRow[]>([]);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const load = useCallback(async () => {
    if (!taskId) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setRefreshing(true);
    try {
      const res = await api.strm.list(taskId, path);
      if (seq !== seqRef.current) return;
      setEntries(res.entries.map((e) => ({ ...e, path: joinPath(path, e.name) })));
      setExists(res.exists);
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      const msg = apiErrorMessage(err, "读取目录失败");
      // 屏幕上还有内容就只弹提示；什么都没有才换成错误占位
      if (entriesRef.current.length === 0) setError(msg);
      else toast.error(msg);
    } finally {
      if (seq === seqRef.current) {
        setLoaded(true);
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [taskId, path]);

  /* ------------------------------ 筛选 / 搜索 ------------------------------ */
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<BrowseMode>("browse");
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<StrmRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchSeqRef = useRef(0);

  /* ------------------------------ 多选 ------------------------------ */
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 换任务 / 换目录：勾选、筛选、搜索都清掉，再拉新目录
  useEffect(() => {
    setSelected(new Set());
    setQuery("");
    setMode("browse");
    setResults([]);
    setEntries([]);
    setError(null);
    void load();
  }, [load]);

  /** term 省略时搜输入框里那个词；命令面板交接过来时直接把词传进来，不用等 setQuery 生效 */
  const runSearch = useCallback(async (term?: string) => {
    const q = (term ?? query).trim();
    if (!q || !taskId) return;
    const seq = ++searchSeqRef.current;
    setSearching(true);
    try {
      const res = await api.strm.search(taskId, q);
      if (seq !== searchSeqRef.current) return;
      // 响应里没有 hits（代理返了别的东西、响应被截断）时也要活着：
      // 直接塞进去会让筛选那一步在 undefined 上 .filter，整页掉进错误边界，
      // 而这本来只该是一句"没搜到"
      setResults(Array.isArray(res.hits) ? res.hits : []);
      setTruncated(res.truncated === true);
      setSearchTerm(q);
      setMode("search");
      setSelected(new Set());
    } catch (err) {
      if (seq !== searchSeqRef.current) return;
      toast.error(strmErrorMessage(err, "搜索失败"));
    } finally {
      if (seq === searchSeqRef.current) setSearching(false);
    }
  }, [query, taskId]);

  // 命令面板用 /strm?taskId=…&q=… 交接过来：进来就直接搜，然后把 q 从地址里抹掉，
  // 免得后退 / 刷新又搜一遍。抹掉之后这个 effect 自己就停了
  const seedQuery = params.get("q") ?? "";
  useEffect(() => {
    if (!seedQuery || !taskId) return;
    setQuery(seedQuery);
    void runSearch(seedQuery);
    const sp = new URLSearchParams();
    sp.set("taskId", taskId);
    if (path) sp.set("path", path);
    router.replace(`/strm?${sp.toString()}`);
  }, [seedQuery, taskId, path, router, runSearch]);

  const exitSearch = useCallback(() => {
    searchSeqRef.current++;
    setMode("browse");
    setResults([]);
    setTruncated(false);
    setQuery("");
    setSelected(new Set());
  }, []);

  /** 当前显示的列表：搜索结果或当前目录，再按输入框的字做一遍名字筛选 */
  const visible = useMemo(() => {
    const base = mode === "search" ? results : entries;
    const q = query.trim().toLowerCase();
    return q ? base.filter((e) => e.name.toLowerCase().includes(q)) : base;
  }, [mode, results, entries, query]);

  /* ------------------------------ 媒体信息 ------------------------------ */
  // 列出来的 strm 按 200 一批问一次实测媒体信息（整理页探测过或 Emby 回填过的才有），按路径记着不重复问；
  // 旗标只是锦上添花，拿不到就不画，不报错
  const [media, setMedia] = useState<Record<string, MediaBrief>>({});
  const mediaAsked = useRef(new Set<string>());
  useEffect(() => {
    mediaAsked.current = new Set();
    setMedia({});
  }, [taskId]);
  useEffect(() => {
    if (!taskId) return;
    const want = visible.filter((e) => !e.isDir && e.kind === "strm" && !mediaAsked.current.has(e.path)).map((e) => e.path);
    if (want.length === 0) return;
    for (const p of want) mediaAsked.current.add(p);
    let alive = true;
    void (async () => {
      for (let i = 0; i < want.length; i += 200) {
        try {
          const res = await api.strm.media(taskId, want.slice(i, i + 200));
          if (!alive) return;
          if (Object.keys(res.media).length > 0) setMedia((m) => ({ ...m, ...res.media }));
        } catch {
          /* 没有旗标而已 */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [taskId, visible]);

  const allSelected = visible.length > 0 && visible.every((e) => selected.has(e.path));

  const toggleOne = useCallback((p: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (on: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const e of visible) {
          if (on) next.add(e.path);
          else next.delete(e.path);
        }
        return next;
      });
    },
    [visible],
  );

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  /* ------------------------------ 删除 ------------------------------ */
  const [deleteTarget, setDeleteTarget] = useState<DeleteRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const resolverRef = useRef<((r: StrmDeleteResult | null) => void) | null>(null);

  const settle = useCallback((r: StrmDeleteResult | null) => {
    resolverRef.current?.(r);
    resolverRef.current = null;
    setDeleteTarget(null);
  }, []);

  const requestDelete = useCallback<RequestDelete>(
    (paths, label) => {
      if (paths.some((p) => p === "")) toast.error("不能删除任务根目录");
      const list = [...new Set(paths.filter((p) => p !== ""))];
      if (list.length === 0) return Promise.resolve(null);
      // 上一个还没答复的请求当作取消
      settle(null);
      return new Promise<StrmDeleteResult | null>((resolve) => {
        resolverRef.current = resolve;
        setDeleteTarget({ paths: list, label });
      });
    },
    [settle],
  );

  const cancelDelete = useCallback(() => settle(null), [settle]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !taskId) return;
    setDeleting(true);
    try {
      // 校验出来的缺失项可能上千，一次发不完：分批发，中途断了也把已经删掉的算数
      const res: StrmDeleteResult = { deleted: 0, failed: [] };
      const sent: string[] = [];
      let broke = false;
      for (let i = 0; i < deleteTarget.paths.length && !broke; i += DELETE_CHUNK) {
        const batch = deleteTarget.paths.slice(i, i + DELETE_CHUNK);
        try {
          const part = await api.strm.remove(taskId, batch);
          res.deleted += part.deleted;
          res.failed.push(...part.failed);
          sent.push(...batch);
        } catch (err) {
          // 这一批和后面没发出去的都算没删掉，调用方才不会把它们从自己的列表里划掉
          const msg = strmErrorMessage(err, "删除失败");
          for (const p of deleteTarget.paths.slice(i)) res.failed.push({ path: p, message: msg });
          broke = true;
        }
      }
      const failed = new Set(res.failed.map((f) => f.path));
      const removed = sent.filter((p) => !failed.has(p));
      const gone = (p: string) => removed.some((r) => isUnder(p, r));
      setEntries((prev) => prev.filter((e) => !gone(e.path)));
      setResults((prev) => prev.filter((e) => !gone(e.path)));
      setSelected((prev) => new Set([...prev].filter((p) => !gone(p))));
      if (res.deleted > 0) toast.success(`已删除 ${res.deleted} 项`);
      if (res.failed.length > 0) {
        const first = res.failed[0];
        toast.error(`${res.failed.length} 项删除失败：${first.path}（${first.message}）`);
      }
      settle(res);
      // 正在看的目录（或它的上级）被删了：退回到还在的那一层；否则原地刷新
      const hit = removed.find((r) => isUnder(path, r));
      if (hit) go({ path: parentOf(hit) });
      else void load();
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, taskId, path, settle, go, load]);

  return {
    taskId,
    path,
    segments,
    task,
    tasks,
    tasksError,
    reloadTasks: loadTasks,
    entries,
    exists,
    visible,
    media,
    loaded,
    loading,
    refreshing,
    error,
    refresh: load,
    query,
    setQuery,
    mode,
    searchTerm,
    runSearch,
    exitSearch,
    truncated,
    searching,
    selected,
    allSelected,
    toggleOne,
    toggleAll,
    clearSelection,
    go,
    requestDelete,
    deleteTarget,
    deleting,
    cancelDelete,
    confirmDelete,
  };
}

export type StrmBrowser = ReturnType<typeof useStrmBrowser>;
