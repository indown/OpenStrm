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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, FolderOpen } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { api, type DirectoryNode, type DriveKind } from "@/lib/api";
import { DRIVE_FULL_LABEL, accountLabel } from "@/lib/drive";
import { DEFAULT_FOLLOW_INTERVAL, FOLLOW_INTERVALS } from "@/lib/follow";
import { toast } from "sonner";

export interface TaskOption {
  id: string;
  account: string;
  accountType?: string;
  originPath: string;
  targetPath: string;
  strmPrefix?: string;
  copyToOpenlist?: { enabled?: boolean };
  /** 要复制到 OpenList 的话卡在哪；null = 能复制（任务列表接口带的） */
  copyBlocked?: string | null;
}

export interface SaveToTaskChoice {
  taskId: string;
  subPath: string;
  mode: "sync" | "async";
  /** 勾了「转存后追更」才有 */
  follow?: { intervalMinutes: number };
  /** 勾了「转存后整理」 */
  organize?: boolean;
  /** 勾了「转存后复制到 OpenList」 */
  copy?: boolean;
}

interface SaveToDriveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (choice: SaveToTaskChoice) => void;
  selectedCount: number;
  /** 给一段追更范围的说明就会显示「转存后追更」选项；不给则隐藏 */
  followHint?: string;
  /** 分享是哪家网盘的：只列同类账号的任务（115 的分享转不进夸克，反之亦然） */
  kind?: DriveKind;
}

type RemoteDir = DirectoryNode;

export function SaveToDriveDialog({
  open,
  onOpenChange,
  onConfirm,
  selectedCount,
  followHint,
  kind,
}: SaveToDriveDialogProps) {
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [mode, setMode] = useState<"sync" | "async">("sync");
  const [subSegments, setSubSegments] = useState<string[]>([]);
  const [subdirs, setSubdirs] = useState<RemoteDir[]>([]);
  const [subdirLoading, setSubdirLoading] = useState(false);
  const [followChecked, setFollowChecked] = useState(false);
  const [followInterval, setFollowInterval] = useState(String(DEFAULT_FOLLOW_INTERVAL));
  const [organizeChecked, setOrganizeChecked] = useState(false);
  const [copyChecked, setCopyChecked] = useState(false);

  // 任务列表只在打开时拉一次；默认选中用函数式更新，别把 selectedTaskId 放进依赖里反复重拉
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setSubSegments([]);
    setFollowChecked(false);
    setOrganizeChecked(false);
    setCopyChecked(false);
    api.tasks
      .list()
      .then((rows) => {
        if (cancelled) return;
        // 老任务没存 accountType 的也留着，后端会再校验一次
        const list: TaskOption[] = (Array.isArray(rows) ? rows : []).filter((t) => !kind || !t.accountType || t.accountType === kind);
        setTasks(list);
        setSelectedTaskId((prev) => (prev && list.some((t) => t.id === prev) ? prev : (list[0]?.id ?? "")));
      })
      .catch(() => {
        if (!cancelled) toast.error("加载任务列表失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind]);

  const selectedTask = useMemo(() => tasks.find((t) => t.id === selectedTaskId), [tasks, selectedTaskId]);
  const taskInvalid = selectedTask && (!selectedTask.targetPath || !selectedTask.strmPrefix);
  /**
   * 「转存后复制」看所选任务：复制不了（这个账号没填挂载根之类）就灰掉并说原因，勾了后端也会拒；
   * 任务本来就开着复制的，不勾也会复制，勾选框锁成勾上（同云下载弹框）。
   * 只有「任务开着复制、这次却复制不了」用警示色——没用这个功能的人每次转存都看到一行黄字就成噪音了
   */
  const copyBlocked = selectedTask?.copyBlocked ?? null;
  const taskWantsCopy = selectedTask?.copyToOpenlist?.enabled === true;
  const taskCopies = taskWantsCopy && !copyBlocked;
  const subPath = subSegments.join("/");
  // 子目录请求只跟任务 id 和路径走，不跟任务对象的引用走：每次拉列表都是新对象，会把导航重置掉
  const taskAccount = selectedTask?.account;
  const taskOriginPath = selectedTask?.originPath;

  useEffect(() => {
    if (!open || !selectedTaskId || taskAccount == null || taskOriginPath == null) return;
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
  }, [open, selectedTaskId, taskAccount, taskOriginPath, subSegments]);

  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id);
    setSubSegments([]);
  };

  const handleOpenSubdir = (name: string) => {
    setSubSegments((prev) => [...prev, name]);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === subSegments.length) return;
    setSubSegments((prev) => prev.slice(0, index));
  };

  const handleConfirm = () => {
    if (!selectedTaskId) return;
    if (taskInvalid) {
      toast.error("所选任务缺少 targetPath 或 strmPrefix 配置");
      return;
    }
    onConfirm({
      taskId: selectedTaskId,
      subPath,
      mode,
      ...(followHint && followChecked ? { follow: { intervalMinutes: Number(followInterval) } } : {}),
      ...(mode === "sync" && organizeChecked ? { organize: true } : {}),
      // 复制只读网盘，后台模式（全量同步）也照样能排；整理会和全量同步互相踩，只在同步模式给。
      // 勾过之后换成了复制不了 / 本来就复制的任务，这个勾就不算数
      ...(copyChecked && !copyBlocked && !taskCopies ? { copy: true } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>保存到任务目录</DialogTitle>
          <DialogDescription>
            将已选中的 {selectedCount} 项保存到任务对应的网盘目录，并生成 strm 文件。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0 space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">目标任务</label>
            {loading ? (
              <div className="text-sm text-muted-foreground">加载中...</div>
            ) : tasks.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                {kind ? `没有${DRIVE_FULL_LABEL[kind]}账号的任务，请先到首页用同类账号创建一个指向目标目录的任务。` : "暂无任务，请先到首页创建一个指向你希望保存到的网盘目录的任务。"}
              </div>
            ) : (
              <Select value={selectedTaskId} onValueChange={handleSelectTask}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择任务" />
                </SelectTrigger>
                <SelectContent>
                  {tasks.map((t) => (
                    // 带上账号：同类型有两个账号时，两边都可能有 /tv，光看路径分不出转存到哪个账号（同整理页）
                    <SelectItem key={t.id} value={t.id}>
                      {accountLabel(t.account, t.accountType)} · {t.originPath} → {t.targetPath || "(未配置)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {taskInvalid && (
              <div className="text-xs text-destructive">
                所选任务缺少 targetPath 或 strmPrefix
              </div>
            )}
          </div>

          {selectedTask && !taskInvalid && (
            <div className="space-y-2">
              <label className="text-sm font-medium">保存位置（可进入子目录）</label>
              <div className="border rounded-md overflow-hidden">
                <div className="flex items-center gap-1 px-3 py-2 text-xs bg-muted/40 border-b flex-wrap min-w-0">
                  <button
                    type="button"
                    onClick={() => handleBreadcrumbClick(0)}
                    className={`hover:text-foreground truncate max-w-[240px] ${
                      subSegments.length === 0
                        ? "font-medium text-foreground cursor-default"
                        : "underline cursor-pointer"
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
                        onClick={() => handleBreadcrumbClick(idx + 1)}
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
                <div className="max-h-[180px] overflow-auto">
                  {subdirLoading ? (
                    <div className="p-3 text-center text-xs text-muted-foreground">加载中...</div>
                  ) : subdirs.length === 0 ? (
                    <div className="p-3 text-center text-xs text-muted-foreground">
                      此目录下没有子文件夹
                    </div>
                  ) : (
                    <ul className="py-1">
                      {subdirs.map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            onClick={() => handleOpenSubdir(d.name)}
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
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">生成方式</label>
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="strmMode"
                  value="sync"
                  checked={mode === "sync"}
                  onChange={() => setMode("sync")}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium">同步</div>
                  <div className="text-xs text-muted-foreground">
                    立即生成所选项目的 strm。适合少量文件，接口返回时带上生成数量。
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="strmMode"
                  value="async"
                  checked={mode === "async"}
                  onChange={() => setMode("async")}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium">后台</div>
                  <div className="text-xs text-muted-foreground">
                    保存后触发任务全量同步，会扫 task.originPath 下所有文件补齐 strm。可到日志页看进度。
                  </div>
                </div>
              </label>
            </div>
          </div>

          {followHint && (
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <Checkbox
                  checked={followChecked}
                  onCheckedChange={(v) => setFollowChecked(v === true)}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-medium">转存后追更</div>
                  <div className="text-xs text-muted-foreground">{followHint}</div>
                </div>
              </label>
              {followChecked && (
                <div className="flex items-center gap-2 pl-6">
                  <span className="text-xs text-muted-foreground">检查间隔</span>
                  <Select value={followInterval} onValueChange={setFollowInterval}>
                    <SelectTrigger size="sm" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FOLLOW_INTERVALS.map((o) => (
                        <SelectItem key={o.value} value={String(o.value)}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {mode === "sync" && (
            <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer">
              <Checkbox checked={organizeChecked} onCheckedChange={(v) => setOrganizeChecked(v === true)} className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">转存后整理</div>
                <div className="text-xs text-muted-foreground">
                  转存完按 TMDB 识别并规划改名 / 归位：任务设了「把握大的直接执行」就直接整理，否则生成待确认清单，到「整理」页看。
                </div>
              </div>
            </label>
          )}

          <label className={`flex items-start gap-2 rounded-md border p-3 ${copyBlocked || taskCopies ? "" : "cursor-pointer"}`}>
            <Checkbox
              checked={taskCopies || (copyChecked && !copyBlocked)}
              onCheckedChange={(v) => setCopyChecked(v === true)}
              disabled={Boolean(copyBlocked) || taskCopies}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium">转存后复制到 OpenList</div>
              {copyBlocked && taskWantsCopy ? (
                <div className="text-xs text-warning">
                  这个任务开着「复制到 OpenList」，可是{copyBlocked}，这次不会复制。到设置页的「复制到 OpenList」里补上就好。
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  {taskCopies
                    ? "这个任务开着「复制到 OpenList」，转存完会自动复制，不用勾。"
                    : `转存完让 OpenList 把这些条目复制到另一个存储（比如挂载的本地磁盘）。${copyBlocked ? `现在勾不了：${copyBlocked}。` : ""}`}
                </div>
              )}
            </div>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedTaskId || !!taskInvalid || loading}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
