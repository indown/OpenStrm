/**
 * 整理页的展示映射：run 状态、置信度、动作的文案与配色。
 */
import type { OrganizeNaming,
  OrganizeAction,
  OrganizeAttentionReason,
  OrganizeConfidence,
  OrganizeConflictChoice,
  OrganizeErrorKind,
  OrganizeFailureGroupKey,
  OrganizeRun,
  OrganizeRunStage,
  OrganizeRunStatus,
  OrganizeTrigger,
} from "@openstrm/shared";
import type { StatusTone } from "@/components/status-badge";

export const RUN_STATUS_META: Record<OrganizeRunStatus, { label: string; tone: StatusTone; pulse?: boolean }> = {
  planning: { label: "识别中", tone: "info", pulse: true },
  ready: { label: "待执行", tone: "brand" },
  applying: { label: "执行中", tone: "info", pulse: true },
  done: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "warning" },
  reverting: { label: "撤销中", tone: "info", pulse: true },
  reverted: { label: "已撤销", tone: "neutral" },
};

export const CONFIDENCE_META: Record<OrganizeConfidence, { label: string; tone: StatusTone; hint: string }> = {
  high: { label: "把握大", tone: "success", hint: "有 id 证据，或标题和年份都对上" },
  medium: { label: "基本对", tone: "warning", hint: "标题对上但年份缺或差一年，建议看一眼" },
  low: { label: "拿不准", tone: "danger", hint: "只是搜索结果里最像的，请确认" },
  none: { label: "没识别", tone: "neutral", hint: "TMDB 上搜不到：点「换匹配」换个关键词、限定年份 / 类型，或者直接填 TMDB 编号" },
};

export const ACTION_META: Record<OrganizeAction, { label: string; tone: StatusTone }> = {
  keep: { label: "不变", tone: "neutral" },
  rename: { label: "改名", tone: "brand" },
  move: { label: "移动", tone: "info" },
  mkdir: { label: "建目录", tone: "neutral" },
  rmdir: { label: "删空目录", tone: "neutral" },
  skip: { label: "跳过", tone: "neutral" },
  conflict: { label: "冲突", tone: "danger" },
  delete: { label: "删除", tone: "danger" },
};

/** 冲突怎么办：下拉里的选项，顺序就是这里的顺序。删除的两条排最后，文案里说清楚退不回来 */
export const CONFLICT_CHOICES: Array<{ key: OrganizeConflictChoice | "stay"; label: string; hint: string; danger?: boolean }> = [
  { key: "stay", label: "留在原处", hint: "这个文件不动，还是冲突（也可以直接取消勾选它）" },
  { key: "rename", label: "改名保留两份", hint: "给这一份加个区分后缀（画质 / 来源 / 压制组，认不出就 (2)），两份并排放着" },
  { key: "custom", label: "自己改名…", hint: "自己填目标文件名，目录还是整理算出来的位置" },
  { key: "duplicate", label: "挪进重复文件目录", hint: "挪到任务根下的「重复文件」目录，原来的目录层级留着；那里不生成本地 strm、也不再被整理扫描，之后自己在网盘里处理" },
  { key: "delete", label: "删掉这一份", hint: "把正在整理的这个文件删掉，目标那份不动；115 / 夸克进回收站，撤销退不回来", danger: true },
  { key: "replace", label: "覆盖那一份", hint: "先删掉目标位置已有的那个文件，再把这一份挪过去；撤销退不回来", danger: true },
];

export const CONFLICT_LABEL: Record<OrganizeConflictChoice, string> = {
  rename: "改名保留",
  custom: "自己改名",
  duplicate: "挪进重复文件",
  delete: "删掉这一份",
  replace: "覆盖",
};

/** 失败类别：一句话说清楚为什么、下一步做什么（执行阶段的含义；撤销阶段的文案在失败面板里单独写） */
export const ERROR_KIND_META: Record<Exclude<OrganizeErrorKind, "">, { label: string; tone: StatusTone; hint: string }> = {
  blocked: { label: "网盘拒绝", tone: "danger", hint: "风控或登录失效，整理已停下：到「账号」页处理好之后再重试" },
  transient: { label: "临时失败", tone: "warning", hint: "网络、超时或网盘抖动：执行时已自动重试过一次，再试一次多半就好" },
  stale: { label: "预览后变了", tone: "danger", hint: "文件已不在预览时的位置、目录没了或目标位置被占：重新预览会按现在的网盘重新规划，重试只会再失败" },
  rejected: { label: "名字不被接受", tone: "danger", hint: "网盘不接受这个名字或目标已存在：改模板 / 识别词后重新预览，或放弃这些项" },
  mirror: { label: "本地未同步", tone: "warning", hint: "网盘已经改好，本地 strm 没跟上：重试只补本地，不碰网盘" },
};

/** 失败面板每组的标题和一句话；分组本身由后端算（OrganizeRunDetail.groups），这里只管文案 */
export function failureGroupMeta(key: OrganizeFailureGroupKey, stage: OrganizeRunStage): { label: string; tone: StatusTone; hint: string } {
  if (stage === "revert") {
    switch (key) {
      case "blocked":
        return { label: "网盘拒绝", tone: "danger", hint: "退回时被风控或登录失效拦住：账号处理好之后继续撤销" };
      case "transient":
        return { label: "临时失败", tone: "warning", hint: "退回时网络或网盘抖动：继续撤销再试一次" };
      case "rejected":
        return { label: "改回原名被拒", tone: "danger", hint: "原来的名字网盘不再接受（多半是原位置又有了同名文件）：继续撤销再试，或放弃让文件留在整理后的位置" };
      case "stale":
        return { label: "退回时找不到位置", tone: "danger", hint: "原目录或文件的位置和记录对不上（可能被挪过）：继续撤销再试，或放弃让文件留在整理后的位置" };
      case "lost":
        return { label: "已找不到", tone: "danger", hint: "文件已不在整理后的位置，或位置上是另一个文件：没法退回，只能放弃" };
      case "mirror":
        return { label: "已退回，本地未同步", tone: "warning", hint: "网盘已经退回原处，本地 strm 没跟上：继续撤销只补本地" };
      default:
        return { label: key, tone: "neutral", hint: "" };
    }
  }
  if (key === "pending") return { label: "没做完", tone: "neutral", hint: "整理中途停下了（风控、取消或进程重启），这些项还没轮到" };
  if (key === "lost") return { label: "已找不到", tone: "danger", hint: "" };
  const m = ERROR_KIND_META[key];
  return { label: m.label, tone: m.tone, hint: m.hint };
}

export const TRIGGER_LABEL: Record<OrganizeTrigger, string> = {
  manual: "手动",
  agent: "智能体",
  share: "转存",
  follow: "追更",
  offline: "云下载",
  monitor: "监控",
  copy: "复制到 OpenList",
};

/** 命名来源 */
export const NAMING_LABEL: Record<OrganizeNaming, string> = {
  tmdb: "按 TMDB 识别",
  local: "按本地 strm 结构",
};

export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const dirName = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** 人挑的范围（手动的、智能体替人发起的）：选的是目录；其余来源给的是自动触发时新落进来的路径。和后端 organize/run.ts 的 handPicked 同一个口径 */
export const handPicked = (trigger: OrganizeTrigger): boolean => trigger === "manual" || trigger === "agent";

/** run 的范围一句话：手动选的多个目录说「N 个目录」，自动触发的说「N 个新增路径」，单一范围说路径，都没有是整个任务 */
export function scopeLabel(run: Pick<OrganizeRun, "scopePath" | "scopePaths" | "trigger">): string {
  const n = run.scopePaths.length;
  if (n > 0) return handPicked(run.trigger) ? `${n} 个目录` : `${n} 个新增路径`;
  return run.scopePath || "整个任务";
}

/** 进行中的状态：页面要轮询 */
export const isBusyStatus = (s: OrganizeRunStatus): boolean => s === "planning" || s === "applying" || s === "reverting";

/** 待处理列表里每种原因的标签 */
export const ATTENTION_META: Record<OrganizeAttentionReason, { label: string; tone: StatusTone }> = {
  ready: { label: "待执行", tone: "brand" },
  busy: { label: "进行中", tone: "info" },
  failures: { label: "要处理", tone: "danger" },
  revert: { label: "没退回完", tone: "warning" },
  "preview-failed": { label: "自动预览失败", tone: "danger" },
};

/** 整理页做了会改变「待处理」的动作（执行 / 撤销 / 放弃 / 删除 / 预览…）时广播一下，侧栏角标立刻刷新 */
export const ORGANIZE_CHANGED_EVENT = "openstrm:organize-changed";
export function notifyOrganizeChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ORGANIZE_CHANGED_EVENT));
}
