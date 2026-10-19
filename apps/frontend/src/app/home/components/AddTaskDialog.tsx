"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useForm, useWatch, type Control, type UseFormSetValue } from "react-hook-form";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";
import type { OpenlistCopySettings, OrganizeTemplatePreview, TaskDefinition } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { TemplatePresetPicker } from "@/components/template-preset-picker";
import { apiErrorMessage } from "@/lib/axios";
import { fmtWhen } from "@/lib/format";
import { copyGapInDialog, isOpenlistRootInput, normTargetDir, OPENLIST_ROOT_TARGET } from "@/lib/openlist-copy";
import { TreeSelectDialog } from "@/components/TreeSelectDialog";
import { DirectoryTreeDialog } from "./DirectoryTreeDialog";
import { LocalDirectoryTreeDialog } from "./LocalDirectoryTreeDialog";

/** 5 段（或带秒的 6 段）就放行，字段是否合法由后端的 cron 库校验，失败会以 400 回来 */
const CRON_SHAPE = /^\S+(?:\s+\S+){4,5}$/;

/** 和后端 services/strm/naming.ts 的 normalizeStrmPrefix 同一条规则：去首尾空白和尾斜杠，只剩一个 `/` 的保留 */
const normalizePrefix = (v: string): string => v.trim().replace(/(.)\/+$/, "$1");
const isHttpPrefix = (v: string): boolean => /^https?:\/\//i.test(v.trim());

export const taskFormSchema = z.object({
  account: z.string().min(1, "请选择账户"),
  originPath: z.string().trim().min(1, "远程路径不能为空"),
  targetPath: z.string().trim().min(1, "本地路径不能为空"),
  strmPrefix: z.string().trim().min(1, "Strm 前缀不能为空"),
  strmType: z.string().optional(),
  removeExtraFiles: z.boolean().optional(),
  enable302: z.boolean().optional(),
  enablePathEncoding: z.boolean().optional(),
  cronExpression: z
    .string()
    .trim()
    .refine((v) => v === "" || CRON_SHAPE.test(v), "cron 表达式应为 5 段，例如 0 3 * * *"),
  /** 复制到 OpenList：这个任务落下新文件时复制走 */
  copyEnabled: z.boolean().optional(),
  copyDstDir: z.string().optional(),
  /** 复制成功后源文件的去向 */
  copyAfterCopy: z.enum(["keep", "delete", "archive"]).optional(),
  /** 整理：库类型先验；自动整理策略（空串 = 跟随全局设置） */
  libraryType: z.enum(["mixed", "movie", "tv"]).optional(),
  organizeMode: z.enum(["", "off", "review", "auto"]).optional(),
  /** 这个任务自己的命名模板 / id 标签 / 集标题：留空 / 空串 = 沿用全局设置（模板合不合法后端校验，错了会回在表单上） */
  orgMovieTemplate: z.string().optional(),
  orgTvTemplate: z.string().optional(),
  orgIdTag: z.enum(["", "emby", "jellyfin", "plex", "none"]).optional(),
  orgEpisodeTitle: z.enum(["", "on", "off"]).optional(),
})
  // 「复制到哪」不收 OpenList 根；复制关着时这一栏不显示、也不提交，不拦
  .refine((v) => !v.copyEnabled || !isOpenlistRootInput(v.copyDstDir), { message: OPENLIST_ROOT_TARGET, path: ["copyDstDir"] });

export type TaskFormValues = z.infer<typeof taskFormSchema>;

/** 编辑时传进来的任务：定义 + 表单存的 strmType */
export type TaskEditable = Partial<Omit<TaskDefinition, "id">> & { id?: string; strmType?: string };

/** Select 的选项值不能是空串，用两个占位值表示"不定时"和"自定义" */
const NONE = "__none__";
const CUSTOM = "__custom__";
const CRON_PRESETS = [
  { value: "0 * * * *", label: "每小时" },
  { value: "0 */6 * * *", label: "每 6 小时" },
  { value: "0 3 * * *", label: "每天 03:00" },
  { value: "0 4 * * 1", label: "每周一 04:00" },
];

interface AddTaskDialogProps {
  task?: TaskEditable;
  trigger?: React.ReactNode;
  onSuccess?: () => void;
  accounts?: Array<{ name: string; accountType: string }>;
  accountsLoading?: boolean;
  /** 受控模式：页面统一管一个编辑弹框时传入 open / onOpenChange；不传则自己管 open（"新建任务"按钮那种用法） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * 编辑时，如果启用了 302 且 strmPrefix 以账号结尾，需要去掉账号后缀（保存时会再拼回去）。
 * http(s) 前缀不拼账号名，也就不能剥：OpenList 存储正好叫账号名时会把最后一段吃掉。
 */
function stripAccountSuffix(task: TaskEditable): string {
  let prefix = task.strmPrefix || "";
  if (task.enable302 && task.account && !isHttpPrefix(prefix) && prefix.endsWith("/" + task.account)) {
    prefix = prefix.slice(0, -(task.account.length + 1));
  }
  return prefix;
}

/** 当前应当显示的表单值：编辑时来自 task（去掉 302 拼上的账号后缀），新增时是空表单 */
function defaultsFor(task: TaskEditable | undefined): TaskFormValues {
  return {
    account: task?.account ?? "",
    originPath: task?.originPath ?? "",
    targetPath: task?.targetPath ?? "",
    strmPrefix: task ? stripAccountSuffix(task) : "",
    strmType: task?.strmType ?? "local",
    removeExtraFiles: task?.removeExtraFiles ?? true,
    enable302: task?.enable302 ?? false,
    enablePathEncoding: task?.enablePathEncoding ?? false,
    cronExpression: task?.cronExpression ?? "",
    copyEnabled: task?.copyToOpenlist?.enabled ?? false,
    copyDstDir: task?.copyToOpenlist?.dstDir ?? "",
    // 关着时留的旧值不算（保存时关着就整块记成关）
    copyAfterCopy: task?.copyToOpenlist?.enabled ? (task.copyToOpenlist.afterCopy ?? "keep") : "keep",
    libraryType: task?.organize?.libraryType ?? "mixed",
    organizeMode: task?.organize?.mode ?? "",
    orgMovieTemplate: task?.organize?.templates?.movie ?? "",
    orgTvTemplate: task?.organize?.templates?.tv ?? "",
    orgIdTag: task?.organize?.idTag ?? "",
    orgEpisodeTitle: task?.organize?.episodeTitle === undefined ? "" : task.organize.episodeTitle ? "on" : "off",
  };
}

/** 任务上有没有自己的命名设定：有就默认展开那一块 */
const hasOwnNaming = (task: Pick<TaskDefinition, "organize"> | null | undefined): boolean =>
  !!task?.organize?.templates?.movie?.trim() || !!task?.organize?.templates?.tv?.trim() || !!task?.organize?.idTag || task?.organize?.episodeTitle !== undefined;

/**
 * 任务自己的命名设定（可选，折叠着）：电影 / 剧集模板、id 标签写法、集标题，留空沿用全局；
 * 和设置页一样实时试算（两个固定样例），没填的那格按全局模板算
 */
function TaskNamingFields({ control, setValue, defaultOpen }: { control: Control<TaskFormValues>; setValue: UseFormSetValue<TaskFormValues>; defaultOpen: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const movie = useWatch({ control, name: "orgMovieTemplate" }) ?? "";
  const tv = useWatch({ control, name: "orgTvTemplate" }) ?? "";
  const idTag = useWatch({ control, name: "orgIdTag" }) ?? "";
  const episodeTitle = useWatch({ control, name: "orgEpisodeTitle" }) ?? "";
  const [preview, setPreview] = React.useState<OrganizeTemplatePreview | null>(null);
  const timer = React.useRef<NodeJS.Timeout | null>(null);
  const key = JSON.stringify([open, movie, tv, idTag, episodeTitle]);
  React.useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.organize
        .previewName({
          templates: { movie, tv },
          ...(idTag ? { idTag: idTag as Exclude<typeof idTag, ""> } : {}),
          ...(episodeTitle ? { episodeTitle: episodeTitle === "on" } : {}),
        })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const own = !!movie.trim() || !!tv.trim() || !!idTag || !!episodeTitle;
  return (
    <div className="space-y-3 rounded-md border p-3">
      <button type="button" className="flex w-full items-center justify-between gap-2 text-left text-sm" onClick={() => setOpen((v) => !v)}>
        <span className="font-medium">
          命名模板 <span className="text-xs font-normal text-muted-foreground">{own ? "这个任务单独设了" : "沿用全局设置"}</span>
        </span>
        <span className="text-xs text-muted-foreground">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">只给这个任务用的写法（比如动画库文件名带绝对集数）；留空的沿用设置页「整理与命名」里的。</p>
          <div className="flex flex-wrap items-center gap-2">
            <TemplatePresetPicker
              onPick={(p) => {
                setValue("orgMovieTemplate", p.movie, { shouldDirty: true });
                setValue("orgTvTemplate", p.tv, { shouldDirty: true });
              }}
            />
            <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => {
              setValue("orgMovieTemplate", "", { shouldDirty: true });
              setValue("orgTvTemplate", "", { shouldDirty: true });
              setValue("orgIdTag", "", { shouldDirty: true });
              setValue("orgEpisodeTitle", "", { shouldDirty: true });
            }}>
              清空，沿用全局
            </Button>
          </div>
          <FormField
            control={control}
            name="orgMovieTemplate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>电影模板</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ""} placeholder="留空沿用全局" className="font-mono text-xs" />
                </FormControl>
                <FormDescription className="break-all text-xs">示例：{preview?.movie ?? "…"}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="orgTvTemplate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>剧集模板</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ""} placeholder="留空沿用全局" className="font-mono text-xs" />
                </FormControl>
                <FormDescription className="break-all text-xs">示例：{preview?.tv ?? "…"}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          {preview && preview.errors.length > 0 && (
            <ul className="space-y-0.5 text-xs text-destructive">
              {preview.errors.map((e, i) => (
                <li key={i} className="break-all">
                  {e}
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField
              control={control}
              name="orgIdTag"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>id 标签写法</FormLabel>
                  <Select onValueChange={(v) => field.onChange(v === "__global__" ? "" : v)} value={field.value || "__global__"}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="z-[60]">
                      <SelectItem value="__global__">跟随全局设置</SelectItem>
                      <SelectItem value="emby">Emby：[tmdbid=123]</SelectItem>
                      <SelectItem value="jellyfin">Jellyfin：[tmdbid-123]</SelectItem>
                      <SelectItem value="plex">Plex：{"{tmdb-123}"}</SelectItem>
                      <SelectItem value="none">不写</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="orgEpisodeTitle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>文件名里写集标题</FormLabel>
                  <Select onValueChange={(v) => field.onChange(v === "__global__" ? "" : v)} value={field.value || "__global__"}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="z-[60]">
                      <SelectItem value="__global__">跟随全局设置</SelectItem>
                      <SelectItem value="on">写</SelectItem>
                      <SelectItem value="off">不写</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** 和全站共用的 <SwitchRow> 同一副长相，只是值从 react-hook-form 来 */
function SwitchRow({
  control,
  name,
  label,
  description,
  disabled = false,
}: {
  control: Control<TaskFormValues>;
  name: "removeExtraFiles" | "enable302" | "enablePathEncoding" | "copyEnabled";
  label: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem
          className={`flex items-start justify-between gap-4 rounded-md border p-3 space-y-0 ${disabled ? "opacity-60" : ""}`}
        >
          <div className="min-w-0 space-y-1 leading-snug">
            <FormLabel className={`font-medium ${disabled ? "" : "cursor-pointer"}`}>{label}</FormLabel>
            <FormDescription className="text-xs">{description}</FormDescription>
          </div>
          <FormControl>
            <Switch
              checked={field.value === true}
              onCheckedChange={field.onChange}
              disabled={disabled}
              className="mt-0.5"
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

/**
 * 边打边试算 cron 接下来几次什么时候跑，节奏和整理页的模板试算一样（防抖 400ms）。
 *
 * 算在后端：调度用的是服务器的解析器和时区，浏览器自己算出来的时间可能根本不是它真会跑的时间。
 * 表达式还没打完时后端回 400，这里当"暂时没有结果"处理，不往上抛。
 */
function useCronPreview(expression: string): { next: string[]; error: string } {
  const [state, setState] = React.useState<{ next: string[]; error: string }>({ next: [], error: "" });
  React.useEffect(() => {
    const expr = expression.trim();
    if (!expr) {
      setState({ next: [], error: "" });
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api.tasks
        .cronPreview(expr)
        .then((res) => {
          // 响应里没有 next 就当没结果：渲染那头直接 .length 会把整个弹框掀掉
          if (alive) setState({ next: Array.isArray(res.next) ? res.next : [], error: "" });
        })
        .catch((err) => {
          if (alive) setState({ next: [], error: apiErrorMessage(err, "算不出下次执行时间") });
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [expression]);
  return state;
}

/** 正在被网盘监控的账号（只拉一次，弹框打开时）。拿不到就当没有，提示不出来也不影响建任务 */
function useMonitoredAccounts(open: boolean): Set<string> {
  const [names, setNames] = React.useState<Set<string>>(() => new Set());
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    api.life
      .status()
      .then((s) => {
        if (alive) setNames(new Set(s.accounts.filter((a) => a.running).map((a) => a.name)));
      })
      .catch(() => {
        if (alive) setNames(new Set());
      });
    return () => {
      alive = false;
    };
  }, [open]);
  return names;
}

/**
 * 账号开着网盘监控时，定时执行那栏的提示：网盘上的变化监控会自动同步，定时全量同步只是兜底。
 * 定得比 6 小时还密就点明只会多跑几遍全量（夸克要逐个目录列，115 要导出整棵目录树）；next 是试算出来的接下来几次
 */
function monitorCronHint(cron: string, next: string[]): string {
  if (!cron.trim()) return "这个账号开着网盘监控，网盘上的变化会自动同步过来；建议再每天定时跑一次全量当兜底。";
  const gaps = next.slice(1).map((t, i) => Date.parse(t) - Date.parse(next[i]!));
  return gaps.length > 0 && Math.min(...gaps) < 6 * 3600_000
    ? "这个账号开着网盘监控，变化已经会自动同步；定时执行只是兜底，每天一次就够，定得太密只会多跑几遍全量。"
    : "这个账号开着网盘监控，变化会自动同步，定时执行当兜底正合适。";
}

/**
 * 路径编码只对 http(s) 前缀有意义：strm 内容是 URL 时空格、# 之类才是问题（开不开 302 都一样，代理那头会解码）。
 * 前缀是本地挂载路径时 strm 是文件路径，编码了反而对不上文件。
 */
function pathEncodingHint(prefixIsHttp: boolean, is302: boolean): { allowed: boolean; description: string } {
  if (prefixIsHttp) {
    return {
      allowed: true,
      description: "把网盘路径按段做 URL 编码（空格、#、?、中文）。文件名带空格时 ffmpeg 和 Apple 系播放器才打得开，建议开。",
    };
  }
  if (is302) return { allowed: false, description: "302 模式写的是本地挂载路径，不经过 URL，不需要编码。" };
  return { allowed: false, description: "前缀不是 http(s) 地址时 strm 里是本地路径，编码了反而对不上文件。" };
}

/**
 * 302 的两种前缀：本地挂载路径会拼上 /账号名，代理靠它识别挂载点；
 * http(s) 地址（OpenList 的 /d/）不拼账号名，代理按任务反查账号，换不到直链时回给 Emby 按 strm 里的 URL 播。
 */
function redirectHint(prefixIsHttp: boolean): string {
  if (prefixIsHttp) {
    return "播放时代理换到 115 直链就 302，换不到时回给 Emby 按 strm 里的地址播放。http(s) 前缀不拼账号名，OpenList 上挂的要是同一个 115 账号。";
  }
  return "播放时由本工具的代理直接 302 到 115 直链，不再中转流量。前缀会自动拼上 /账号名，代理靠它识别挂载点。";
}

export function AddTaskDialog({
  task,
  trigger,
  onSuccess,
  accounts = [],
  accountsLoading = false,
  open: openProp,
  onOpenChange,
}: AddTaskDialogProps) {
  const [openState, setOpenState] = React.useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openState;
  const [loading, setLoading] = React.useState(false);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [localDirectoryDialogOpen, setLocalDirectoryDialogOpen] = React.useState(false);
  /**
   * 设置页的「复制到 OpenList」：复制目标从哪个 OpenList 账号里选、默认目标目录、各账号的挂载根。
   * 开了复制才去读；undefined = 还没读到或读失败，这时不下「没配好」的结论
   */
  const [copySettings, setCopySettings] = React.useState<OpenlistCopySettings | undefined>(undefined);
  const [copyBrowseOpen, setCopyBrowseOpen] = React.useState(false);
  /** 定时下拉选了"自定义"：表达式为空或不等于预设时也保持输入框可编辑 */
  const [customCron, setCustomCron] = React.useState(false);

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: defaultsFor(task),
  });

  const account = useWatch({ control: form.control, name: "account" }) ?? "";
  const originPath = useWatch({ control: form.control, name: "originPath" }) ?? "";
  const strmPrefix = useWatch({ control: form.control, name: "strmPrefix" }) ?? "";
  const enable302 = useWatch({ control: form.control, name: "enable302" }) ?? false;
  const copyEnabled = useWatch({ control: form.control, name: "copyEnabled" }) ?? false;
  const copyDstDir = useWatch({ control: form.control, name: "copyDstDir" }) ?? "";

  React.useEffect(() => {
    if (!open || !copyEnabled) return;
    let cancelled = false;
    api.settings
      .get()
      .then((s) => {
        if (!cancelled) setCopySettings(s.openlistCopy ?? {});
      })
      .catch(() => {
        if (!cancelled) setCopySettings(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [open, copyEnabled]);
  const olAccount = copySettings?.account ?? "";
  // 设置页填成 / 的算没填，占位里就不提它
  const copyDefaultDst = normTargetDir(copySettings?.dstDir);
  const cronExpression = useWatch({ control: form.control, name: "cronExpression" }) ?? "";
  const cronPreview = useCronPreview(cronExpression);
  const monitoredAccounts = useMonitoredAccounts(open);

  const accountType = accounts.find((acc) => acc.name === account)?.accountType ?? "";
  const is115Account = accountType === "115";
  /** 115、夸克和 OpenList 都能列目录（/api/directory/remote/list 按账号类型分流），远程路径旁边给个浏览按钮 */
  const canBrowseRemote = account !== "" && (is115Account || accountType === "openlist" || accountType === "quark");
  const prefixIsHttp = isHttpPrefix(strmPrefix);
  const is302 = is115Account && enable302;
  /** 只有本地挂载路径才拼 /账号名；http(s) 前缀靠任务反查账号 */
  const appendAccount = is302 && !prefixIsHttp;
  const encoding = pathEncodingHint(prefixIsHttp, is302);
  /** OpenList 账号的任务没有新文件的来路（转存 / 追更 / 云下载 / 监控都只落到网盘账号上），复制开关没意义 */
  const isOpenlistTask = accountType === "openlist";
  /** 开着复制、却因为设置没配齐（这个账号没填挂载根之类）实际不会复制：当场说出来，不然只会「开着，什么都没发生」 */
  const copyGap =
    copyEnabled && account && !isOpenlistTask && copySettings ? copyGapInDialog(copySettings, account, copyDstDir, accounts) : null;

  // 编码没意义的场景下把它关掉，别让一个灰掉的勾继续生效
  React.useEffect(() => {
    if (!encoding.allowed && form.getValues("enablePathEncoding")) {
      form.setValue("enablePathEncoding", false);
    }
  }, [encoding.allowed, form]);

  // 复制开关同理：选了 OpenList 账号就关掉（带着 open：重新打开时表单被重置成任务上存的值，要再看一遍）
  React.useEffect(() => {
    if (open && isOpenlistTask && form.getValues("copyEnabled")) {
      form.setValue("copyEnabled", false);
    }
  }, [open, isOpenlistTask, form]);

  const setOpen = (next: boolean) => {
    if (!isControlled) setOpenState(next);
    onOpenChange?.(next);
  };

  // 每次打开都按当前的 task 重置：useForm 的 defaultValues 只在挂载时取一次，
  // 保存成功后再点"编辑"会显示改之前的值，再存一次就把新值盖回去了
  const handleOpenChange = (next: boolean) => {
    if (next) {
      form.reset(defaultsFor(task));
      setCustomCron(false);
    }
    setOpen(next);
  };

  // 受控打开不经过 handleOpenChange（是父组件改的 open），这里补上同样的重置
  React.useEffect(() => {
    if (isControlled && openProp) {
      form.reset(defaultsFor(task));
      setCustomCron(false);
    }
  }, [isControlled, openProp, task, form]);

  /** 115 + 302 时前缀后面会拼上 /账号名；示例路径让用户看到最终写进 strm 的样子 */
  const cleanPrefix = normalizePrefix(strmPrefix);
  const effectivePrefix = appendAccount && account ? `${cleanPrefix}/${account}` : cleanPrefix;
  const preview =
    strmPrefix || originPath ? `${effectivePrefix}/${originPath.replace(/^\/+/, "").replace(/\/+$/, "")}/…/abc.mkv` : "";

  const onSubmit = async (values: TaskFormValues) => {
    setLoading(true);
    try {
      // 前缀先去掉尾斜杠（后端也会归一化，这里先做是为了拼账号名时不出现 //）。
      // 115 + 302 且前缀是本地挂载路径时拼上账户名，代理按这个前缀识别挂载点；http(s) 前缀不拼，代理按任务反查账号
      const prefix = normalizePrefix(values.strmPrefix);
      const withAccount = is115Account && !!values.enable302 && !!values.account && !isHttpPrefix(prefix);
      const { libraryType, organizeMode, orgMovieTemplate, orgTvTemplate, orgIdTag, orgEpisodeTitle, copyEnabled, copyDstDir, copyAfterCopy, ...rest } = values;
      const movieTpl = orgMovieTemplate?.trim() ?? "";
      const tvTpl = orgTvTemplate?.trim() ?? "";
      const taskData = {
        ...rest,
        strmPrefix: withAccount ? `${prefix}/${values.account}` : prefix,
        accountType,
        organize: {
          ...(organizeMode ? { mode: organizeMode } : {}),
          libraryType: libraryType ?? "mixed",
          // 留空的不存：沿用全局设置
          ...(movieTpl || tvTpl ? { templates: { ...(movieTpl ? { movie: movieTpl } : {}), ...(tvTpl ? { tv: tvTpl } : {}) } } : {}),
          ...(orgIdTag ? { idTag: orgIdTag } : {}),
          ...(orgEpisodeTitle ? { episodeTitle: orgEpisodeTitle === "on" } : {}),
        },
        // 开关关着就整块记成关：留着「删除 / 归档」的话，
        // 以后在转存弹框里勾一次「转存后复制」会连带把网盘上的源文件删了或挪走
        copyToOpenlist: copyEnabled
          ? {
              enabled: true,
              ...(copyDstDir?.trim() ? { dstDir: copyDstDir.trim() } : {}),
              afterCopy: copyAfterCopy ?? "keep",
            }
          : { enabled: false },
      };

      if (task?.id) {
        await api.tasks.update(task.id, taskData);
      } else {
        await api.tasks.create(taskData);
      }
      toast.success(task?.id ? "任务已保存" : "任务已创建");
      onSuccess?.();
      setOpen(false);
    } catch (err) {
      // handleSubmit 会把这里抛出的错误再抛出去：不接住的话保存失败没有任何提示
      toast.error(apiErrorMessage(err, "保存失败"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {(trigger !== undefined || !isControlled) && (
        <DialogTrigger asChild>{trigger ?? <Button variant="outline">{task ? "编辑" : "新增任务"}</Button>}</DialogTrigger>
      )}

      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{task ? "编辑任务" : "新建任务"}</DialogTitle>
          <DialogDescription>
            把网盘里的一个目录同步成本地的 strm 目录；媒体库扫本地目录即可播放。
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="account"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>账户</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择网盘账户" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="z-[60]">
                      {accountsLoading ? (
                        <SelectItem value="loading" disabled>
                          加载中...
                        </SelectItem>
                      ) : accounts.length === 0 ? (
                        <SelectItem value="no-accounts" disabled>
                          还没有账号，请先到「账户」页添加
                        </SelectItem>
                      ) : (
                        accounts.map((acc) => (
                          <SelectItem key={acc.name} value={acc.name}>
                            {acc.name}（{acc.accountType}）
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="originPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>远程路径</FormLabel>
                  <InputGroup>
                    <FormControl>
                      <InputGroupInput {...field} placeholder="例如：tv 或 kuake/tv" />
                    </FormControl>
                    {canBrowseRemote && (
                      <InputGroupButton onClick={() => setDirectoryDialogOpen(true)} title="浏览远程目录">
                        <FolderOpen />
                      </InputGroupButton>
                    )}
                  </InputGroup>
                  <FormDescription className="text-xs">网盘（或 OpenList）里要同步的目录，从根目录算起，不用带开头的斜杠。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="targetPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>本地路径</FormLabel>
                  <InputGroup>
                    <FormControl>
                      <InputGroupInput {...field} placeholder="例如：tv" />
                    </FormControl>
                    <InputGroupButton onClick={() => setLocalDirectoryDialogOpen(true)} title="浏览本地目录">
                      <FolderOpen />
                    </InputGroupButton>
                  </InputGroup>
                  <FormDescription className="text-xs">
                    相对数据目录（DATA_DIR）的路径，strm 会按远程目录的结构生成到这里；媒体库扫这个目录。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="strmPrefix"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Strm 前缀</FormLabel>
                  <InputGroup>
                    <FormControl>
                      <InputGroupInput {...field} placeholder="例如：/mnt/115 或 /CloudNAS/115（rclone、CloudDrive2 的挂载路径）" />
                    </FormControl>
                    {appendAccount && account && (
                      <InputGroupAddon title="开启 302 后自动拼上账号名">/{account}</InputGroupAddon>
                    )}
                  </InputGroup>
                  <FormDescription className="text-xs">
                    写进 strm 文件的地址前缀，一般填 rclone 或 CloudDrive2 把网盘挂到本机的路径，Emby 要能读到。
                    {preview && (
                      <>
                        {" "}
                        示例：<code className="break-all">{preview}</code>
                      </>
                    )}
                  </FormDescription>
                  {prefixIsHttp && (
                    <p className="text-xs text-warning">
                      填的是 http(s) 地址：strm 里会写成 OpenList 的 /d/ 链接，对应存储必须关掉签名才能播放，关掉后知道路径的人都能直接下载。OpenList 只要 Emby 能访问到即可，不要暴露在公网。
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="cronExpression"
              render={({ field }) => {
                const value = field.value ?? "";
                const matchesPreset = CRON_PRESETS.some((p) => p.value === value);
                const presetValue = customCron ? CUSTOM : value === "" ? NONE : matchesPreset ? value : CUSTOM;
                return (
                  <FormItem>
                    <FormLabel>定时执行</FormLabel>
                    <div className="flex items-center gap-2">
                      <Select
                        value={presetValue}
                        onValueChange={(v) => {
                          if (v === CUSTOM) {
                            setCustomCron(true);
                            return;
                          }
                          setCustomCron(false);
                          field.onChange(v === NONE ? "" : v);
                        }}
                      >
                        <SelectTrigger className="w-[150px] shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="z-[60]">
                          <SelectItem value={NONE}>不定时</SelectItem>
                          {CRON_PRESETS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                          <SelectItem value={CUSTOM}>自定义</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormControl>
                        <Input
                          value={value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          placeholder="分 时 日 月 周，例如 0 3 * * *"
                          className="flex-1 font-mono"
                          disabled={presetValue === NONE}
                        />
                      </FormControl>
                    </div>
                    <FormDescription className="text-xs">
                      标准 cron 表达式，按服务器时区。不定时的任务只在手动点开始、或从分享转存时触发。
                    </FormDescription>
                    {/* 试算：填完立刻看到它真会在什么时候跑，不用存下来再去任务列表确认 */}
                    {cronPreview.next.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        接下来：{cronPreview.next.map((iso) => fmtWhen(new Date(iso).getTime())).join("、")}
                      </p>
                    )}
                    {/* 只在"看起来已经打完"时才报错，否则每敲一个字符都红一下 */}
                    {cronPreview.error && CRON_SHAPE.test(value.trim()) && (
                      <p className="text-xs text-destructive">{cronPreview.error}</p>
                    )}
                    {/* 开着网盘监控的账号，定时全量同步只是兜底：告诉用户多密合适 */}
                    {account && monitoredAccounts.has(account) && (
                      <p className="text-xs text-muted-foreground">{monitorCronHint(value, cronPreview.next)}</p>
                    )}
                    <FormMessage />
                  </FormItem>
                );
              }}
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="libraryType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>库类型</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? "mixed"}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="z-[60]">
                        <SelectItem value="mixed">混合（按识别结果分流）</SelectItem>
                        <SelectItem value="movie">电影</SelectItem>
                        <SelectItem value="tv">剧集</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-xs">整理时的先验：看不出是电影还是剧的文件按它来。</FormDescription>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="organizeMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>自动整理</FormLabel>
                    <Select onValueChange={(v) => field.onChange(v === "__global__" ? "" : v)} value={field.value || "__global__"}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="z-[60]">
                        <SelectItem value="__global__">跟随全局设置</SelectItem>
                        <SelectItem value="off">关</SelectItem>
                        <SelectItem value="review">生成待确认清单</SelectItem>
                        <SelectItem value="auto">把握大的直接执行</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-xs">转存 / 追更 / 云下载 / 监控到新文件时要不要自动整理。</FormDescription>
                  </FormItem>
                )}
              />
            </div>

            <TaskNamingFields control={form.control} setValue={form.setValue} defaultOpen={hasOwnNaming(task)} />

            <div className="space-y-2">
              {is115Account && (
                <SwitchRow
                  control={form.control}
                  name="enable302"
                  label="Emby 302 直链"
                  description={redirectHint(prefixIsHttp)}
                />
              )}
              <SwitchRow
                control={form.control}
                name="removeExtraFiles"
                label="删除本地多余文件"
                description="同步时删掉本地有、网盘已经没有的文件，保持两边一致。网盘目录读出来是空的时候会跳过，防止误删。"
              />
              <SwitchRow
                control={form.control}
                name="enablePathEncoding"
                label="strm 路径 URL 编码"
                description={encoding.description}
                disabled={!encoding.allowed}
              />
              <SwitchRow
                control={form.control}
                name="copyEnabled"
                label="复制到 OpenList"
                description={
                  isOpenlistTask
                    ? "OpenList 账号的任务用不着复制：转存、追更、云下载、监控都不会往这里落新文件。"
                    : "转存 / 追更 / 云下载 / 监控往这个任务目录里落下新文件时，让 OpenList 把它复制到另一个存储（比如挂载的本地磁盘）。先在设置页配好 OpenList 账号、目标目录和这个网盘的挂载根。"
                }
                disabled={isOpenlistTask}
              />
              {copyEnabled && (
                <div className="space-y-3 rounded-md border p-3">
                  {copyGap && <p className="text-xs text-warning">{copyGap}。</p>}
                  <FormField
                    control={form.control}
                    name="copyDstDir"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>复制到哪（可选）</FormLabel>
                        <InputGroup>
                          <FormControl>
                            <InputGroupInput
                              placeholder={copyDefaultDst ? `不填就用设置页的默认目标目录（${copyDefaultDst}）` : "不填就用设置页的默认目标目录"}
                              {...field}
                            />
                          </FormControl>
                          <InputGroupButton
                            type="button"
                            disabled={!olAccount}
                            title={olAccount ? `从 OpenList 账号 ${olAccount} 里选` : "先在设置页选好 OpenList 账号"}
                            onClick={() => setCopyBrowseOpen(true)}
                          >
                            <FolderOpen />
                          </InputGroupButton>
                        </InputGroup>
                        <FormDescription className="text-xs">
                          OpenList 里的完整路径；任务目录里的层级会原样带到这个目录下面，还不存在的目录复制时会自动建。
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="copyAfterCopy"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>复制成功后，网盘上的源文件</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value ?? "keep"}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="z-[60]">
                            <SelectItem value="keep">不动</SelectItem>
                            <SelectItem value="archive">归档：挪进任务目录下的「归档」</SelectItem>
                            <SelectItem value="delete">删除（进回收站，不可逆）</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormDescription className="text-xs">
                          都只在复制成功、目标目录里确认看得见之后才动。归档：原来的层级留着，不进媒体库，想恢复挪回去就行；删除等于搬运，备份类任务别选。
                          不动的话 Emby 里同一集会有云上的 strm 和本地那份两个。
                        </FormDescription>
                      </FormItem>
                    )}
                  />
                </div>
              )}
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={loading}>
                  取消
                </Button>
              </DialogClose>
              <Button type="submit" disabled={loading}>
                {loading ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </Form>

        {canBrowseRemote && (
          <DirectoryTreeDialog
            open={directoryDialogOpen}
            onOpenChange={setDirectoryDialogOpen}
            account={account}
            onSelect={(path) => form.setValue("originPath", path, { shouldValidate: true })}
            onSelectWithTargetPath={(nextOrigin, nextTarget) => {
              form.setValue("originPath", nextOrigin, { shouldValidate: true });
              form.setValue("targetPath", nextTarget, { shouldValidate: true });
            }}
          />
        )}

        <LocalDirectoryTreeDialog
          open={localDirectoryDialogOpen}
          onOpenChange={setLocalDirectoryDialogOpen}
          onSelect={(path) => form.setValue("targetPath", path, { shouldValidate: true })}
        />

        {olAccount && (
          <TreeSelectDialog
            open={copyBrowseOpen}
            onOpenChange={setCopyBrowseOpen}
            title="选择复制目标目录"
            description={<>从 OpenList 账号 {olAccount} 的根目录里选</>}
            load={(path) => api.directory.remote(olAccount, path ? `/${path}` : "/")}
            onConfirm={(path) => {
              form.setValue("copyDstDir", `/${path}`, { shouldDirty: true });
              setCopyBrowseOpen(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
