/**
 * 115 直链解析。
 *
 * 调用方是 Emby 302 路由：拿到的是 strm 文件里写的路径，形如
 * `${strmPrefix}/${originPath}/${相对路径}`，需要先剥掉挂载前缀，
 * 再反查任务表确定是哪个账号的盘。前缀既可以是本地挂载路径（`/mnt/115/主号`），
 * 也可以是 OpenList 的 `/d/` 地址（`http://host:5244/d/115`）：后者换不到直链时回给 Emby，
 * Emby 按 strm 里的 URL 自己去拉，所以不需要本机有挂载。
 *
 * 直链和请求时用的 UA 是绑定的，所以 UA 必须由调用方传进来——
 * 302 场景要用客户端自己的 UA，否则客户端拿着这条链接去下会被 115 拒掉。
 */
import { LRUCache } from "lru-cache";
import type { AccountInfo, AppSettings, DirectLinkFailure, ProxyPathMapping, TaskDefinition } from "@openstrm/shared";
import { listAccounts } from "../../db/repositories/accounts.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { readSettingsSafe } from "../settings-safe.js";
import { findPathCacheFile } from "../../db/repositories/life.js";
import { getIdToPath, getDownloadUrlWeb, getFileInfoById, type FileInfo115 } from "../cloud-115/client.js";
import { PermanentError } from "../../lib/errors.js";

type Account115 = Extract<AccountInfo, { accountType: "115" }>;

/** 失败原因的定义在 shared 里（起播诊断要把它回给前端），这里只是别名 */
export type ResolveFailure = DirectLinkFailure;

/** 找路径走的是哪条路：内存里记着 pickcode / 库里的路径缓存给了 file_id / 逐级列目录 */
export type PathVia = "memo" | "db" | "list";

/** 解析用了多久：找路径和取链各一段，毫秒，整数；起播诊断和 302 日志都靠它 */
export interface ResolveTimings {
  pathMs: number;
  linkMs: number;
  pathVia: PathVia;
}

/** 判别联合：ok 为 true 时直链和归属账号一定都有，调用方不用再逐个判空 */
export type ResolveResult =
  | { ok: true; url: string; accountName: string; panPath: string; timings: ResolveTimings }
  | { ok: false; reason: ResolveFailure };

/** strm 落盘时可能被 encodeURI 过（任务的 enablePathEncoding），解不开就按原样用 */
import { safeDecode } from "../strm/naming.js";
// 老调用方还从这里拿 safeDecode，保留导出
export { safeDecode };

/**
 * 合并重复斜杠。originPath 带不带前导 `/` 都有人这么配，拼出来会有 `//`。
 * scheme 后面的 `//` 得留着：前缀是 `http://host/d` 时压成 `http:/` 就和任务里的前缀永远对不上了。
 */
export function normalizeMediaPath(p: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(p);
  const head = scheme ? scheme[0] : "";
  return head + p.slice(head.length).replace(/\/{2,}/g, "/");
}

function trimTrailing(p: string): string {
  return p.replace(/\/+$/, "");
}

/** 挂载前缀的比较形态：手填的、任务里的、Emby 报上来的路径都先过这一步，两边才对得上 */
function normalizeMount(p: string): string {
  return trimTrailing(normalizeMediaPath(p));
}

function accounts115(): Account115[] {
  return listAccounts().filter((a): a is Account115 => a.accountType === "115");
}

/**
 * 剥掉 mediaMountPath 前缀。多个前缀时取最长匹配，
 * 避免 `/mnt/115` 和 `/mnt/115-4k` 这种互为前缀的配置选错。
 * 路径和前缀都先归一化（重复斜杠、尾斜杠），返回的 mount 是归一化后的形态。
 */
export function stripMountPath(
  rawPath: string,
  mountPaths: string[],
): { mount: string; rest: string } | null {
  const path = normalizeMediaPath(rawPath);
  const candidates = [...new Set(mountPaths.filter(Boolean).map(normalizeMount))].sort(
    (a, b) => b.length - a.length,
  );
  for (const mount of candidates) {
    if (path === mount) return { mount, rest: "/" };
    if (path.startsWith(`${mount}/`)) return { mount, rest: path.slice(mount.length) };
  }
  return null;
}

/**
 * 代理接管的挂载前缀 = 设置里手填的 mediaMountPath ∪ 手填路径映射的 from ∪ 开了 302 的任务的 strmPrefix。
 *
 * 任务那一半现算而不落库：以前是建任务时追加进 settings，删任务、关 302 都不会摘掉，
 * 列表只增不减，早就删掉的前缀还在被代理接管。
 */
export function mountPathsFromTasks(tasks: TaskDefinition[]): string[] {
  return tasks.filter((t) => t.enable302 && t.strmPrefix).map((t) => normalizeMount(t.strmPrefix!));
}

/** 填齐了 from 和 account 的映射才算数：界面上刚点「添加」还没填的那一行不能把 `/` 当成前缀接管一切 */
function usableMappings(mappings: ProxyPathMapping[] | undefined): ProxyPathMapping[] {
  return (mappings ?? []).filter((m) => m.from?.trim() && m.account?.trim());
}

export function effectiveMountPaths(settings: AppSettings, tasks: TaskDefinition[]): string[] {
  const manual = (settings.mediaMountPath ?? []).filter(Boolean).map(normalizeMount);
  const mapped = usableMappings(settings.emby?.pathMappings).map((m) => normalizeMount(m.from));
  return [...new Set([...manual, ...mapped, ...mountPathsFromTasks(tasks)])];
}

/**
 * 手填的路径映射：Emby 路径前缀 → 账号 + 网盘目录。
 * 和挂载点一样取最长前缀、按目录边界；同一个前缀写了两条取第一条（保存时会拒掉重复的，这里只是兜底）。
 */
export function matchPathMapping(
  rawPath: string,
  mappings: ProxyPathMapping[] | undefined,
): { mapping: ProxyPathMapping; rest: string } | null {
  const usable = usableMappings(mappings);
  if (usable.length === 0) return null;
  const stripped = stripMountPath(rawPath, usable.map((m) => m.from));
  if (!stripped) return null;
  const mapping = usable.find((m) => normalizeMount(m.from) === stripped.mount);
  return mapping ? { mapping, rest: stripped.rest } : null;
}

/** 映射的目标目录拼上剩余路径：`/视频` + `/tv/a.mkv` → `/视频/tv/a.mkv`；目标不填就是根目录 */
export function joinPanPath(to: string | undefined, rest: string): string {
  const base = trimTrailing(normalizeMediaPath(`/${(to ?? "").trim()}`));
  const tail = rest === "/" ? "" : rest;
  return normalizeMediaPath(`${base}${tail}`) || "/";
}

/**
 * 当前生效的挂载前缀，供代理侧按请求现算。
 * 任务表读不到（库还没建好）时只用手填的那份——和 readSettingsSafe 的降级口径一致。
 */
export function currentMountPaths(): string[] {
  let tasks: TaskDefinition[] = [];
  try {
    tasks = listTasks();
  } catch {
    /* 库不可用：readSettingsSafe 同样会退成空配置，这里就只看手填的 */
  }
  return effectiveMountPaths(readSettingsSafe(), tasks);
}

/**
 * 反查任务表：哪个任务用的就是这个 strmPrefix、且它的 originPath 正好是这条路径的前缀，
 * 那这个文件就在该任务的账号里。比在路径里找账号名靠谱——strm 路径里根本没有账号名。
 */
export function accountNameByTask(
  mount: string,
  rest: string,
  tasks: TaskDefinition[],
): string | null {
  // 取最长（最具体）的 originPath，和 services/life/handlers.ts 的 matchTask 保持一致。
  // 取第一个命中的话，/tv 和 /tv/anime 两个任务并存时会按任务顺序选错盘。
  let best: { account: string; length: number } | null = null;
  for (const t of tasks) {
    if (!t.strmPrefix || normalizeMount(t.strmPrefix) !== mount) continue;
    const origin = trimTrailing(normalizeMediaPath(`/${t.originPath ?? ""}`));
    // originPath 为空或就是根，说明整个挂载点都是这个任务的
    const matched = !origin || origin === "/" || rest === origin || rest.startsWith(`${origin}/`);
    if (!matched) continue;
    if (!best || origin.length > best.length) best = { account: t.account, length: origin.length };
  }
  return best?.account ?? null;
}

/** Alist 约定：路径里带账号名，形如 `/{账号名}/{115 路径}` */
function splitByAccountName(
  path: string,
  list: Account115[],
): { account: Account115; panPath: string } | null {
  for (const account of list) {
    const pattern = `/${account.name}/`;
    const idx = path.indexOf(pattern);
    if (idx !== -1) {
      return { account, panPath: path.slice(idx + pattern.length) };
    }
  }
  return null;
}

/** 会碰 115 和库的几步抽成可替换的：单测不碰接口就能验缓存和短路 */
interface ResolverDeps {
  idToPath: typeof getIdToPath;
  fileInfoById: typeof getFileInfoById;
  downloadUrl: typeof getDownloadUrlWeb;
  pathCacheFile: typeof findPathCacheFile;
}
const realDeps: ResolverDeps = { idToPath: getIdToPath, fileInfoById: getFileInfoById, downloadUrl: getDownloadUrlWeb, pathCacheFile: findPathCacheFile };
let pan: ResolverDeps = { ...realDeps };

/** 仅供测试：换掉会碰 115 / 库的部分；传 null 恢复 */
export function setResolverDeps(partial: Partial<ResolverDeps> | null): void {
  pan = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/**
 * 路径 → pickcode 的缓存。找路径要逐级列目录（冷的 1～3 个 115 请求），而 pickcode 对一个文件是固定的，
 * 记一个小时：同一条目换 UA 重取（Infuse 第二跳）、直链 15 分钟过期后重取，都只剩取链那一个请求。
 * 文件被整理挪走了：旧路径的 pickcode 仍指向同一个文件，照样能播；删了的话取链失败回源，和没缓存一样。
 */
const pickcodeByPath = new LRUCache<string, string>({ max: 20_000, ttl: 60 * 60 * 1000 });

/** 换了 115 账号或改了挂载配置之后，按路径记的 pickcode 也不该再用 */
export function clearPathCache(): void {
  pickcodeByPath.clear();
}

const memoKey = (account: Account115, panPath: string): string => `${account.name}:${panPath}`;

/**
 * 库里的这一行还对得上网盘现状吗：文件名一样、父目录一样、还在正常区。
 * 对不上就是文件被挪走 / 改名 / 进了回收站，而这一行没人更新（生活事件监控没开时外部改动不会写进来），
 * 照它取链会无声播错文件。parent_id 是 0 的老行只核对文件名
 */
export function pathCacheRowMatches(info: FileInfo115, row: { parentId: string; name: string; path: string }): boolean {
  if (info.area !== 1) return false;
  const name = row.name || row.path.split("/").pop() || "";
  if (name && info.name !== name) return false;
  if (row.parentId && row.parentId !== "0" && info.parentId !== row.parentId) return false;
  return true;
}

/**
 * 盘内路径 → pickcode；找不到回 null。三条路按代价排：
 * 1. 内存里记过（一小时内解析过同一路径）：0 个请求；
 * 2. 库里的路径缓存（转存 / 整理解析路径时写的，账号 + 路径 → file_id）：1 个请求（按 file_id 取档案，
 *    顺便核对文件名和父目录，对不上就当没命中——别让一条陈旧记录播错文件或把播放卡死）；
 * 3. 逐级列目录：冷的 1～3 个请求。
 * fresh = true 跳过前两条（取链失败后重找用）。
 * getIdToPath 找不到文件 / 目录时抛 PermanentError（网盘明确说没有），这里翻译成 null；
 * 网络 / 接口错误是别的类型，继续往上抛。按类型认、不按文案猜：接口报错的文案里也可能带着路径
 */
export async function findPickcode(
  account: Account115,
  panPath: string,
  userAgent: string | undefined,
  opts: { fresh?: boolean } = {},
): Promise<{ pickcode: string; via: PathVia } | null> {
  const key = memoKey(account, panPath);
  if (!opts.fresh) {
    const cached = pickcodeByPath.get(key);
    if (cached) return { pickcode: cached, via: "memo" };

    let row: ReturnType<typeof findPathCacheFile>;
    try {
      row = pan.pathCacheFile(account.name, panPath);
    } catch {
      row = undefined; // 库读不了（代理进程库还没建好）就走列目录
    }
    if (row) {
      try {
        const info = await pan.fileInfoById(row.fileId, { userAgent, accountInfo: account });
        if (info?.pickcode && pathCacheRowMatches(info, row)) {
          pickcodeByPath.set(key, info.pickcode);
          return { pickcode: info.pickcode, via: "db" };
        }
        /* 文件没了或不在原处：这一行是旧的，退回逐级列目录，那一步自己会判断路径上现在是谁 */
      } catch {
        /* 接口报错：退回逐级列目录 */
      }
    }
  }

  let pickcode: Awaited<ReturnType<typeof getIdToPath>>;
  try {
    pickcode = await pan.idToPath({ path: panPath, userAgent, accountInfo: account });
  } catch (err) {
    if (err instanceof PermanentError) return null;
    throw err;
  }
  if (!pickcode) return null;
  pickcodeByPath.set(key, String(pickcode));
  return { pickcode: String(pickcode), via: "list" };
}

/**
 * 按 pickcode 取链。缓存来的 pickcode 取不到链可能只是它过期了（文件换了），回 null 交给调用方重找；
 * 现找的 pickcode 取不到链就是真失败，照常往上抛
 */
async function tryLink(found: { pickcode: string; via: PathVia }, account: Account115, userAgent: string | undefined): Promise<string | null> {
  try {
    const url = await pan.downloadUrl(found.pickcode, { userAgent, accountInfo: account });
    return url || null;
  } catch (err) {
    if (found.via === "list") throw err;
    return null;
  }
}

async function toDirectUrl(
  account: Account115,
  panPath: string,
  userAgent: string | undefined,
): Promise<ResolveResult> {
  let pathMs = 0;
  let linkMs = 0;
  let t = performance.now();
  let found = await findPickcode(account, panPath, userAgent);
  pathMs += performance.now() - t;
  if (!found) return { ok: false, reason: "not-found" };

  t = performance.now();
  let url = await tryLink(found, account, userAgent);
  linkMs += performance.now() - t;
  if (url === null && found.via !== "list") {
    // 内存 / 库里记的 pickcode 可能已经失效（同路径换了文件）：清掉，现找一次再取，别让它卡一小时
    pickcodeByPath.delete(memoKey(account, panPath));
    t = performance.now();
    found = await findPickcode(account, panPath, userAgent, { fresh: true });
    pathMs += performance.now() - t;
    if (!found) return { ok: false, reason: "not-found" };
    t = performance.now();
    url = await tryLink(found, account, userAgent);
    linkMs += performance.now() - t;
  }
  if (!url) return { ok: false, reason: "no-url" };

  return {
    ok: true,
    url,
    accountName: account.name,
    panPath,
    timings: { pathMs: Math.round(pathMs), linkMs: Math.round(linkMs), pathVia: found.via },
  };
}

type Located = { ok: true; account: Account115; panPath: string } | { ok: false; reason: ResolveFailure };

/**
 * Emby 看到的路径 → 115 直链。
 *
 * 路径不在挂载点下时返回 `not-mounted`，调用方据此回源——本地文件不该被 302 掉。
 * 115 侧的网络/接口错误会抛出，由调用方兜底。
 */
export async function resolveEmbyPath(
  embyPath: string,
  userAgent?: string,
): Promise<ResolveResult> {
  const located = locate(embyPath);
  if (!located.ok) return located;
  return toDirectUrl(located.account, located.panPath, userAgent);
}

/**
 * 只把找路径这一段做掉（pickcode 进缓存），不取链。
 * 给 PlaybackInfo 之后的预热用：Infuse 这类第二跳换 UA 取流的客户端，按它问 PlaybackInfo 的 UA 换直链是白换的，
 * 但 pickcode 不分 UA，先找好路径，真来取流时就只剩取链那一个请求。
 */
export async function warmPanPath(embyPath: string): Promise<void> {
  const located = locate(embyPath);
  if (!located.ok) return;
  await findPickcode(located.account, located.panPath, undefined);
}

/** 路径归哪个账号、盘内路径是什么：路径映射 → 任务反查 → Alist 式账号名 → 第一个账号 */
function locate(embyPath: string): Located {
  const settings = readSettingsSafe();
  const decoded = safeDecode(embyPath);

  /**
   * 手填的路径映射优先：它就是为任务推不出来的那部分路径准备的，推得出来的本来也不用填。
   * 命中了就只认它指向的账号——账号被删 / 改名 / 不是 115 时报错回源，不能落到别的账号上。
   */
  const mapped = matchPathMapping(decoded, settings.emby?.pathMappings);
  if (mapped) {
    const account = accounts115().find((a) => a.name === mapped.mapping.account);
    if (!account) return { ok: false, reason: "no-account" };
    return { ok: true, account, panPath: joinPanPath(mapped.mapping.to, mapped.rest) };
  }

  /**
   * 先判挂载点再判账号。反过来的话，没配 115 账号时每次播本地文件
   * 都会记一条 no-account 的 warn——而"这个路径不归我们管"才是实情，
   * 跟有没有账号无关。
   */
  const tasks = listTasks();
  const stripped = stripMountPath(decoded, effectiveMountPaths(settings, tasks));
  if (!stripped) return { ok: false, reason: "not-mounted" };

  const list = accounts115();
  if (list.length === 0) return { ok: false, reason: "no-account" };

  const byTaskName = accountNameByTask(stripped.mount, stripped.rest, tasks);
  if (byTaskName) {
    const taskAccount = list.find((a) => a.name === byTaskName);
    /**
     * 认出了归属任务，就只认它的账号。
     * 找不到（账号被改名/删了，或本来就不是 115 账号）时必须报错，
     * 绝不能落到"第一个 115 账号"——各盘目录结构往往是镜像的，
     * 那样会 302 到另一部同名影片，而且一声不吭。
     */
    if (!taskAccount) return { ok: false, reason: "no-account" };
    return { ok: true, account: taskAccount, panPath: stripped.rest };
  }

  // 任务表反查不到，退回 Alist 那套：路径里找账号名，再不行用第一个账号
  const matched = splitByAccountName(stripped.rest, list);
  return { ok: true, account: matched?.account ?? list[0], panPath: matched?.panPath ?? stripped.rest };
}

