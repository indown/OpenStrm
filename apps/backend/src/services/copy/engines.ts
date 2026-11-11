/**
 * 复制引擎：队列（service.ts）只认这五个动作，OpenList 和 CloudDrive2 各实现一份。
 *
 *   - OpenList：/api/fs/list 带 refresh、/api/fs/mkdir（递归）、/api/fs/copy（目录会展开成逐文件子任务）、/api/task/copy/{undone,done}。
 *   - CD2：GetSubFiles 带 forceRefresh、CreateFolder 逐级建、CopyFile（一次提交一组源路径，CD2 一个源一条任务）、GetCopyTasks。
 *     CD2 没有任务 id，用「源路径→目标目录」当 id；任务名写成 `copy 源 to 目标`，队列按源路径最后两段认任务时能对上。
 */
import type { CopyConfig } from "./paths.js";
import { copyEngineLabel, joinPath } from "./paths.js";
import { cd2CopyFiles, cd2CopyTasks, cd2EnsureDir, cd2ListEntries } from "../cd2/client.js";
import { openlistCopy, openlistCopyTasks, openlistListDir, openlistMkdir, type OpenlistTaskInfo } from "../openlist/client.js";
import type { AccountCd2, AccountOpenlist } from "@openstrm/shared";

export interface CopyTargetEntry {
  name: string;
  isDir?: boolean;
  size?: number;
}

export interface CopyEngine {
  /** 刷新目录缓存并返回其中的条目名 */
  listNames: (cfg: CopyConfig, dir: string) => Promise<string[]>;
  /**
   * 同上，但每条带类型和大小：事后处理源文件（copy/after.ts）核对目标里那份全不全时，文件还要比大小。
   * 测试桩可以不给，那就只比名字（listOpenlistEntries 会按 listNames 补）
   */
  listEntries?: (cfg: CopyConfig, dir: string, opts?: { refresh?: boolean }) => Promise<CopyTargetEntry[]>;
  /** 建目标目录（两家的复制都不会自己建） */
  mkdir: (cfg: CopyConfig, dir: string) => Promise<void>;
  /** 提交复制；返回的任务和 names 一一对应 */
  copy: (cfg: CopyConfig, srcDir: string, dstDir: string, names: string[]) => Promise<OpenlistTaskInfo[]>;
  /** 复制任务的进行中 + 已结束列表 */
  copyTasks: (cfg: CopyConfig) => Promise<{ undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] }>;
  /** 任务 id 会跨轮次重复（CD2 的 id 是「源→目标」）：队列按 id 命中已结束的任务时也要过时间过滤，别拿上一轮的旧结果 */
  taskIdsReused?: boolean;
}

function openlistAccountOf(cfg: CopyConfig): AccountOpenlist {
  if (!cfg.account) throw new Error(`复制引擎是 ${copyEngineLabel(cfg.engine)}，没有 OpenList 账号可用`);
  return cfg.account;
}

export const openlistCopyEngine: CopyEngine = {
  listNames: async (cfg, dir) => (await openlistListDir(openlistAccountOf(cfg), dir, { refresh: true })).map((e) => e.name),
  // refresh 默认 true（队列核对目标要看最新的）；浏览目录传 false 走缓存
  listEntries: async (cfg, dir, opts) => (await openlistListDir(openlistAccountOf(cfg), dir, { refresh: opts?.refresh ?? true })).map((e) => ({ name: e.name, isDir: e.is_dir, size: e.size })),
  mkdir: (cfg, dir) => openlistMkdir(openlistAccountOf(cfg), dir),
  copy: (cfg, srcDir, dstDir, names) => openlistCopy(openlistAccountOf(cfg), srcDir, dstDir, names),
  copyTasks: (cfg) => openlistCopyTasks(openlistAccountOf(cfg)),
};

function cd2Of(cfg: CopyConfig): AccountCd2 {
  if (!cfg.cd2) throw new Error(`复制引擎是 ${copyEngineLabel(cfg.engine)}，没有 CloudDrive2 账号可用`);
  return cfg.cd2;
}

/** CD2 任务没有 id：源路径 + 目标目录就是它的身份 */
export const cd2TaskId = (sourcePath: string, destPath: string): string => `${sourcePath}→${destPath}`;
const cd2TaskName = (sourcePath: string, destPath: string): string => `copy ${sourcePath} to ${destPath}`;

export const cd2CopyEngine: CopyEngine = {
  taskIdsReused: true,
  listNames: async (cfg, dir) => (await cd2ListEntries(cd2Of(cfg), dir, { refresh: true })).map((e) => e.name),
  listEntries: (cfg, dir, opts) => cd2ListEntries(cd2Of(cfg), dir, { refresh: opts?.refresh ?? true }),
  mkdir: (cfg, dir) => cd2EnsureDir(cd2Of(cfg), dir),
  copy: async (cfg, srcDir, dstDir, names) => {
    const sources = names.map((n) => joinPath(srcDir, n));
    await cd2CopyFiles(cd2Of(cfg), sources, dstDir);
    return sources.map((src) => ({ id: cd2TaskId(src, dstDir), name: cd2TaskName(src, dstDir), state: "pending", progress: 0, error: "", endedAt: null }));
  },
  copyTasks: async (cfg) => {
    const undone: OpenlistTaskInfo[] = [];
    const done: OpenlistTaskInfo[] = [];
    for (const t of await cd2CopyTasks(cd2Of(cfg))) {
      const finished = t.status === "completed" || t.status === "failed";
      const info: OpenlistTaskInfo = {
        id: cd2TaskId(t.sourcePath, t.destPath),
        name: cd2TaskName(t.sourcePath, t.destPath),
        state: t.status === "completed" ? "succeeded" : t.status === "failed" ? "failed" : t.status,
        progress: t.totalFiles > 0 ? Math.round((t.uploadedFiles / t.totalFiles) * 100) : 0,
        error: t.status === "failed" ? t.errors.join("；") || `${t.failedFiles} 个文件失败` : "",
        endedAt: t.endedAt,
      };
      (finished ? done : undone).push(info);
    }
    return { undone, done };
  },
};
