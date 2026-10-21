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
import { Cloud115ApiError, fsDirGetId, getIdToPath, getDownloadUrlWeb, getFileInfoById, type FileInfo115 } from "../cloud-115/client.js";
import { classifyAccountIssue } from "../drive/errors.js";
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

/**
 * Alist 约定：路径里带账号名，形如 `/{账号名}/{115 路径}`。
 * 盘内路径带前导斜杠，和任务反查、路径映射给出的形态一致：库里的路径缓存按 `/tv/…` 存，不带的话这条路永远查不到
 */
function splitByAccountName(
  path: string,
  list: Account115[],
): { account: Account115; panPath: string } | null {
  for (const account of list) {
    const pattern = `/${account.name}/`;
    const idx = path.indexOf(pattern);
    if (idx !== -1) {
      return { account, panPath: `/${path.slice(idx + pattern.length)}` };
    }
  }
  return null;
}

/** 会碰 115 和库的几步抽成可替换的：单测不碰接口就能验缓存和短路 */
interface ResolverDeps {
  idToPath: typeof getIdToPath;
  dirIdByPath: typeof fsDirGetId;
  fileInfoById: typeof getFileInfoById;
  downloadUrl: typeof getDownloadUrlWeb;
  pathCacheFile: typeof findPathCacheFile;
}
const realDeps: ResolverDeps = { idToPath: getIdToPath, dirIdByPath: fsDirGetId, fileInfoById: getFileInfoById, downloadUrl: getDownloadUrlWeb, pathCacheFile: findPathCacheFile };
let pan: ResolverDeps = { ...realDeps };

/** 仅供测试：换掉会碰 115 / 库的部分；传 null 恢复 */
export function setResolverDeps(partial: Partial<ResolverDeps> | null): void {
  pan = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/** 解析时可带的选项：priority 是网盘请求的排队先后（throttle.ts 的 PRIORITY_*，预解析这种投机请求往后排） */
export interface ResolveOptions {
  priority?: number;
}

/** 碰 115 时带的上下文：UA、账号、排队先后 */
type PanCtx = { userAgent: string | undefined; accountInfo: Account115; priority?: number };

/**
 * 路径 → pickcode 的内存缓存。找路径要逐级列目录（冷的 1～3 个 115 请求）或按库里的 file_id 核对（1～2 个），
 * 而 pickcode 对一个文件是固定的，记 15 分钟（和直链缓存一样长）：同一条目换 UA 重取（Infuse 第二跳）、
 * 直链过期后重取，都只剩取链那一个请求。
 * 顺带记下文件 id 和记的时刻：库里的路径缓存这一行之后被人改过（整理换了文件、转存覆盖、监控看到改名），就不再信它，重新核对。
 * 不记更久：监控没开时外部换了同路径的文件，这段时间里会一直播旧的，窗口和以前直链缓存的差不多就够了
 */
interface PickcodeMemo {
  pickcode: string;
  /** 库路线核对过的文件 id；列目录来的没有 */
  fileId: string | null;
  /** 记下的时刻（毫秒） */
  at: number;
}
const MEMO_TTL_MS = 15 * 60 * 1000;
const pickcodeByPath = new LRUCache<string, PickcodeMemo>({ max: 20_000, ttl: MEMO_TTL_MS });

/** 换了 115 账号或改了挂载配置之后，按路径记的 pickcode 也不该再用 */
export function clearPathCache(): void {
  pickcodeByPath.clear();
}

const memoKey = (account: Account115, panPath: string): string => `${account.name}:${panPath}`;

/** 只忘掉一条路径的内存记录：起播诊断要量的是冷路径 */
export function forgetPanPath(embyPath: string): void {
  const located = locate(embyPath);
  if (located.ok) pickcodeByPath.delete(memoKey(located.account, located.panPath));
}

/** 同一路径正在找的那一次：Infuse 的第二跳常常紧跟着预热到，等它，别把同样的请求再发一遍 */
const finding = new Map<string, Promise<FoundPickcode | null>>();

export interface FoundPickcode {
  pickcode: string;
  via: PathVia;
  /** 核对过的文件 id；列目录找到的没有 */
  fileId: string | null;
}

/**
 * 库里的这一行还对得上网盘档案吗：文件名一样、还在正常区。
 * 父目录另外核对（inPlace）：行里记的 parent_id 多数是空的（Provider 列目录、整理挪文件时都不填），
 * 就算记了，上一级目录改过名它也照样对得上，所以不看它，按路径现问目录 id 再和档案里的父目录比
 */
export function pathCacheRowMatches(info: FileInfo115, row: { name: string; path: string }): boolean {
  if (info.area !== 1) return false;
  const name = row.name || row.path.split("/").pop() || "";
  return !name || info.name === name;
}

/**
 * 档案里的父目录就是「这条路径的目录」现在的 id 吗。目录 id 按路径问 115（进程内 10 分钟缓存；
 * 列目录那条路第一步也是它，核对失败退回列目录时不会白问）。根目录下的文件父目录是 0
 */
async function inPlace(info: FileInfo115, panPath: string, ctx: PanCtx): Promise<boolean> {
  const segs = panPath.split("/").filter(Boolean);
  if (segs.length <= 1) return info.parentId === "0";
  const dir = await pan.dirIdByPath(segs.slice(0, -1).join("/"), ctx);
  const id = dir?.id == null ? "" : String(dir.id);
  return !!id && id !== "0" && id === info.parentId;
}

/**
 * 115 回答了「不行」、而且不是登录失效 / 风控那类账号问题：多半是这条记录过期了（文件换了 / 没了），值得现找一次。
 * 网络不通、超时、登录失效、风控都不算：重找一遍只会再撞一次，还把真正的错误盖掉
 */
function isStaleAnswer(err: unknown): boolean {
  return err instanceof Cloud115ApiError && classifyAccountIssue(err.message) === null;
}

/** 库里这一行比内存记录新：有人（整理 / 转存 / 监控）改过它，内存里的不再可信。updated_at 是秒 */
function rowNewerThan(row: { updatedAt: number } | undefined, memo: PickcodeMemo): boolean {
  return !!row && row.updatedAt > Math.floor(memo.at / 1000);
}

function readRow(account: Account115, panPath: string): ReturnType<typeof findPathCacheFile> {
  try {
    return pan.pathCacheFile(account.name, panPath);
  } catch {
    return undefined; // 库读不了（代理进程库还没建好）就当没有这一行
  }
}

/**
 * 盘内路径 → pickcode；找不到回 null。三条路按代价排：
 * 1. 内存里记过（15 分钟内解析过同一路径、库里这一行此后没被改过）：0 个请求；
 * 2. 库里的路径缓存（转存 / 整理解析路径时写的，账号 + 路径 → file_id）：按 file_id 取档案核对文件名，
 *    再按路径问目录 id 核对父目录（目录 id 有 10 分钟缓存），1～2 个请求；对不上就当没命中——别让一条陈旧记录播错文件；
 * 3. 逐级列目录：冷的 1～3 个请求。
 * fresh = true 跳过前两条，列目录也不用进程内的缓存（取链失败后重找用：目录列表、按 id 取 pickcode 的缓存都可能是旧的）。
 * 同一路径同时来两次只找一次。
 * getIdToPath 找不到文件 / 目录时抛 PermanentError（网盘明确说没有），这里翻译成 null；
 * 网络 / 接口错误是别的类型，继续往上抛。按类型认、不按文案猜：接口报错的文案里也可能带着路径
 */
export async function findPickcode(
  account: Account115,
  panPath: string,
  userAgent: string | undefined,
  opts: { fresh?: boolean; priority?: number } = {},
): Promise<FoundPickcode | null> {
  const ctx: PanCtx = { userAgent, accountInfo: account, priority: opts.priority };
  if (opts.fresh) return findByListing(account, panPath, ctx, true);
  const key = memoKey(account, panPath);
  const running = finding.get(key);
  if (running) return running;
  const job = findCached(account, panPath, ctx).finally(() => finding.delete(key));
  finding.set(key, job);
  return job;
}

async function findCached(account: Account115, panPath: string, ctx: PanCtx): Promise<FoundPickcode | null> {
  const key = memoKey(account, panPath);
  const row = readRow(account, panPath);
  const memo = pickcodeByPath.get(key);
  if (memo) {
    if (!rowNewerThan(row, memo)) return { pickcode: memo.pickcode, via: "memo", fileId: memo.fileId };
    pickcodeByPath.delete(key); // 库里这一行改过了：重新核对
  }
  if (row) {
    try {
      const info = await pan.fileInfoById(row.fileId, ctx);
      if (info?.pickcode && pathCacheRowMatches(info, row) && (await inPlace(info, panPath, ctx))) {
        pickcodeByPath.set(key, { pickcode: info.pickcode, fileId: info.fileId, at: Date.now() });
        return { pickcode: info.pickcode, via: "db", fileId: info.fileId };
      }
      /* 文件没了或不在原处：这一行是旧的，退回逐级列目录，那一步自己会判断路径上现在是谁 */
    } catch (err) {
      // 115 说「不行」才退回列目录；网络不通、登录失效这些列目录也一样过不去，直接往上抛
      if (!isStaleAnswer(err)) throw err;
    }
  }
  return findByListing(account, panPath, ctx, false);
}

async function findByListing(account: Account115, panPath: string, ctx: PanCtx, fresh: boolean): Promise<FoundPickcode | null> {
  let pickcode: Awaited<ReturnType<typeof getIdToPath>>;
  try {
    pickcode = await pan.idToPath({ path: panPath, userAgent: ctx.userAgent, accountInfo: account, fresh, priority: ctx.priority });
  } catch (err) {
    if (err instanceof PermanentError) return null;
    throw err;
  }
  if (!pickcode) return null;
  pickcodeByPath.set(memoKey(account, panPath), { pickcode: String(pickcode), fileId: null, at: Date.now() });
  return { pickcode: String(pickcode), via: "list", fileId: null };
}

/**
 * 按 pickcode 取链。内存里记的 pickcode 取不到链（115 回「不行」或回空）可能只是它过期了（同路径换了文件），
 * 回 null 交给调用方重找；库里的刚核对过档案、现找的本来就是新的，取不到就是真失败，照常往上抛。
 * 网络不通、登录失效、风控这些不是记录过期，也照常抛：重找一遍只会再撞一次，还把真正的错误盖掉
 */
async function tryLink(found: FoundPickcode, ctx: PanCtx): Promise<string | null> {
  try {
    const url = await pan.downloadUrl(found.pickcode, ctx);
    return url || null;
  } catch (err) {
    if (found.via === "memo" && isStaleAnswer(err)) return null;
    throw err;
  }
}

async function toDirectUrl(
  account: Account115,
  panPath: string,
  userAgent: string | undefined,
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const ctx: PanCtx = { userAgent, accountInfo: account, priority: opts.priority };
  let pathMs = 0;
  let linkMs = 0;
  let t = performance.now();
  let found = await findPickcode(account, panPath, userAgent, { priority: opts.priority });
  pathMs += performance.now() - t;
  if (!found) return { ok: false, reason: "not-found" };

  t = performance.now();
  let url = await tryLink(found, ctx);
  linkMs += performance.now() - t;
  if (url === null && found.via === "memo") {
    // 内存里记的 pickcode 可能已经失效（同路径换了文件）：清掉，现找一次再取，别让它卡到过期
    pickcodeByPath.delete(memoKey(account, panPath));
    t = performance.now();
    found = await findPickcode(account, panPath, userAgent, { fresh: true, priority: opts.priority });
    pathMs += performance.now() - t;
    if (!found) return { ok: false, reason: "not-found" };
    t = performance.now();
    url = await tryLink(found, ctx);
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
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const located = locate(embyPath);
  if (!located.ok) return located;
  return toDirectUrl(located.account, located.panPath, userAgent, opts);
}

/**
 * 只把找路径这一段做掉（pickcode 进缓存），不取链。
 * 给 PlaybackInfo 之后的预热用：Infuse 这类第二跳换 UA 取流的客户端，按它问 PlaybackInfo 的 UA 换直链是白换的，
 * 但 pickcode 不分 UA，先找好路径，真来取流时就只剩取链那一个请求。
 */
export async function warmPanPath(embyPath: string, opts: ResolveOptions = {}): Promise<void> {
  const located = locate(embyPath);
  if (!located.ok) return;
  await findPickcode(located.account, located.panPath, undefined, { priority: opts.priority });
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

