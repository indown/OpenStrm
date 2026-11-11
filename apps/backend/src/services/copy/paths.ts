/**
 * 网盘路径 ↔ OpenList 路径的换算，以及「复制到 OpenList」的配置解析。
 *
 * OpenList 把各家网盘挂在自己的某个目录下（115 挂 /115、夸克挂 /quark），
 * 所以网盘上的绝对路径前面补上这个账号的挂载根，就是它在 OpenList 里的路径。
 * 有了这层换算，复制就不再限定在某一个目录、某一种网盘上——加一种网盘只要多配一行挂载根。
 *
 * 这里的路径归一**只管斜杠**：不能用 drive/types.ts 的 normalizePath，
 * 它会把每一段首尾的空格削掉，而网盘上真有「Season 1 」这种带尾空格的目录名（见 test/fake-drive.ts）。
 */
import type { AccountCd2, AccountOpenlist, AppSettings, CopyAfterCopy, CopyEngine, TaskDefinition } from "@openstrm/shared";
import { cd2AccountProblem, cd2AccountState, cd2MountsOf } from "../cd2/config.js";
import { isMountLayerKind } from "../drive/types.js";
import { afterCopyOf } from "../../lib/after-copy.js";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { messageOf } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";

export interface CopyConfig {
  /** 用哪个挂载层复制 */
  engine: CopyEngine;
  /** 调 OpenList 接口用的账号；引擎是 CD2 时为 null */
  account: AccountOpenlist | null;
  /** 调 CD2 接口用的账号（设置页 CloudDrive2 一节选的那个，本身就是连接）；引擎是 OpenList 时为 null */
  cd2: AccountCd2 | null;
  /** 默认目标目录（挂载层里的路径） */
  dstDir: string;
  /** 网盘账号名 → 它在挂载层里的挂载根 */
  mounts: Record<string, string>;
}

/** 日志和说明里引擎的叫法 */
export const copyEngineLabel = (engine: CopyEngine | undefined): string => (engine === "cd2" ? "CloudDrive2" : "OpenList");

/** 设置页里「这个网盘账号在挂载层里的根」那一栏叫什么（按引擎），拼「账号 X 还没填…」用；后端各处和智能体一个口径 */
export const copyMountFieldLabel = (engine: CopyEngine | undefined): string =>
  engine === "cd2" ? "「在 CD2 里的路径」（设置页 CloudDrive2 一节）" : "「在 OpenList 里的挂载根」";

/** 设置里选的引擎；没选过就是 OpenList（老配置） */
export const copyEngineOf = (settings: AppSettings): CopyEngine => (settings.openlistCopy?.engine === "cd2" ? "cd2" : "openlist");

/**
 * 设置里手打的路径：先整串去空白再归一。
 * 和 normDir 分开是因为网盘路径的最后一段可能真的带空格（「Season 1 」），那种不能 trim。
 */
export function normConfigDir(input?: string): string {
  return normDir((input ?? "").trim());
}

/** 目标目录填成 OpenList 根时的说法：设置页、任务上保存时拒 */
export const OPENLIST_ROOT_TARGET = "目标目录不能是根 /：根上没有存储，复制不进去。填一个具体的目录，比如 /local/downloads";

/**
 * 复制的目标目录（设置页的默认值、任务上的、这一次指定的）：和 normConfigDir 一样归一，只是 OpenList 根 `/` 也算没填。
 * 根是虚拟目录，不属于任何存储，复制不进去；拿它当「只能在它下面选」的范围又等于没有范围。
 * 挂载根不走这个：存储可以直接挂在 `/` 上（见 toOpenlistPath）。
 * 前端 apps/frontend/src/lib/openlist-copy.ts 有一份同样的规则，改的时候两边一起动
 */
export function normTargetDir(input?: string): string {
  const dir = normConfigDir(input);
  return dir === "/" ? "" : dir;
}

/** 填了东西、归一后却是 OpenList 根（`/`、`//` 这种） */
export function isOpenlistRootInput(input?: string): boolean {
  return Boolean(input?.trim()) && !normTargetDir(input);
}

/** 去掉尾斜杠、补上头斜杠、把连着的斜杠收成一个；空的还它空串，让调用方按「没配置」处理 */
export function normDir(input?: string): string {
  const t = (input ?? "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!t.trim()) return (input ?? "").trim() === "/" ? "/" : "";
  return t.startsWith("/") ? t : `/${t}`;
}

/** 拼两段路径，中间只留一个斜杠 */
export function joinPath(base: string, rel: string): string {
  const head = base === "/" ? "" : base.replace(/\/+$/, "");
  const tail = rel.replace(/^\/+/, "");
  return tail ? `${head}/${tail}` : head || "/";
}

/** 路径的最后一段（条目名）；根目录返回空串。不 trim，网盘上的名字可能带空格 */
export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** 路径的父目录，带前导 /；顶层条目的父目录是 / */
export function parentDir(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

/** path 在 root 下面的相对路径；不在 root 下面返回 null */
export function relativeTo(root: string, path: string): string | null {
  const r = normDir(root);
  const p = normDir(path);
  if (r === "/" || r === "") return p.replace(/^\/+/, "");
  if (p === r) return "";
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}

/**
 * 网盘绝对路径 → OpenList 里的路径。没给这个账号配挂载根就返回 null，
 * 调用方据此说「这个账号还没配挂载根」，而不是猜一个路径出来复制到奇怪的地方。
 */
export function toOpenlistPath(mounts: Record<string, string>, account: string, drivePath: string): string | null {
  const mount = normDir(mounts[account]);
  if (!mount) return null;
  return mount === "/" ? normDir(drivePath) || "/" : joinPath(mount, drivePath);
}

/**
 * 这一条复制到哪个目录：把源路径相对「根」的那段目录结构原样搬到目标下面。
 * 监控报上来的是一个个深层文件（/tv/某剧/S01/E01.mkv），平铺过去几十集会挤在一个目录里还撞名。
 * 给不出根（或路径不在根下面）就平铺到 base，调用方会在 detail 里说明。
 */
export function dstDirFor(base: string, rootPath: string | undefined, srcPath: string): { dstDir: string; flattened: boolean } {
  if (!rootPath) return { dstDir: normDir(base), flattened: false };
  const rel = relativeTo(rootPath, srcPath);
  if (rel === null) return { dstDir: normDir(base), flattened: true };
  const sub = parentDir(`/${rel}`);
  return { dstDir: sub === "/" ? normDir(base) : joinPath(normDir(base), sub), flattened: false };
}

/**
 * 设置页的 openlistCopy + 账号表 → 可用的配置；缺什么直接说什么。
 * 引擎选 CloudDrive2 时用哪个 CD2 账号、挂载映射都来自设置页 CloudDrive2 那一节，不再要求 OpenList 账号
 */
export function resolveCopyConfig(settings: AppSettings = readAppSettings()): CopyConfig {
  const cfg = settings.openlistCopy ?? {};
  // 目标目录可以只在任务上填（设置页那个是默认值），所以这里不强求；真到要用时 enqueueCopy 会再看一次
  const dstDir = normTargetDir(cfg.dstDir);
  if (copyEngineOf(settings) === "cd2") {
    const state = cd2AccountState(settings);
    if (!state.ok) throw new HttpError(400, state.reason === "unset" ? `「复制」选了 CloudDrive2，但${cd2AccountProblem(state)}` : cd2AccountProblem(state)!);
    return { engine: "cd2", account: null, cd2: state.account, dstDir, mounts: cd2MountsOf(settings.cd2) };
  }
  const ol = resolveOpenlistMountConfig(settings);
  return { engine: "openlist", account: ol.account, cd2: null, dstDir, mounts: ol.mounts };
}

/**
 * 「复制到 OpenList」里 OpenList 自己的那部分：账号 + 各网盘的挂载根。和复制引擎选的是谁无关——
 * 挂载层刷新（mount-cache/openlist.ts）要的就是这个，复制引擎选了 CD2 的人 OpenList 挂载照样要刷
 */
export function resolveOpenlistMountConfig(settings: AppSettings = readAppSettings()): { account: AccountOpenlist; mounts: Record<string, string> } {
  const cfg = settings.openlistCopy ?? {};
  if (!cfg.account) {
    throw new HttpError(400, "「复制到 OpenList」还没配置好：请在设置页选一个 OpenList 账号");
  }
  const acc = getAccount(cfg.account);
  if (!acc) throw new HttpError(400, `OpenList 账号不存在：${cfg.account}`);
  if (acc.accountType !== "openlist") throw new HttpError(400, `${cfg.account} 不是 openlist 账号`);
  if (!acc.url || !acc.account || !acc.password) throw new HttpError(400, `OpenList 账号 ${cfg.account} 缺少地址或用户名/密码`);
  const mounts: Record<string, string> = {};
  for (const [name, path] of Object.entries(cfg.mounts ?? {})) {
    const norm = normConfigDir(path);
    if (norm) mounts[name] = norm;
  }
  return { account: acc, mounts };
}

/** 同上，没配 / 配错就 null（给挂载层刷新用） */
export function openlistMountConfigIfReady(settings: AppSettings = readAppSettings()): { account: AccountOpenlist; mounts: Record<string, string> } | null {
  try {
    return resolveOpenlistMountConfig(settings);
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}

/**
 * 只看设置：这个网盘账号要复制还缺哪样，null = 设置上齐了。顺序照设置页从上到下。
 * 不碰账号表——账号本身好不好使留到真提交时报错（要连账号表一起看的是 copyBlockerFor）。
 * 前端任务弹框里有一份同样的判断（apps/frontend/src/lib/openlist-copy.ts），改条件时两边一起动。
 */
export function copySettingsGap(account: string, settings: AppSettings = readAppSettings(), taskDstDir?: string): string | null {
  const cfg = settings.openlistCopy ?? {};
  if (copyEngineOf(settings) === "cd2") {
    if (!(settings.cd2?.account ?? "").trim()) return "复制选了 CloudDrive2，设置页的 CloudDrive2 一节还没选 CD2 账号";
    if (!cd2MountsOf(settings.cd2)[account]) return `账号 ${account} 还没填${copyMountFieldLabel("cd2")}`;
  } else {
    if (!cfg.account) return "设置页还没选 OpenList 账号";
    if (!normConfigDir(cfg.mounts?.[account])) return `账号 ${account} 还没填${copyMountFieldLabel("openlist")}`;
  }
  if (!normTargetDir(taskDstDir) && !normTargetDir(cfg.dstDir)) {
    // 填成 / 的（多半是以前存进去的）说清楚是 / 不算，不然「都没填」让人摸不着头脑
    const root = [isOpenlistRootInput(taskDstDir) && "任务上", isOpenlistRootInput(cfg.dstDir) && "设置页"].filter(Boolean).join("和");
    return root ? `没有目标目录：${root}填的是根 /，等于没填` : "没有目标目录：任务上和设置页都没填";
  }
  return null;
}

/** 挂载层账号（OpenList / CD2）的任务为什么没有复制；前端任务弹框里有一句同样的话 */
export const MOUNT_LAYER_TASK_NO_COPY = "OpenList / CloudDrive2 账号的任务用不着复制：转存、追更、云下载、监控都不会往这里落新文件";

/** 只看设置：挂载层账号、目标目录、这个网盘账号的挂载根都填了没有。给「要不要显示这个入口」用 */
export function copyConfigured(account: string, settings: AppSettings = readAppSettings(), taskDstDir?: string): boolean {
  return copySettingsGap(account, settings, taskDstDir) === null;
}

/**
 * 按任务回答「要复制的话卡在哪」，null = 能复制。任务列表的徽标、转存弹框的勾选框、
 * 明确要复制时的当场报错都看它，和真干活时同一套判断。
 *
 * 比 copySettingsGap 多看账号表：设置上齐了、选的 OpenList / CD2 账号却被删了、类型不对或缺凭据（resolveCopyConfig 会拒），
 * 或者任务本身挂在挂载层账号（OpenList / CD2）上（转存 / 追更 / 云下载 / 监控都不会往那种任务里落文件），一样复制不了。
 * 全局那部分只算一次，列表里每个任务只查表。
 */
export function copyBlockerFor(settings: AppSettings = readAppSettings()): (task: Pick<TaskDefinition, "account" | "copyToOpenlist">) => string | null {
  let global: string | null = null;
  // 压根没选账号的交给 copySettingsGap 说（话短），选了的才去账号表里核对
  const picked = copyEngineOf(settings) === "cd2" ? (settings.cd2?.account ?? "").trim() : settings.openlistCopy?.account;
  if (picked) {
    try {
      resolveCopyConfig(settings);
    } catch (err) {
      global = messageOf(err);
    }
  }
  const types = new Map(listAccounts().map((a) => [a.name, a.accountType]));
  return (task) => {
    if (isMountLayerKind(types.get(task.account))) return MOUNT_LAYER_TASK_NO_COPY;
    return global ?? copySettingsGap(task.account, settings, task.copyToOpenlist?.dstDir);
  };
}

/** copyOptionsFor 的结论 */
export interface CopyOptions {
  enabled: boolean;
  /** 这一次指定的、或任务上填的目标目录；都没有用设置页的默认目标目录 */
  dstDir?: string;
  /** 复制成功后源文件的去向 */
  afterCopy: CopyAfterCopy;
  /** 要复制却复制不了：卡在哪 */
  blocked?: string;
}

/**
 * 这一次复制什么参数。明说了就按它（弹框里的一次性勾选），否则按任务上的开关；
 * 全局没配好 / 这个账号没填挂载根一律当关——同「没配 TMDB key 就不自动整理」的路子。
 * 要复制却因此关掉的，blocked 里带着卡在哪：调用方记一笔，不然用户只看到「开着复制，什么都没发生」。
 *
 * **源文件的去向只认任务开关**：一次性勾的那个复选框上只写着「复制」，
 * 不能让它顺带把网盘上的源文件删了或挪了（任务上留着的旧设置也不行）。
 */
export function copyOptionsFor(
  task: Pick<TaskDefinition, "account" | "copyToOpenlist"> | null,
  forced: boolean | undefined,
  settings: AppSettings = readAppSettings(),
  /** 这一次指定的目标目录（云下载弹框里选的）：有它就不再要求任务上、设置页填了目标目录 */
  dstDir?: string,
): CopyOptions {
  const account = task?.account;
  const off: CopyOptions = { enabled: false, afterCopy: "keep" };
  const cfg = task?.copyToOpenlist;
  const byTask = cfg?.enabled === true;
  if (!account || !(forced ?? byTask)) return off;
  const dst = normTargetDir(dstDir) || normTargetDir(cfg?.dstDir) || undefined;
  const gap = copySettingsGap(account, settings, dst);
  if (gap) return { ...off, blocked: gap };
  return { enabled: true, dstDir: dst, afterCopy: byTask ? afterCopyOf(cfg) : "keep" };
}

/**
 * 这一次指定的复制目标能不能用，null = 能。只能是任务上填的目标目录、设置页的默认目标目录，或者它们下面的目录——
 * 界面和 Telegram 都是从这两个根往下选的；随便填的话能把东西复制进别的网盘的挂载里，开着删源还会删掉原件
 */
export function copyDstProblem(dstDir: string, task: Pick<TaskDefinition, "copyToOpenlist"> | null, settings: AppSettings = readAppSettings()): string | null {
  if (isOpenlistRootInput(dstDir)) return "复制目标不能是根 /：根上没有存储，复制不进去";
  const bases = [...new Set([normTargetDir(task?.copyToOpenlist?.dstDir), normTargetDir(settings.openlistCopy?.dstDir)].filter(Boolean))];
  if (bases.length === 0) return "任务上和设置页都没填复制的目标目录，没法指定这次复制到哪";
  if (bases.some((b) => relativeTo(b, dstDir) !== null)) return null;
  return `复制目标只能是 ${bases.join(" 或 ")}，或者它下面的目录`;
}

/**
 * 这一次指定的复制目标（转存 / 云下载的 copyDstDir、手动复制的 dstDir）能不能用，三条规则只在这里写一遍：
 *   路径得有效；这次得会复制（明说 copy: true，或任务开着复制——任务开着却传 copy: false 的要说清楚监控照样会复制，不能说成「这次不会复制」）；
 *   只能是任务上 / 设置页的目标目录或它们下面的目录（copyDstProblem）。
 * 没给（或空串）回 undefined，给了回归一过的路径；不行就抛 400 的 HttpError，code 是
 * VALIDATION / COPY_ALWAYS_ON / COPY_DST_UNUSED / COPY_DST_INVALID。REST、智能体、手动复制都走它，说法和代码才不会各漂各的
 */
export function checkCopyDstDir(
  task: Pick<TaskDefinition, "copyToOpenlist"> | null,
  copy: boolean | undefined,
  copyDstDir: string | undefined,
  settings: AppSettings = readAppSettings(),
): string | undefined {
  if (copyDstDir === undefined || copyDstDir.trim() === "") return undefined;
  const dst = normConfigDir(copyDstDir);
  if (!dst) throw new HttpError(400, "指定的复制目标不是一个有效的路径", { code: "VALIDATION" });
  const byTask = task?.copyToOpenlist?.enabled === true;
  if (copy === false && byTask) {
    throw new HttpError(400, "这个任务开着「复制到 OpenList」，这次没法不复制（网盘监控也会把新文件交给复制）：要指定这次复制到哪，就别传 copy: false", { code: "COPY_ALWAYS_ON" });
  }
  if (!(copy ?? byTask)) throw new HttpError(400, "给了 copyDstDir，但这次不会复制到 OpenList：要复制就带上 copy: true，不复制就别给 copyDstDir", { code: "COPY_DST_UNUSED" });
  const why = copyDstProblem(dst, task, settings);
  if (why) throw new HttpError(400, why, { code: "COPY_DST_INVALID" });
  return dst;
}

/** 只问「这次要不要复制」 */
export function copyEnabledFor(
  task: Pick<TaskDefinition, "account" | "copyToOpenlist"> | null,
  forced: boolean | undefined,
  settings: AppSettings = readAppSettings(),
): boolean {
  return copyOptionsFor(task, forced, settings).enabled;
}
