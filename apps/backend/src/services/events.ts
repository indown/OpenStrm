/**
 * 进程内事件登记处：领域模块之间"发生了什么"的口子。发的一方不认识听的一方，要加事件就在这里登记一条。
 *
 *   files.landed   有新文件落进了某个同步任务的网盘目录：转存（界面 / 智能体）、追更、云下载、网盘监控、复制完成都发。
 *                  听的：organize/auto —— 按任务的整理设置决定要不要自动整理（startAutoOrganize 订阅）
 *   task.finished  一个同步任务不在跑了（跑完、启动阶段就结束、被取消都算）：task/registry 发。
 *                  听的：life/monitor —— 同步期间记下的变化不用等下一轮，马上补
 *
 * 只是触发，不是请求 / 应答：要拿结果的（复制登记要知道排上几条）照旧直接调用。
 */
import type { OrganizeTrigger, TaskDefinition } from "@openstrm/shared";
import { createEmitter } from "../lib/events.js";
import { moduleLogger } from "../lib/logger.js";

export interface FilesLandedEvent {
  task: TaskDefinition;
  /** 相对任务 originPath 的新增路径（文件或目录） */
  paths: string[];
  trigger: OrganizeTrigger;
  /** 攒一会再处理（监控事件一条一条来，一部剧是几十条） */
  debounce?: boolean;
  /** 这一次强制按这个策略整理（转存弹框勾了「转存后整理」）；不给就按任务的设置 */
  mode?: "review" | "auto";
}

export interface TaskFinishedEvent {
  taskId: string;
}

export interface AppEvents {
  "files.landed": FilesLandedEvent;
  "task.finished": TaskFinishedEvent;
}

export const events = createEmitter<AppEvents>(moduleLogger("events"));
