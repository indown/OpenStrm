"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { defaultFilter } from "cmdk";
import {
  CloudDownload,
  Download,
  Edit,
  FileText,
  Files,
  FolderOpen,
  FolderTree,
  History,
  KeyRound,
  Bookmark,
  Link2Off,
  ListChecks,
  LogOut,
  Monitor,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Share2,
  Sun,
  Telescope,
} from "lucide-react";
import type { LibraryHit } from "@openstrm/shared";
import type { DriveKind, TaskRow } from "@/lib/api";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { DRIVE_FULL_LABEL } from "@/lib/drive";
import { NAV_GROUPS } from "@/lib/nav";
import { inputKindOf } from "@/lib/share";
import { downloadBackupWithToast } from "@/lib/backup";
import { startTaskWithToast } from "@/lib/task-start";
import { checkForUpdate } from "@/lib/update";
import { usePaletteData } from "@/hooks/use-palette-data";
import { useLibraryPalette } from "@/hooks/use-library-palette";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 顶栏那个「粘贴分享链接」的入口，面板只负责把它叫出来 */
  onOpenShare: () => void;
  /** 输入框里打的字交给顶栏同一套处理：分享打开转存框、磁力去云下载、别的去资源搜索 */
  onInput: (text: string) => void;
  /** 影库里的一条：打开分享弹框，直接定位到那个目录 */
  onOpenLibraryHit: (hit: LibraryHit) => void;
  onLogout: () => void;
};

/**
 * 面板的第二段。现在只有任务有动作页，以后要加别的实体就在这里加一支。
 * rootQuery 是进来之前输入框里那个词，「在 strm 里搜」要用它。
 */
type Stage = { kind: "task"; task: TaskRow; rootQuery: string } | null;

/** 任务在面板里显示成什么样 */
const taskLabel = (t: TaskRow) => `${t.originPath} → ${t.targetPath}`;

/** 「搜资源 / 查看分享 / 云下载」那一条的 value：固定的，和别的条目的 value 撞不上 */
const INPUT_ITEM = "input-action:";
/**
 * 影库条目的 value 前缀：后端已经按词搜过了（靠文件名命中的，名字里可能根本没有打的字），
 * cmdk 再按名字模糊筛一遍会把它们筛掉，所以和「搜资源」那一条一样总是留着
 */
const LIBRARY_ITEM = "library-hit:";

const INPUT_ITEM_LABEL = { share: "查看分享", offline: "云下载", unsupported: "认不出的链接", search: "搜资源" } as const;

/**
 * 输入超过这么长就不拿去给别的条目打分：cmdk 的打分是递归的，贴一整季磁力（几千字）进来，
 * 每打一个字都要把几十个条目和它比一遍；这么长的也不会是在找页面、任务。只剩「云下载」那一条
 */
const FUZZY_MAX = 200;

/**
 * 面板的筛选：「搜资源 / 查看分享 / 云下载」那一条总是留着。它的 value 是固定的 INPUT_ITEM、不带输入的字：
 * cmdk 拿没去首尾空白的输入去比、条目的 value 却去掉了空白，把输入放进 value 的话「沙丘 」这种会对不上；
 * 几千字的一整段放进去，它的递归打分还会爆栈。别的条目照 cmdk 默认的打分
 */
function paletteFilter(value: string, search: string, keywords?: string[]): number {
  if (value === INPUT_ITEM) return 1;
  if (value.startsWith(LIBRARY_ITEM)) return 1;
  return search.length > FUZZY_MAX ? 0 : defaultFilter(value, search, keywords);
}

/**
 * ⌘K 命令面板：去哪儿、做什么、找什么，都在这一个输入框里。
 *
 * 两段式：第一段搜页面 / 操作 / 实体，选中一个任务进第二段，列出对它能做什么。
 * 空输入框上按 Backspace 或 Esc 退回第一段。设计见 .claude/plans/command-palette.md。
 */
export function CommandPalette({ open, onOpenChange, onOpenShare, onInput, onOpenLibraryHit, onLogout }: Props) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<Stage>(null);
  const { tasks, accounts, follows } = usePaletteData(open);
  const queryKind = inputKindOf(query);
  // 第二段（对某个任务做什么）里打的字是筛动作的，不去搜影库
  const library = useLibraryPalette(open && !stage, query);

  // 每次打开都从头开始：留着上次的词和上次进的那一段，第二次打开还得先退出来
  useEffect(() => {
    if (open) {
      setQuery("");
      setStage(null);
    }
  }, [open]);

  /** 选中即执行：先关面板再做事，免得导航完面板还浮在上面 */
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  /** 进第二段：面板不关，输入框清空重新用来筛动作，但把原来那个词记下来 */
  const enter = (task: TaskRow) => {
    setStage({ kind: "task", task, rootQuery: query.trim() });
    setQuery("");
  };

  /**
   * 打了字就给一条「搜资源」，和「在 strm 里搜」是同一种写法。筛选时总能对上（见 paletteFilter）；
   * 不用 forceMount——强制挂上的条目不算结果，下面会同时冒出「什么都没找到」。
   * 贴的是分享、磁力的话这一条换成「查看分享」「云下载」，和顶栏输入框一样分开走。
   *
   * 摆在哪决定回车执行谁：cmdk 选中的是排在最前面的那一条，而它只在组内按分数排、组和组之间照写的顺序
   * （它按分数挪组的那一步对不上号，从来没生效过）。所以贴的是链接时这一组放最前；打的是普通文字时放最后——
   * 不然打 settings、备份这些找页面找操作的词，回车都成了去 PanSou 搜。什么都没对上时它就是唯一一条
   */
  const inputGroup = query.trim() ? (
    <CommandGroup heading={queryKind === "search" ? "资源搜索" : "链接"}>
      <CommandItem value={INPUT_ITEM} onSelect={() => run(() => onInput(query.trim()))}>
        {queryKind === "share" ? <Share2 /> : queryKind === "offline" ? <CloudDownload /> : queryKind === "unsupported" ? <Link2Off /> : <Telescope />}
        <span className="truncate">
          {INPUT_ITEM_LABEL[queryKind]}「{query.trim()}」
        </span>
      </CommandItem>
    </CommandGroup>
  ) : null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="命令面板"
      description="搜索页面、任务和操作，回车执行"
      filter={paletteFilter}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={stage ? `对「${taskLabel(stage.task)}」做什么…` : "搜索页面、任务、操作…"}
        onKeyDown={(e) => {
          if (!stage) return;
          // 在第二段里，这两个键是"退回上一段"而不是"关掉面板"。
          // Esc 要 preventDefault：Radix 的关闭逻辑看的就是 defaultPrevented
          if (e.key === "Escape" || (e.key === "Backspace" && query === "")) {
            e.preventDefault();
            setStage(null);
          }
        }}
      />
      <CommandList>
        <CommandEmpty>{stage ? "没有匹配的操作" : "什么都没找到。要搜 strm 文件，先选中一个任务"}</CommandEmpty>

        {stage ? (
          <CommandGroup heading={taskLabel(stage.task)}>
            <CommandItem
              value="开始同步 运行 start"
              onSelect={() => run(() => void startTaskWithToast(stage.task.id))}
            >
              <Play />
              开始同步
            </CommandItem>
            <CommandItem
              value="实时日志 log"
              onSelect={() => run(() => router.push(`/log?taskId=${encodeURIComponent(stage.task.id)}`))}
            >
              <FileText />
              实时日志
            </CommandItem>
            <CommandItem
              value="执行历史 history"
              onSelect={() => run(() => router.push(`/history?taskId=${encodeURIComponent(stage.task.id)}`))}
            >
              <History />
              执行历史
            </CommandItem>
            <CommandItem
              value="strm 目录 文件"
              onSelect={() => run(() => router.push(`/strm?taskId=${encodeURIComponent(stage.task.id)}`))}
            >
              <Files />
              strm 目录
            </CommandItem>
            <CommandItem
              value="整理 organize 规范化命名"
              onSelect={() => run(() => router.push(`/organize?task=${encodeURIComponent(stage.task.id)}`))}
            >
              <FolderTree />
              整理这个任务
            </CommandItem>
            {stage.rootQuery && (
              <CommandItem
                value={`在 strm 里搜 ${stage.rootQuery}`}
                onSelect={() =>
                  run(() =>
                    router.push(
                      `/strm?taskId=${encodeURIComponent(stage.task.id)}&q=${encodeURIComponent(stage.rootQuery)}`,
                    ),
                  )
                }
              >
                <Search />
                在 strm 里搜「{stage.rootQuery}」
              </CommandItem>
            )}
            <CommandItem
              value="编辑 修改 edit"
              onSelect={() => run(() => router.push(`/home?edit=${encodeURIComponent(stage.task.id)}`))}
            >
              <Edit />
              编辑任务
            </CommandItem>
          </CommandGroup>
        ) : (
          <>
            {queryKind !== "search" && inputGroup}

            {tasks.length > 0 && (
              <CommandGroup heading="任务">
                {tasks.map((task) => (
                  <CommandItem
                    key={task.id}
                    value={`${task.originPath} ${task.targetPath} ${task.account}`}
                    onSelect={() => enter(task)}
                  >
                    <ListChecks />
                    <span className="truncate">{taskLabel(task)}</span>
                    <CommandShortcut className="tracking-normal">{task.account}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {accounts.length > 0 && (
              <CommandGroup heading="账户">
                {accounts.map((acc) => (
                  <CommandItem
                    key={acc.name}
                    value={`${acc.name} ${acc.accountType} ${DRIVE_FULL_LABEL[acc.accountType as DriveKind] ?? ""}`}
                    onSelect={() => run(() => router.push("/account"))}
                  >
                    <KeyRound />
                    {acc.name}
                    <CommandShortcut className="tracking-normal">{DRIVE_FULL_LABEL[acc.accountType as DriveKind] ?? acc.accountType}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {follows.length > 0 && (
              <CommandGroup heading="追更">
                {follows.map((f) => (
                  <CommandItem
                    key={f.id}
                    value={`${f.name} ${f.watchPath}`}
                    onSelect={() => run(() => router.push("/follow"))}
                  >
                    <Rss />
                    <span className="truncate">{f.name || f.watchPath || f.shareCode}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {NAV_GROUPS.map((group) => (
              <CommandGroup key={group.label} heading={`前往 · ${group.label}`}>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.url}
                    // 中文标题之外把路径也算进匹配：打 "strm" 或 "/organize" 都要找得到
                    value={`${item.title} ${item.url}`}
                    onSelect={() => run(() => router.push(item.url))}
                  >
                    <item.icon />
                    {item.title}
                    <CommandShortcut className="font-mono tracking-normal">{item.url}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}

            <CommandGroup heading="操作">
              <CommandItem value="新建任务 添加任务 new task" onSelect={() => run(() => router.push("/home?new=1"))}>
                <Plus />
                新建任务
              </CommandItem>
              <CommandItem value="粘贴分享链接 转存 115 夸克 share" onSelect={() => run(onOpenShare)}>
                <Share2 />
                粘贴分享链接
              </CommandItem>
              <CommandItem value="立即检查更新 update" onSelect={() => run(() => void checkForUpdate())}>
                <RefreshCw />
                立即检查更新
              </CommandItem>
              <CommandItem value="下载备份 backup 数据库" onSelect={() => run(() => void downloadBackupWithToast())}>
                <Download />
                下载备份
              </CommandItem>
            </CommandGroup>

            <CommandGroup heading="主题">
              <CommandItem value="浅色 亮色 light 主题" onSelect={() => run(() => setTheme("light"))}>
                <Sun />
                浅色
              </CommandItem>
              <CommandItem value="深色 暗色 dark 主题" onSelect={() => run(() => setTheme("dark"))}>
                <Moon />
                深色
              </CommandItem>
              <CommandItem value="跟随系统 system 主题" onSelect={() => run(() => setTheme("system"))}>
                <Monitor />
                跟随系统
              </CommandItem>
            </CommandGroup>

            <CommandGroup heading="账号">
              <CommandItem value="修改密码 password" onSelect={() => run(() => router.push("/change-password"))}>
                <KeyRound />
                修改密码
              </CommandItem>
              <CommandItem value="退出登录 logout" onSelect={() => run(onLogout)}>
                <LogOut />
                退出登录
              </CommandItem>
            </CommandGroup>

            {library.hits.length > 0 && (
              <CommandGroup heading={`收藏夹${library.total > library.hits.length ? ` · 共 ${library.total} 条` : ""}`}>
                {library.hits.map((hit) => (
                  <CommandItem
                    key={`${hit.sourceId}:${hit.nodeId}`}
                    value={`${LIBRARY_ITEM}${hit.sourceId}:${hit.nodeId}`}
                    onSelect={() => run(() => onOpenLibraryHit(hit))}
                  >
                    <FolderOpen />
                    <span className="truncate" title={hit.path}>
                      {hit.name}
                    </span>
                    <CommandShortcut className="max-w-[10rem] truncate tracking-normal">{hit.shareTitle}</CommandShortcut>
                  </CommandItem>
                ))}
                <CommandItem
                  value={`${LIBRARY_ITEM}all`}
                  onSelect={() => run(() => router.push(`/library?q=${encodeURIComponent(query.trim())}`))}
                >
                  <Bookmark />
                  <span className="truncate">在收藏夹里看全部「{query.trim()}」</span>
                </CommandItem>
              </CommandGroup>
            )}

            {queryKind === "search" && inputGroup}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
