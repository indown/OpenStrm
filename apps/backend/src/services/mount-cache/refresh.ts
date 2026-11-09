/**
 * 网盘目录在挂载层之外改过之后，让挂载层（OpenList、CloudDrive2）忘掉这些目录的列表缓存。
 *
 * OpenList 按存储设置把目录列表缓存一段时间（115 存储默认 30 分钟），CD2 也有自己的目录缓存；
 * 它们只知道经自己做的改动。整理 / 转存 / 追更 / 删源走的是网盘接口，挂载层不知道，缓存到期前
 * 挂载里列出来的还是旧名字，经挂载回源播放的 Emby 就按旧名字找文件：真机上整理改名后 OpenList 30 分钟、
 * rclone 再 3 分半才看到新目录（.claude/plans/openlist-cache-refresh.md）。
 *
 * 做法：对每个改动过的目录让每个配好的目标刷一次（OpenList：/api/fs/list 带 refresh:true；CD2：GetSubFiles 带 forceRefresh）。
 * 改动过的目录 = 新增 / 删除 / 改名 / 挪动条目的父目录，源和目标两边都算。新建的目录由知道这件事的调用方
 * 把目录本身也报上来（整理的 mkdir 项、转存建出来的目录、监控的目录事件），它的父目录才会刷；
 * 不往上一路刷到根——根和 /tv 这种几千条的目录每批都重列一遍太贵（115 有限流）。浅的先刷：父目录缓存里没有的
 * 子目录直接刷会 object not found（drive-notes）。
 * 网盘路径 → 挂载层路径用各目标自己的挂载根换算（OpenList 复用「复制到 OpenList」的，CD2 用它那一节的）；
 * 没配的目标跳过。是顺手的事：不阻塞调用方，失败只记日志。
 */
import type { TaskDefinition } from "@openstrm/shared";
import { messageOf } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { joinPath, normDir, parentDir, toOpenlistPath } from "../copy/paths.js";
import { events, type FilesLandedEvent } from "../events.js";
import { cd2MountCacheTarget } from "./cd2.js";
import { openlistMountCacheTarget } from "./openlist.js";

const log = moduleLogger("mount-cache");

/** 一个要跟着刷新缓存的挂载层 */
export interface MountCacheTarget {
  /** 日志里的名字 */
  name: string;
  /**
   * 一批开跑时读一次配置：配好了就给「网盘账号名 → 它在这个挂载层里的挂载根」和拿着这份配置刷目录的函数；
   * 没配（没地址 / 没凭据 / 没映射）就 null，整个目标跳过。一批里不再重读设置，几十个目录不会打几十次库
   */
  prepare: () => { mounts: Record<string, string>; refresh: (dir: string) => Promise<void> } | null;
  /** 挂载层明确说没有这个目录（刚被删掉 / 挪走），没什么可刷的 */
  isMissing: (err: unknown) => boolean;
  /** 路径不在任何存储下：挂载根多半填错了，不能当「目录不存在」吞掉 */
  isMisconfigured?: (err: unknown) => boolean;
}

/** prepare() 的结果 */
type PreparedTarget = { target: MountCacheTarget; mounts: Record<string, string>; refresh: (dir: string) => Promise<void> };

interface Deps {
  targets: () => MountCacheTarget[];
  /** 安静多久后开始刷（毫秒）：监控事件一条条来，攒一会一起刷 */
  quietMs: number;
  /** 从第一次登记算起最多攒多久（毫秒） */
  maxWaitMs: number;
}

const realDeps: Deps = {
  targets: () => [openlistMountCacheTarget, cd2MountCacheTarget],
  quietMs: 1500,
  maxWaitMs: 10_000,
};

let deps: Deps = { ...realDeps };

/** 仅供测试：换掉目标 / 攒的时间；传 null 恢复 */
export function setMountRefreshDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 算要刷哪些目录 ------------------------------- */

/** 只管斜杠：补头、收连斜杠、去尾；段里的空格原样留着（网盘上真有「Season 1 」这种名字） */
const normDrivePath = (p: string): string => normDir(p);

const depthOf = (dir: string): number => dir.split("/").filter(Boolean).length;

const byDepth = (a: string, b: string): number => depthOf(a) - depthOf(b) || a.localeCompare(b);

/**
 * 这些条目（文件或目录，网盘绝对路径）变了之后要刷新的目录：各自的父目录，去重，浅的在前。
 * removed：这次已经删掉的目录（整理 rmdir 的源目录、撤销时删掉的新建目录），刷它只会 object not found
 */
export function mountDirsToRefresh(paths: string[], opts: { removed?: Iterable<string> } = {}): string[] {
  const removed = new Set([...(opts.removed ?? [])].map(normDrivePath));
  const dirs = new Set<string>();
  for (const p of paths) {
    const norm = normDrivePath(p);
    if (!norm) continue;
    const dir = parentDir(norm);
    if (!removed.has(dir)) dirs.add(dir);
  }
  return [...dirs].sort(byDepth);
}

/* ------------------------------- 登记与攒批 ------------------------------- */

/** 账号名 → 网盘上要刷的目录 */
let pending = new Map<string, Set<string>>();
let quietTimer: NodeJS.Timeout | null = null;
let capTimer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let started = false;
let offLanded: (() => void) | null = null;

/**
 * 登记：这个网盘账号上这些条目（网盘绝对路径，文件或目录）刚变过，它们所在的目录要让挂载层刷新。
 * 不等结果；模块没启动（测试里没 start）就什么都不做
 */
export function scheduleMountRefresh(accountName: string, drivePaths: string[], opts: { removed?: Iterable<string> } = {}): void {
  if (!started) return;
  const dirs = mountDirsToRefresh(drivePaths, opts);
  if (dirs.length === 0) return;
  let set = pending.get(accountName);
  if (!set) {
    set = new Set();
    pending.set(accountName, set);
  }
  for (const d of dirs) set.add(d);
  if (!capTimer) {
    capTimer = setTimeout(fire, deps.maxWaitMs);
    capTimer.unref?.();
  }
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(fire, deps.quietMs);
  quietTimer.unref?.();
}

function clearTimers(): void {
  if (quietTimer) clearTimeout(quietTimer);
  if (capTimer) clearTimeout(capTimer);
  quietTimer = null;
  capTimer = null;
}

function fire(): void {
  clearTimers();
  // 上一批还在跑：跑完会再看一眼 pending
  if (running) return;
  running = drain().finally(() => {
    running = null;
    if (pending.size > 0) fire();
  });
}

async function drain(): Promise<void> {
  const batch = pending;
  pending = new Map();
  // 这一批用开跑时的目标和配置：测试在批次中途换回真依赖（stop + setDeps(null)）时，剩下的目录不能落到真服务上去；
  // 配置一批读一次，几十个目录不会打几十次库，mounts 和 refresh 用的也是同一份
  const targets = deps.targets();
  for (const target of targets) {
    let prepared: PreparedTarget | null;
    try {
      const p = target.prepare();
      prepared = p ? { target, ...p } : null;
    } catch (err) {
      log.warn({ err }, `${target.name} 读配置出错，这一批不刷`);
      continue;
    }
    if (!prepared) {
      log.debug(`没配 ${target.name}，不刷目录缓存（${batch.size} 个账号）`);
      continue;
    }
    for (const [account, dirs] of batch) {
      try {
        await refreshAccountDirs(prepared, account, [...dirs]);
      } catch (err) {
        log.warn({ err }, `${target.name} 刷新目录缓存出错（账号 ${account}）`);
      }
    }
  }
}

async function refreshAccountDirs({ target, mounts, refresh }: PreparedTarget, account: string, driveDirs: string[]): Promise<void> {
  const dirs = driveDirs
    .sort(byDepth)
    .map((d) => toOpenlistPath(mounts, account, d))
    .filter((d): d is string => d !== null);
  if (dirs.length === 0) {
    log.debug(`账号 ${account} 没填在 ${target.name} 里的挂载根，不刷目录缓存`);
    return;
  }
  let ok = 0;
  let gone = 0;
  const failures: string[] = [];
  for (const dir of dirs) {
    try {
      await refresh(dir);
      ok++;
    } catch (err) {
      if (target.isMisconfigured?.(err)) {
        failures.push(`${dir}：${target.name} 里没有这个存储，检查账号 ${account} 的挂载根填对没有`);
      } else if (target.isMissing(err)) {
        // 目录已经不在了（刚被删掉 / 挪走），没什么可刷的
        gone++;
        log.debug(`${target.name} 里没有 ${dir}，跳过`);
      } else {
        failures.push(`${dir}：${messageOf(err)}`);
      }
    }
  }
  if (ok > 0) log.info(`已让 ${target.name} 刷新 ${ok} 个目录的缓存（账号 ${account}）${gone > 0 ? `，${gone} 个已不存在` : ""}`);
  // 一个都刷不到、又都说不存在：改动过的目录不可能全没了，多半是挂载根填错了
  else if (gone > 0 && failures.length === 0) log.warn(`${target.name} 说这 ${gone} 个目录都不存在（账号 ${account}）：检查这个账号在 ${target.name} 里的挂载根填对没有，例如 ${dirs[0]}`);
  if (failures.length > 0) log.warn(`${target.name} 刷新目录缓存失败 ${failures.length}/${dirs.length}（账号 ${account}）：${failures[0]}`);
}

/* ------------------------------- 启动 / 事件 ------------------------------- */

/** 相对任务 originPath 的路径 → 网盘绝对路径。只管斜杠、不动每一段（和 copy/paths.ts 一样，目录名末尾可能真有空格） */
function absPathOf(task: TaskDefinition, rel: string): string {
  return joinPath(normDir(task.originPath) || "/", rel);
}

function onFilesLanded(ev: FilesLandedEvent): void {
  scheduleMountRefresh(
    ev.task.account,
    ev.paths.map((rel) => absPathOf(ev.task, rel)),
  );
}

/** 启动时调一次：打开模块，并订阅 files.landed（转存 / 追更 / 云下载 / 监控新增 / 复制完成都发） */
export function startMountRefresh(): void {
  if (started) return;
  started = true;
  events.on("files.landed", onFilesLanded);
  offLanded = () => events.off("files.landed", onFilesLanded);
}

/** 仅供测试：关掉模块、退订、丢掉攒着的 */
export function stopMountRefresh(): void {
  started = false;
  offLanded?.();
  offLanded = null;
  clearTimers();
  pending = new Map();
}

/**
 * 把攒着的全刷完再返回。停机时调（带 maxMs 封顶，不拖住退出）：timer 都 unref 了，SIGTERM 落在攒批的窗口里会把刷新整个丢掉；
 * 测试里不带 maxMs，等到底
 */
export async function flushMountRefresh(maxMs?: number): Promise<void> {
  clearTimers();
  const work = (async () => {
    while (pending.size > 0 || running) {
      if (!running) fire();
      await running;
    }
  })();
  if (maxMs === undefined) return work;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, maxMs);
      t.unref?.();
    }),
  ]);
}
