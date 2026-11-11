"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, type DirectoryNode, type OfflineAddResult, type TaskRow } from "@/lib/api";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";
import { DirectoryPickerDialog } from "@/components/DirectoryPickerDialog";
import { splitOfflineLinks } from "@/lib/offline";
import { layerAccountStatus } from "@/lib/mount-layer";
import { copyLayer, normTargetDir } from "@/lib/openlist-copy";

type Mode = "task" | "dir";

interface AddOfflineTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 默认往哪个 115 账号加 */
  account: string;
  /** 能选的 115 账号：不止一个时框里给个选择，换了只换目标目录那一块，已经贴好的链接不动 */
  accounts?: string[];
  /**
   * 至少加成功一条时回调，带着加成功的那几条链接和用的账号（框里可能另选了账号：云下载页据此把列表切过去，
   * 不然刚加的在别的账号下、看着像没加上；搜索页只去掉这几条的勾选）
   */
  onAdded: (addedUrls: string[], account: string) => void;
  /** 打开时预填的链接（资源搜索页、顶栏带过来的磁力）；挤在一行里的几条会拆成一行一条 */
  initialUrls?: string;
}

/**
 * 添加云下载任务。目标位置二选一：
 *   - 同步任务的目录（可进子目录）：下载完成后由后端自动为产物生成 strm
 *   - 任意网盘目录：只是下载，不管 strm
 */
export function AddOfflineTaskDialog({ open, onOpenChange, account: defaultAccount, accounts, onAdded, initialUrls }: AddOfflineTaskDialogProps) {
  /** 这次在框里另选的账号；关了就忘，下次打开还是调用方给的那个 */
  const [picked, setPicked] = useState<string | null>(null);
  const account = picked ?? defaultAccount;
  const [urls, setUrls] = useState("");
  const [mode, setMode] = useState<Mode>("task");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [subSegments, setSubSegments] = useState<string[]>([]);
  const [subdirs, setSubdirs] = useState<DirectoryNode[]>([]);
  const [subdirLoading, setSubdirLoading] = useState(false);
  const [generateStrm, setGenerateStrm] = useState(true);
  /** 空串 = 交给 115 的默认目录；"0" = 根目录 */
  const [dirId, setDirId] = useState("");
  const [dirPath, setDirPath] = useState("");
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<OfflineAddResult[] | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [copyToOpenlist, setCopyToOpenlist] = useState(false);
  /** 复制用的那一家（OpenList 或 CD2）选了账号、这个 115 在它里面填了路径才显示勾选框：它的账号和默认目标目录；null = 没配置或还没查到 */
  const [copySetup, setCopySetup] = useState<{ account: string; dstDir: string } | null>(null);
  /** 相对设置页 dstDir 已进入的子目录段：这次复制到 dstDir/…segments */
  const [copySegments, setCopySegments] = useState<string[]>([]);
  const [copySubdirs, setCopySubdirs] = useState<DirectoryNode[]>([]);
  const [copySubdirLoading, setCopySubdirLoading] = useState(false);

  // 每次打开，链接回到预填的（没有就清空）；关上时忘掉框里另选的账号
  useEffect(() => {
    if (!open) {
      setPicked(null);
      return;
    }
    setUrls(splitOfflineLinks(initialUrls ?? ""));
    setResults(null);
    setInvalid([]);
  }, [open, initialUrls]);

  // 打开、换账号时目标目录那一块从头来：回到任务目录，重新拉这个账号的任务和 115 的默认目录。
  // 上一个账号的任务先清掉：新列表回来之前（或者读失败了）不能还挂着、还能选；上一个账号的失败清单也清掉，
  // 留着会让人以为是这个账号加失败的
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTasks([]);
    setResults(null);
    setInvalid([]);
    setSubSegments([]);
    setDirId("");
    setDirPath("");
    setGenerateStrm(true);
    setCopyToOpenlist(false);
    setCopySegments([]);
    setCopySetup(null);
    Promise.all([api.settings.get(), api.accounts.list().catch(() => null)])
      .then(([s, accountList]) => {
        if (cancelled) return;
        // 复制用的那一家（引擎是 CD2 就是 CD2 账号和它那份路径）：选的账号得还在账户页里（删了的话勾上也复制不了，
        // 选子目录还会列个空），这个 115 账号得在它里面填了路径，后端才算得出产物在挂载层里的位置；
        // 默认目标目录可以空着（任务上可能填了）。账号表读不到就只看设置，提交时后端还会核对
        const layer = copyLayer(s.openlistCopy, s.cd2);
        if (!layerAccountStatus(accountList, layer.engine, layer.account).usable || !layer.mounts[account]?.trim()) return;
        setCopySetup({ account: layer.account, dstDir: normTargetDir(s.openlistCopy?.dstDir) });
      })
      .catch(() => {});
    setTasksLoading(true);
    api.tasks
      .list()
      .then((rows) => {
        if (cancelled) return;
        const mine = rows.filter((t) => t.account === account);
        setTasks(mine);
        setTaskId((prev) => (prev && mine.some((t) => t.id === prev) ? prev : (mine[0]?.id ?? "")));
        setMode(mine.length > 0 ? "task" : "dir");
      })
      .catch((err) => {
        if (!cancelled) toast.error(apiErrorMessage(err, "加载任务列表失败"));
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    api.offline
      .downPaths(account)
      .then((r) => {
        if (cancelled) return;
        setDefaultDir(r.dirs.find((d) => d.selected)?.name ?? r.dirs[0]?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setDefaultDir(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, account]);

  // 只认这个账号的任务：带着任务 id 提交时后端按任务自己的账号走，框里显示的账号和实际加进去的不能对不上
  const selectedTask = useMemo(() => tasks.find((t) => t.id === taskId && t.account === account), [tasks, taskId, account]);
  /**
   * 复制到哪：任务目录模式按任务自己的目标目录（没填才用设置页的默认值），和后端 addOfflineTasks 一个规则；
   * 任务开着「复制到 OpenList」时不用勾也会复制，勾选框就锁成勾上
   */
  const taskCopy = mode === "task" ? selectedTask?.copyToOpenlist : undefined;
  const taskCopies = taskCopy?.enabled === true;
  // OpenList 根 / 算没填（和后端同一条规则）
  const copyBase = (mode === "task" ? normTargetDir(taskCopy?.dstDir) : "") || (copySetup?.dstDir ?? "");
  const copying = Boolean(copySetup) && (taskCopies || copyToOpenlist);
  const copyTarget = [copyBase, ...copySegments].join("/");
  // 子目录请求只跟任务 id 和路径走，不跟任务对象的引用走（和 SaveToDriveDialog 一个道理）
  const taskAccount = selectedTask?.account;
  const taskOriginPath = selectedTask?.originPath;

  useEffect(() => {
    if (!open || mode !== "task" || !taskId || taskAccount == null || taskOriginPath == null) return;
    let cancelled = false;
    const fullPath = subSegments.length ? `${taskOriginPath}/${subSegments.join("/")}` : taskOriginPath;
    setSubdirLoading(true);
    api.directory
      .remote(taskAccount, fullPath)
      .then((dirs) => {
        if (!cancelled) setSubdirs(dirs ?? []);
      })
      .catch(() => {
        if (!cancelled) setSubdirs([]);
      })
      .finally(() => {
        if (!cancelled) setSubdirLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, taskId, taskAccount, taskOriginPath, subSegments]);

  // 复制目的地浏览：要复制时从上面算好的目标目录出发，在复制用的那一家（OpenList / CD2 账号）里列子目录
  const copyAccount = copySetup?.account;
  useEffect(() => {
    if (!open || !copying || !copyBase || !copyAccount) return;
    let cancelled = false;
    setCopySubdirLoading(true);
    api.directory
      .remote(copyAccount, [copyBase, ...copySegments].join("/"))
      .then((dirs) => {
        if (!cancelled) setCopySubdirs(dirs ?? []);
      })
      .catch(() => {
        if (!cancelled) setCopySubdirs([]);
      })
      .finally(() => {
        if (!cancelled) setCopySubdirLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, copying, copyBase, copyAccount, copySegments]);

  const lineCount = urls
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean).length;

  const submit = async () => {
    if (lineCount === 0) {
      toast.error("请先粘贴链接");
      return;
    }
    if (mode === "task" && !selectedTask) {
      toast.error("请选择一个同步任务");
      return;
    }
    setSubmitting(true);
    setResults(null);
    setInvalid([]);
    try {
      const copyOpts = copying && copyBase ? { copyToOpenlist: true, ...(copySegments.length ? { copyDstDir: copyTarget } : {}) } : {};
      const target =
        mode === "task" && selectedTask
          ? { taskId: selectedTask.id, subPath: subSegments.join("/"), generateStrm, ...copyOpts }
          : dirId
            ? { dirId, ...copyOpts }
            : copyOpts;
      const res = await api.offline.add({ account, urls, ...target });
      setResults(res.results);
      setInvalid(res.invalid);
      if (res.added > 0) {
        const copied = copying && copyBase ? `复制到 ${copyTarget}` : "";
        // strm 只看「下完生成 strm」的回执：followup 把「下完只复制」的也算在里面（比如关了生成 strm、或者链接都是 115 上已有的）
        const suffix = !res.followup
          ? ""
          : res.strmFollowup
            ? `，下载完成后会自动生成 strm${copied ? `，并${copied}` : ""}`
            : copied
              ? `，下载完成后会${copied}`
              : "";
        toast.success(`已添加 ${res.added} 个云下载任务${suffix}`);
        onAdded(
          res.results.filter((r) => r.ok).map((r) => r.url),
          account,
        );
      }
      if (res.failed === 0 && res.invalid.length === 0) {
        onOpenChange(false);
      } else if (res.added === 0) {
        toast.error("没有任务被添加，原因见下方");
      }
    } catch (err) {
      const body = apiErrorBody(err) as { invalid?: string[] };
      if (Array.isArray(body.invalid) && body.invalid.length) setInvalid(body.invalid);
      toast.error(apiErrorMessage(err, "添加云下载任务失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const dirLabel = dirId
    ? dirPath || "根目录"
    : defaultDir
      ? `115 默认目录（${defaultDir}）`
      : "115 默认目录";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>添加云下载</DialogTitle>
          <DialogDescription>
            由 115 在云端下载到网盘。{accounts && accounts.length > 1 ? "" : `账号：${account}`}
          </DialogDescription>
        </DialogHeader>

        {accounts && accounts.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="offline-account" className="shrink-0 text-sm font-medium">
              账号
            </label>
            <Select value={account} onValueChange={setPicked} disabled={submitting}>
              <SelectTrigger id="offline-account" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex-1 overflow-auto min-h-0 space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">链接（每行一条）</label>
            <Textarea
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              rows={5}
              placeholder={"magnet:?xt=urn:btih:...\ned2k://|file|...|/\nhttps://example.com/file.mkv"}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              支持磁力、ed2k、http(s)、ftp；直接贴 40 位 info hash 也行。当前 {lineCount} 条。
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">下载到</label>
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="offlineTarget"
                  value="task"
                  checked={mode === "task"}
                  onChange={() => {
                    setMode("task");
                    setCopySegments([]);
                  }}
                  className="mt-1"
                  disabled={tasks.length === 0 && !tasksLoading}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">同步任务的目录</div>
                  <div className="text-xs text-muted-foreground">
                    下载完成后自动为下载的文件生成 strm，不用再跑全量同步。
                  </div>
                </div>
              </label>

              {mode === "task" && (
                <div className="ml-6 space-y-2">
                  {tasksLoading ? (
                    <div className="text-sm text-muted-foreground">加载中...</div>
                  ) : tasks.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      这个账号下还没有同步任务，请先到首页创建，或改成下载到网盘目录。
                    </div>
                  ) : (
                    <Select
                      value={taskId}
                      onValueChange={(v) => {
                        setTaskId(v);
                        setSubSegments([]);
                        // 复制的根跟着任务变（任务可能有自己的目标目录），在旧根下选的子目录作废
                        setCopySegments([]);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择任务" />
                      </SelectTrigger>
                      <SelectContent>
                        {tasks.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.originPath} → {t.targetPath || "(未配置)"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {selectedTask && (
                    <div className="border rounded-md overflow-hidden">
                      <div className="flex items-center gap-1 px-3 py-2 text-xs bg-muted/40 border-b flex-wrap min-w-0">
                        <button
                          type="button"
                          onClick={() => setSubSegments([])}
                          className={`hover:text-foreground truncate max-w-[240px] ${
                            subSegments.length === 0 ? "font-medium text-foreground cursor-default" : "underline cursor-pointer"
                          }`}
                          title={selectedTask.originPath}
                        >
                          {selectedTask.originPath}
                        </button>
                        {subSegments.map((seg, idx) => (
                          <span key={idx} className="flex items-center gap-1 min-w-0">
                            <ChevronRight className="h-3 w-3 shrink-0" />
                            <button
                              type="button"
                              onClick={() => setSubSegments((prev) => prev.slice(0, idx + 1))}
                              className={`hover:text-foreground truncate max-w-[120px] ${
                                idx === subSegments.length - 1
                                  ? "font-medium text-foreground cursor-default"
                                  : "underline cursor-pointer"
                              }`}
                              title={seg}
                            >
                              {seg}
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="max-h-[160px] overflow-auto">
                        {subdirLoading ? (
                          <div className="p-3 text-center text-xs text-muted-foreground">加载中...</div>
                        ) : subdirs.length === 0 ? (
                          <div className="p-3 text-center text-xs text-muted-foreground">此目录下没有子文件夹</div>
                        ) : (
                          <ul className="py-1">
                            {subdirs.map((d) => (
                              <li key={d.id}>
                                <button
                                  type="button"
                                  onClick={() => setSubSegments((prev) => [...prev, d.name])}
                                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-left text-sm"
                                >
                                  <FolderOpen className="h-4 w-4 text-warning shrink-0" />
                                  <span className="truncate">{d.name}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}

                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <Checkbox checked={generateStrm} onCheckedChange={(v) => setGenerateStrm(v === true)} />
                    下载完成后自动生成 strm
                  </label>
                </div>
              )}

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="offlineTarget"
                  value="dir"
                  checked={mode === "dir"}
                  onChange={() => {
                    setMode("dir");
                    setCopySegments([]);
                  }}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">网盘里的任意目录</div>
                  <div className="text-xs text-muted-foreground">只下载，不生成 strm。</div>
                </div>
              </label>

              {mode === "dir" && (
                <div className="ml-6 flex items-center gap-2 flex-wrap text-sm">
                  <span className="text-muted-foreground">保存到：</span>
                  <span className="font-medium truncate max-w-[260px]" title={dirLabel}>
                    {dirLabel}
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                    选择目录
                  </Button>
                  {dirId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDirId("");
                        setDirPath("");
                      }}
                    >
                      用默认目录
                    </Button>
                  )}
                </div>
              )}

            </div>
          </div>

          {copySetup && (
            <div className="space-y-2">
              <label className="text-sm font-medium">下载完之后</label>
              <div className="space-y-2">
                <label className={`flex items-start gap-2 text-sm ${taskCopies ? "cursor-default" : "cursor-pointer"}`}>
                  <Checkbox
                    checked={copying}
                    disabled={taskCopies || !copyBase}
                    onCheckedChange={(v) => {
                      setCopyToOpenlist(v === true);
                      setCopySegments([]);
                    }}
                    className="mt-0.5"
                  />
                  <span>
                    下载完成后复制走（OpenList / CD2）
                    <span className="block text-xs text-muted-foreground">
                      {!copyBase
                        ? "设置页和这个任务上都没填复制目标目录，复制不了"
                        : taskCopies
                          ? `这个任务开着「复制到 OpenList / CD2」，下完会复制到 ${copyTarget}（在任务设置里改）；任务目录里的层级会原样带过去`
                          : `复制到 ${copyTarget}${mode === "task" ? "；任务目录里的层级会原样带过去" : ""}`}
                    </span>
                  </span>
                </label>

                {copying && copyBase && (
                  <div className="border rounded-md overflow-hidden">
                    <div className="flex items-center gap-1 px-3 py-2 text-xs bg-muted/40 border-b flex-wrap min-w-0">
                      <button
                        type="button"
                        onClick={() => setCopySegments([])}
                        className={`hover:text-foreground truncate max-w-[240px] ${
                          copySegments.length === 0 ? "font-medium text-foreground cursor-default" : "underline cursor-pointer"
                        }`}
                        title={copyBase}
                      >
                        {copyBase}
                      </button>
                      {copySegments.map((seg, idx) => (
                        <span key={idx} className="flex items-center gap-1 min-w-0">
                          <ChevronRight className="h-3 w-3 shrink-0" />
                          <button
                            type="button"
                            onClick={() => setCopySegments((prev) => prev.slice(0, idx + 1))}
                            className={`hover:text-foreground truncate max-w-[120px] ${
                              idx === copySegments.length - 1
                                ? "font-medium text-foreground cursor-default"
                                : "underline cursor-pointer"
                            }`}
                            title={seg}
                          >
                            {seg}
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="max-h-[160px] overflow-auto">
                      {copySubdirLoading ? (
                        <div className="p-3 text-center text-xs text-muted-foreground">加载中...</div>
                      ) : copySubdirs.length === 0 ? (
                        <div className="p-3 text-center text-xs text-muted-foreground">此目录下没有子文件夹</div>
                      ) : (
                        <ul className="py-1">
                          {copySubdirs.map((d) => (
                            <li key={d.id}>
                              <button
                                type="button"
                                onClick={() => setCopySegments((prev) => [...prev, d.name])}
                                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-left text-sm"
                              >
                                <FolderOpen className="h-4 w-4 text-brand shrink-0" />
                                <span className="truncate">{d.name}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {(results?.some((r) => !r.ok) || invalid.length > 0) && (
            <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              {results
                ?.filter((r) => !r.ok)
                .map((r) => (
                  <div key={r.url} className="flex gap-2 min-w-0">
                    <span className="truncate max-w-[220px] text-muted-foreground" title={r.url}>
                      {r.url}
                    </span>
                    <span className="text-destructive">{r.message || "115 未接受"}</span>
                  </div>
                ))}
              {invalid.map((u) => (
                <div key={u} className="flex gap-2 min-w-0">
                  <span className="truncate max-w-[220px] text-muted-foreground" title={u}>
                    {u}
                  </span>
                  <span className="text-destructive">115 不支持这种链接</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || tasksLoading || lineCount === 0 || (mode === "task" && !selectedTask)}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>

      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        account={account}
        onSelect={(cid, path) => {
          setDirId(String(cid));
          setDirPath(path);
        }}
      />
    </Dialog>
  );
}
