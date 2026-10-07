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
import type { AccountInfo, AppSettings, ProxyPathMapping, TaskDefinition } from "@openstrm/shared";
import { listAccounts } from "../../db/repositories/accounts.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { readSettingsSafe } from "../settings-safe.js";
import { getIdToPath, getDownloadUrlWeb } from "../cloud-115/client.js";
import { PermanentError } from "../../lib/errors.js";

type Account115 = Extract<AccountInfo, { accountType: "115" }>;

export type ResolveFailure =
  /** 没有能用的 115 账号：一个都没配，或者任务 / 路径映射指向的账号已删、改名、不是 115 */
  | "no-account"
  /** 路径不在任何 mediaMountPath 之下，不该由我们接管 */
  | "not-mounted"
  /** 盘里找不到这个文件 */
  | "not-found"
  /** 找到了文件但拿不到直链 */
  | "no-url";

/** 判别联合：ok 为 true 时直链和归属账号一定都有，调用方不用再逐个判空 */
export type ResolveResult =
  | { ok: true; url: string; accountName: string; panPath: string }
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

async function toDirectUrl(
  account: Account115,
  panPath: string,
  userAgent: string | undefined,
): Promise<ResolveResult> {
  // getIdToPath 找不到文件 / 目录时抛 PermanentError（网盘明确说没有），这里翻译成 not-found；
  // 网络 / 接口错误是别的类型，继续往上抛。按类型认、不按文案猜：接口报错的文案里也可能带着路径
  let pickcode: Awaited<ReturnType<typeof getIdToPath>>;
  try {
    pickcode = await getIdToPath({ path: panPath, userAgent, accountInfo: account });
  } catch (err) {
    if (err instanceof PermanentError) return { ok: false, reason: "not-found" };
    throw err;
  }
  if (!pickcode) return { ok: false, reason: "not-found" };

  const url = await getDownloadUrlWeb(pickcode, { userAgent, accountInfo: account });
  if (!url) return { ok: false, reason: "no-url" };

  return { ok: true, url, accountName: account.name, panPath };
}

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
    return toDirectUrl(account, joinPanPath(mapped.mapping.to, mapped.rest), userAgent);
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
    return toDirectUrl(taskAccount, stripped.rest, userAgent);
  }

  // 任务表反查不到，退回 Alist 那套：路径里找账号名，再不行用第一个账号
  const matched = splitByAccountName(stripped.rest, list);
  return toDirectUrl(matched?.account ?? list[0], matched?.panPath ?? stripped.rest, userAgent);
}

