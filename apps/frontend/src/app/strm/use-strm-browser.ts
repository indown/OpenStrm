"use client";

/**
 * strm 管理页的浏览状态。URL 是唯一真源：
 *
 *   /strm                              全部任务：每个任务根目录那一层，按任务分组（只有一个任务时直接进它）
 *   /strm?taskId=…&path=Show/Season 1  一个任务里的某个目录
 *
 * 进目录 = router.push，浏览器后退就是回上一级；体检结果里的"打开所在目录"也只是改 URL。
 * 每一行都带着自己是哪个任务的（taskId）：看全部任务时一页里有好几个任务的条目，
 * 列目录、搜索、媒体信息、删除都按任务各发各的。
 * 删除走一个页面级的确认弹框：五个入口（选择栏 / 行 / 详情 / 体检 / 校验）都 await requestDelete，
 * 拿到结果自己收拾自己的列表。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { MediaBrief, StrmDeleteResult, StrmEntry, StrmListResult, StrmSearchResult } from "@openstrm/shared";
import { api, type TaskRow } from "@/lib/api";
import { mapLimit } from "@/lib/async";
import { apiErrorMessage } from "@/lib/axios";
import { DELETE_CHUNK, joinPath, parentOf, strmErrorMessage } from "@/lib/strm";
import { distinctRoots, refKey, refOfKey, rootKey, type StrmRef } from "@/lib/strm-entries";

/** 一行条目：哪个任务（taskId）下的哪条路径（path），key 是两者拼的键 */
export type StrmRow = StrmEntry & StrmRef & { key: string };
export type BrowseMode = "browse" | "search";
export type DeleteRequest = { refs: StrmRef[]; label: string };

/** 全部任务里一组（一个任务根）列得怎么样 */
export interface GroupState {
  /** 本地目录还不存在：任务没跑过 */
  missing: boolean;
  /** 这一组没列成的原因；列成了是 null */
  error: string | null;
}

/** 全部任务时同时列 / 搜几个任务：任务多了也别一下子把连接占满 */
const LIST_CONCURRENCY = 4;
const SEARCH_CONCURRENCY = 3;

const NO_TASKS: TaskRow[] = [];
const NO_GROUPS: ReadonlyMap<string, GroupState> = new Map();

type Listed = { task: TaskRow; res: StrmListResult } | { task: TaskRow; error: string };
type Searched = { taskId: string; res: StrmSearchResult } | { taskId: string; error: string };

/** 去掉首尾斜杠和空段，URL 里手改成 `/a//b/` 也能对上后端的归一化 */
function normalizePath(p: string): string {
  return p.split("/").filter(Boolean).join("/");
}

function isUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(`${dir}/`);
}

const toRow = (taskId: string, path: string, entry: StrmEntry): StrmRow => ({ ...entry, taskId, path, key: refKey(taskId, path) });

/** 按任务分堆，任务的先后照第一次出现的顺序 */
function byTask<T extends StrmRef>(refs: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const ref of refs) {
    const list = out.get(ref.taskId);
    if (list) list.push(ref);
    else out.set(ref.taskId, [ref]);
  }
  return out;
}

export function useStrmBrowser() {
  const router = useRouter();
  const params = useSearchParams();
  const taskId = params.get("taskId") ?? "";
  // 全部任务没有「当前目录」：地址里手写了 path 也不认
  const path = taskId ? normalizePath(params.get("path") ?? "") : "";

  /* ------------------------------ 任务 ------------------------------ */
  // null = 还没拿到；拿失败了 tasksError 有值
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const task = useMemo(() => tasks?.find((t) => t.id === taskId), [tasks, taskId]);
  const taskOf = useCallback((id: string) => tasks?.find((t) => t.id === id), [tasks]);

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

  /** 任务不止一个才有「全部任务」这一层；只有一个时「全部」就是它 */
  const hasAll = (tasks?.length ?? 0) > 1;
  /** 正在看全部任务：地址里没带任务 */
  const allScope = !taskId && hasAll;
  /** 全部任务里的各组：共用同一个本地目录的几个任务只算第一个。不在看全部时是同一个空数组，别让任务表一回来就把单任务的目录重拉一遍 */
  const owners = useMemo(() => (allScope && tasks ? distinctRoots(tasks) : NO_TASKS), [allScope, tasks]);

  /* ------------------------------ 导航 ------------------------------ */
  /** taskId 给空串是回到全部任务 */
  const go = useCallback(
    (next: { taskId?: string; path?: string }, replace = false) => {
      const nextTask = next.taskId ?? taskId;
      // 换任务时目录从根开始，除非明确给了 path；全部任务没有目录
      const nextPath = nextTask ? normalizePath(next.path ?? (nextTask !== taskId ? "" : path)) : "";
      const sp = new URLSearchParams();
      if (nextTask) sp.set("taskId", nextTask);
      if (nextPath) sp.set("path", nextPath);
      const url = sp.size > 0 ? `/strm?${sp.toString()}` : "/strm";
      if (replace) router.replace(url);
      else router.push(url);
    },
    [router, taskId, path],
  );

  // 只有一个任务、又没带 taskId 进来：直接进它；replace 免得后退又回到这个空页
  useEffect(() => {
    if (tasks && tasks.length === 1 && !taskId) go({ taskId: tasks[0].id, path: "" }, true);
  }, [tasks, taskId, go]);

  const segments = useMemo(() => path.split("/").filter(Boolean), [path]);

  /* ------------------------------ 目录内容 ------------------------------ */
  const [entries, setEntries] = useState<StrmRow[]>([]);
  const [groupStates, setGroupStates] = useState<ReadonlyMap<string, GroupState>>(NO_GROUPS);
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

  /** 问过媒体信息的 strm（行键，见下面「媒体信息」）；在这里声明是因为 load 要清它 */
  const mediaAsked = useRef(new Set<string>());

  const load = useCallback(async () => {
    // 全部任务要等任务表回来才知道列谁
    if (!taskId && owners.length === 0) return;
    const seq = ++seqRef.current;
    // 重新拉目录（刷新、换目录）：问过的媒体信息忘掉，列出来再问一遍——整理页探过 / Emby 回填过的这时才会出现
    mediaAsked.current = new Set();
    setLoading(true);
    setRefreshing(true);
    // 屏幕上还有内容就只弹提示；什么都没有才换成错误占位
    const fail = (msg: string) => {
      if (entriesRef.current.length === 0) setError(msg);
      else toast.error(msg);
    };
    try {
      if (taskId) {
        const res = await api.strm.list(taskId, path);
        if (seq !== seqRef.current) return;
        setEntries(res.entries.map((e) => toRow(taskId, joinPath(path, e.name), e)));
        setGroupStates(NO_GROUPS);
        setError(null);
        return;
      }
      const listed = await mapLimit(owners, LIST_CONCURRENCY, async (t): Promise<Listed> => {
        try {
          return { task: t, res: await api.strm.list(t.id, "") };
        } catch (err) {
          return { task: t, error: apiErrorMessage(err, "读取目录失败") };
        }
      });
      if (seq !== seqRef.current) return;
      const roots = new Set(owners.map((t) => rootKey(t.targetPath)));
      const rows: StrmRow[] = [];
      const states = new Map<string, GroupState>();
      let firstError: string | null = null;
      for (const part of listed) {
        if ("error" in part) {
          states.set(part.task.id, { missing: false, error: part.error });
          firstError ??= part.error;
          continue;
        }
        states.set(part.task.id, { missing: !part.res.exists, error: null });
        const base = rootKey(part.task.targetPath);
        for (const e of part.res.entries) {
          // 嵌在这个任务根里面的别的任务根：它自己有一组，这里不重复列
          if (e.isDir && roots.has(joinPath(base, e.name))) continue;
          rows.push(toRow(part.task.id, e.name, e));
        }
      }
      setEntries(rows);
      setGroupStates(states);
      // 一组都没列成才算整页失败；只坏了几组的在各自的组里说
      if (firstError !== null && states.size > 0 && [...states.values()].every((s) => s.error !== null)) fail(firstError);
      else setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      fail(apiErrorMessage(err, "读取目录失败"));
    } finally {
      if (seq === seqRef.current) {
        setLoaded(true);
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [taskId, path, owners]);

  /* ------------------------------ 筛选 / 搜索 ------------------------------ */
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<BrowseMode>("browse");
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<StrmRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchSeqRef = useRef(0);

  /* ------------------------------ 多选 ------------------------------ */
  // 里面是行键
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 换任务 / 换目录：勾选、筛选、搜索都清掉，再拉新目录
  useEffect(() => {
    setSelected(new Set());
    setQuery("");
    setMode("browse");
    setResults([]);
    setEntries([]);
    setGroupStates(NO_GROUPS);
    setError(null);
    void load();
  }, [load]);

  /** term 省略时搜输入框里那个词；命令面板交接过来时直接把词传进来，不用等 setQuery 生效 */
  const runSearch = useCallback(
    async (term?: string) => {
      const q = (term ?? query).trim();
      const targets = taskId ? [taskId] : owners.map((t) => t.id);
      if (!q || targets.length === 0) return;
      const seq = ++searchSeqRef.current;
      setSearching(true);
      try {
        const parts = await mapLimit(targets, SEARCH_CONCURRENCY, async (id): Promise<Searched> => {
          try {
            return { taskId: id, res: await api.strm.search(id, q) };
          } catch (err) {
            return { taskId: id, error: strmErrorMessage(err, "搜索失败") };
          }
        });
        if (seq !== searchSeqRef.current) return;
        const failed = parts.flatMap((p) => ("error" in p ? [p.error] : []));
        if (failed.length === parts.length) {
          toast.error(failed[0]);
          return;
        }
        if (failed.length > 0) toast.warning(`${failed.length} 个任务没搜成，结果不全：${failed[0]}`);
        // 响应里没有 hits（代理返了别的东西、响应被截断）时也要活着：
        // 直接塞进去会让筛选那一步在 undefined 上 .filter，整页掉进错误边界，
        // 而这本来只该是一句"没搜到"
        setResults(parts.flatMap((p) => ("res" in p && Array.isArray(p.res.hits) ? p.res.hits.map((h) => toRow(p.taskId, h.path, h)) : [])));
        setTruncated(parts.some((p) => "res" in p && p.res.truncated === true));
        setSearchTerm(q);
        setMode("search");
        setSelected(new Set());
      } finally {
        if (seq === searchSeqRef.current) setSearching(false);
      }
    },
    [query, taskId, owners],
  );

  // 命令面板用 /strm?taskId=…&q=… 交接过来：进来就直接搜，然后把 q 从地址里抹掉，
  // 免得后退 / 刷新又搜一遍。抹掉之后这个 effect 自己就停了
  const seedQuery = params.get("q") ?? "";
  useEffect(() => {
    if (!seedQuery || (!taskId && owners.length === 0)) return;
    setQuery(seedQuery);
    void runSearch(seedQuery);
    const sp = new URLSearchParams();
    if (taskId) sp.set("taskId", taskId);
    if (path) sp.set("path", path);
    router.replace(sp.size > 0 ? `/strm?${sp.toString()}` : "/strm");
  }, [seedQuery, taskId, path, owners, router, runSearch]);

  const exitSearch = useCallback(() => {
    searchSeqRef.current++;
    setMode("browse");
    setResults([]);
    setTruncated(false);
    setQuery("");
    setSelected(new Set());
  }, []);

  /** 没筛过的那一批：搜索结果或当前目录。网格视图拿它的身份判断「换了一批条目」 */
  const base = mode === "search" ? results : entries;

  /** 当前显示的列表：再按输入框的字做一遍名字筛选 */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? base.filter((e) => e.name.toLowerCase().includes(q)) : base;
  }, [base, query]);

  /* ------------------------------ 媒体信息 ------------------------------ */
  // 列出来的 strm 按 200 一批问一次实测媒体信息（整理页探测过或 Emby 回填过的才有）。问成了的按行键记着不重复问，
  // 在问的也记着（筛一下、列表变一下不会重复发），没问成的（超时、5xx）下次列到再问；换任务全忘掉，换目录 / 刷新在 load 里忘掉。
  // 旗标只是锦上添花，拿不到就不画，不报错。用 Map 不用对象：根目录下条目的路径就是名字，叫 constructor 的目录会撞上对象原型
  const [media, setMedia] = useState<ReadonlyMap<string, MediaBrief>>(() => new Map());
  const mediaPending = useRef(new Set<string>());
  const mediaScope = useRef(taskId);
  useEffect(() => {
    mediaScope.current = taskId;
    mediaAsked.current = new Set();
    mediaPending.current = new Set();
    setMedia(new Map());
  }, [taskId]);
  useEffect(() => {
    const want = visible.filter((e) => !e.isDir && e.kind === "strm" && !mediaAsked.current.has(e.key) && !mediaPending.current.has(e.key));
    if (want.length === 0) return;
    for (const row of want) mediaPending.current.add(row.key);
    const scope = taskId;
    void (async () => {
      for (const [id, rows] of byTask(want)) {
        for (let i = 0; i < rows.length; i += 200) {
          const batch = rows.slice(i, i + 200);
          try {
            const res = await api.strm.media(id, batch.map((r) => r.path));
            if (mediaScope.current !== scope) return;
            for (const row of batch) mediaAsked.current.add(row.key);
            const got = batch.flatMap((row) => (Object.hasOwn(res.media, row.path) ? [[row.key, res.media[row.path]] as const] : []));
            if (got.length > 0) setMedia((m) => new Map([...m, ...got]));
          } catch {
            /* 没有旗标而已；下次列到再问 */
          } finally {
            for (const row of batch) mediaPending.current.delete(row.key);
          }
        }
      }
    })();
  }, [taskId, visible]);

  const allSelected = visible.length > 0 && visible.every((e) => selected.has(e.key));

  const toggleOne = useCallback((key: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (on: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const e of visible) {
          if (on) next.add(e.key);
          else next.delete(e.key);
        }
        return next;
      });
    },
    [visible],
  );

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  /** 勾着的那些行（按列出来的顺序）；被输入框筛掉、眼下看不见的也算——勾选数是按它们一起数的 */
  const selectedRefs = useMemo(() => base.filter((e) => selected.has(e.key)).map((e) => ({ taskId: e.taskId, path: e.path })), [base, selected]);

  /* ------------------------------ 路径怎么写给人看 ------------------------------ */
  /** 看全部任务时前面带上任务的本地目录（相对数据目录），不然几个任务里同名的分不清 */
  const displayPath = useCallback(
    (ref: StrmRef) => (allScope ? joinPath(rootKey(taskOf(ref.taskId)?.targetPath ?? ""), ref.path) : ref.path),
    [allScope, taskOf],
  );

  /* ------------------------------ 删除 ------------------------------ */
  const [deleteTarget, setDeleteTarget] = useState<DeleteRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const resolverRef = useRef<((r: StrmDeleteResult | null) => void) | null>(null);

  const settle = useCallback((r: StrmDeleteResult | null) => {
    resolverRef.current?.(r);
    resolverRef.current = null;
    setDeleteTarget(null);
  }, []);

  /** 结果里 failed 的 path 是相对各自任务的；一次只删一个任务的（弹框、单行）才拿它对账 */
  const requestDelete = useCallback(
    (refs: StrmRef[], label: string): Promise<StrmDeleteResult | null> => {
      if (refs.some((r) => r.path === "")) toast.error("不能删除任务根目录");
      const seen = new Set<string>();
      const list: StrmRef[] = [];
      for (const r of refs) {
        const key = refKey(r.taskId, r.path);
        if (r.path === "" || seen.has(key)) continue;
        seen.add(key);
        list.push({ taskId: r.taskId, path: r.path });
      }
      if (list.length === 0) return Promise.resolve(null);
      // 上一个还没答复的请求当作取消
      settle(null);
      return new Promise<StrmDeleteResult | null>((resolve) => {
        resolverRef.current = resolve;
        setDeleteTarget({ refs: list, label });
      });
    },
    [settle],
  );

  const cancelDelete = useCallback(() => settle(null), [settle]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // 校验出来的缺失项可能上千，一次发不完：按任务分批发，中途断了也把已经删掉的算数
      const res: StrmDeleteResult = { deleted: 0, failed: [] };
      const removed: StrmRef[] = [];
      let broke: string | null = null;
      for (const [id, refs] of byTask(deleteTarget.refs)) {
        const paths = refs.map((r) => r.path);
        for (let i = 0; i < paths.length; i += DELETE_CHUNK) {
          const batch = paths.slice(i, i + DELETE_CHUNK);
          if (broke === null) {
            try {
              const part = await api.strm.remove(id, batch);
              res.deleted += part.deleted;
              res.failed.push(...part.failed);
              const bad = new Set(part.failed.map((f) => f.path));
              for (const p of batch) if (!bad.has(p)) removed.push({ taskId: id, path: p });
              continue;
            } catch (err) {
              broke = strmErrorMessage(err, "删除失败");
            }
          }
          // 这一批和后面没发出去的都算没删掉，调用方才不会把它们从自己的列表里划掉
          for (const p of batch) res.failed.push({ path: p, message: broke });
        }
      }
      const gone = (r: StrmRef) => removed.some((x) => x.taskId === r.taskId && isUnder(r.path, x.path));
      setEntries((prev) => prev.filter((e) => !gone(e)));
      setResults((prev) => prev.filter((e) => !gone(e)));
      setSelected((prev) => new Set([...prev].filter((key) => !gone(refOfKey(key)))));
      if (res.deleted > 0) toast.success(`已删除 ${res.deleted} 项`);
      if (res.failed.length > 0) {
        const first = res.failed[0];
        toast.error(`${res.failed.length} 项删除失败：${first.path}（${first.message}）`);
      }
      settle(res);
      // 正在看的目录（或它的上级）被删了：退回到还在的那一层；否则原地刷新
      const hit = taskId ? removed.find((r) => r.taskId === taskId && isUnder(path, r.path)) : undefined;
      if (hit) go({ path: parentOf(hit.path) });
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
    taskOf,
    hasAll,
    allScope,
    owners,
    groupStates,
    entries,
    base,
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
    selectedRefs,
    allSelected,
    toggleOne,
    toggleAll,
    clearSelection,
    go,
    displayPath,
    requestDelete,
    deleteTarget,
    deleting,
    cancelDelete,
    confirmDelete,
  };
}

export type StrmBrowser = ReturnType<typeof useStrmBrowser>;
