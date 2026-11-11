/**
 * 账号 → Provider 的分派，和「哪个账号能开这个分享链接」。
 * 功能代码只 import 这里，不直接碰 providers/。测试用 setDriveProviderFactory 换成内存假网盘。
 */
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { HttpError } from "../../lib/http-error.js";
import { Cd2Provider } from "./providers/cd2.js";
import { Cloud115Provider, parse115ShareLink } from "./providers/cloud115.js";
import { OpenlistProvider } from "./providers/openlist.js";
import { parseQuarkShareLink, QuarkProvider } from "./providers/quark.js";
import type { DriveCapabilities, DriveKind, DriveProvider, ShareProvider, ShareRef } from "./types.js";

export const KIND_LABEL: Record<DriveKind, string> = { "115": "115 网盘", quark: "夸克网盘", openlist: "OpenList", cd2: "CloudDrive2" };
const CAP_LABEL: Record<keyof DriveCapabilities, string> = { share: "分享转存", changes: "网盘监控", write: "整理（改名 / 移动）" };

export type ProviderFactory = (account: AccountInfo) => DriveProvider | null;
let override: ProviderFactory | null = null;

/** 仅供测试：返回 null 的账号照旧走真实现；传 null 恢复 */
export function setDriveProviderFactory(fn: ProviderFactory | null): void {
  override = fn;
}

/**
 * 分享访问的旁听者：影库据此记分享死活（services/library/health.ts）。只听不改，结果和异常原样返回。
 * at：root = 打开分享 / 看分享信息 / 列根目录（分享本身在不在），dir = 列某个子目录（那个目录在不在）
 */
export interface ShareObserver {
  ok(ref: ShareRef, at: "root" | "dir", dirId: string): void;
  fail(ref: ShareRef, err: unknown, at: "root" | "dir", dirId: string): void;
}

let shareObserver: ShareObserver | null = null;

export function setShareObserver(observer: ShareObserver | null): void {
  shareObserver = observer;
}

function observeShare(share: ShareProvider, obs: ShareObserver): ShareProvider {
  /** okCounts = false：成功不算数（115 的 open 是空操作、不问网盘，成了也不说明分享还在） */
  const watch = async <T>(ref: ShareRef, dirId: string, fn: () => Promise<T>, okCounts = true): Promise<T> => {
    const at = dirId === "" || dirId === "0" ? "root" : "dir";
    try {
      const out = await fn();
      if (okCounts) obs.ok(ref, at, dirId);
      return out;
    } catch (err) {
      obs.fail(ref, err, at, dirId);
      throw err;
    }
  };
  return {
    parseLink: (text) => share.parseLink(text),
    open: (ref, signal) => watch(ref, "", () => share.open(ref, signal), false),
    info: (s, signal) => watch(s.ref, "", () => share.info(s, signal)),
    list: (s, dirId, cursor, opts) => watch(s.ref, dirId || "0", () => share.list(s, dirId, cursor, opts)),
    resolvePath: (s, path, signal) => share.resolvePath(s, path, signal),
    receive: (s, items, toDirId, signal) => share.receive(s, items, toDirId, signal),
    ...(share.downloadUrl ? { downloadUrl: (s: Parameters<NonNullable<ShareProvider["downloadUrl"]>>[0], fileId: string) => share.downloadUrl!(s, fileId) } : {}),
    ...(share.updates ? { updates: share.updates } : {}),
  };
}

/**
 * 有旁听者时只把 share 换成旁听过的那个：Proxy 其余属性的读写都原样转给原对象（Provider 里没有 # 私有字段）
 */
function withObserver(provider: DriveProvider): DriveProvider {
  const obs = shareObserver;
  if (!obs || !provider.share) return provider;
  const share = observeShare(provider.share, obs);
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "share") return share;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Provider 只是薄包装，不缓存：账号对象每次现取，cookie 在账户页改过就直接用新的 */
export function providerFor(account: AccountInfo): DriveProvider {
  const custom = override?.(account);
  if (custom) return withObserver(custom);
  switch (account.accountType) {
    case "115":
      return withObserver(new Cloud115Provider(account));
    case "quark":
      return withObserver(new QuarkProvider(account));
    case "openlist":
      return new OpenlistProvider(account);
    case "cd2":
      return new Cd2Provider(account);
  }
  throw new Error(`Unknown account type: ${(account as { accountType?: string }).accountType}`);
}

export function providerForAccount(name: string, need?: keyof DriveCapabilities): DriveProvider {
  const account = getAccount(name);
  if (!account) throw new HttpError(400, `账号不存在：${name}`);
  const provider = providerFor(account);
  if (need && !provider.capabilities[need]) {
    throw new HttpError(400, `账号 ${name}（${KIND_LABEL[provider.kind]}）不支持${CAP_LABEL[need]}`);
  }
  return provider;
}

export function providerForTask(task: TaskDefinition, need?: keyof DriveCapabilities): DriveProvider {
  const account = getAccount(task.account);
  if (!account) throw new HttpError(400, `任务 ${task.id} 绑定的账号 ${task.account} 不存在`);
  const provider = providerFor(account);
  if (need && !provider.capabilities[need]) {
    throw new HttpError(400, `任务 ${task.id} 绑定的账号 ${task.account}（${KIND_LABEL[provider.kind]}）不支持${CAP_LABEL[need]}`);
  }
  return provider;
}

/* ------------------------------- 分享链接 ------------------------------- */

/** 不需要账号的纯解析：严格认域名的（夸克）先来，115 还认裸分享码所以放最后 */
export function parseShareRef(text: string): ShareRef | null {
  return parseQuarkShareLink(text) ?? parse115ShareLink(text);
}

/**
 * 一段话里的网址：到空白、引号、尖括号或者第一个非 ASCII 字符为止。分享链接都是 ASCII 的，
 * 「【https://115.com/s/…?password=u796】」「链接：https://…！提取码：…」里紧跟着的中文标点不能粘进链接
 */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'\u0080-\uffff]+/gi;
/** 句末粘在网址后面的英文标点：「(https://…)」「…u796.」 */
const URL_TRAILING = /[.,;!)\]}]+$/;
/**
 * 链接后面另写的提取码：提取码 / 访问码（115 的叫法）/ 密码 / 口令，冒号可有可无；「解压密码」是压缩包的，不算。
 * 夸克那边 providers/quark.ts 有一份一样的（注册表 import 它，放不到一处）
 */
const PASSCODE_IN_TEXT = /(?:提取码|访问码|(?<!解压)密码|口令)\s*[:：]?\s*([a-z0-9]{4,8})/i;

/**
 * 提取码另外给的（Telegram 消息正文、搜索结果的 password 字段）拼进链接；链接里本来就有的不动。
 * 拼在 # 前面、# 往后的去掉：115 的链接常以 # 结尾，拼到片段里再解析就读不到提取码了
 */
export function withPassword(ref: ShareRef, password: string): ShareRef {
  if (!password || ref.password) return ref;
  const base = ref.url.split("#")[0];
  const sep = base.includes("?") ? "&" : "?";
  return { ...ref, password, url: `${base}${sep}${ref.kind === "115" ? "password" : "pwd"}=${password}` };
}

/**
 * 用户贴进来的：可能就是链接（或 115 的裸分享码），也可能是「链接：… 提取码：…」一整段。
 * 先按一段话找链接，找不到再整个当链接解析
 */
export function parseShareText(text: string): ShareRef | null {
  return findShareLink(text) ?? parseShareRef(text.trim());
}

/** 从一段话里挑出分享链接（Telegram 消息）：只认 URL，提取码可以写在链接后面的文字里 */
export function findShareLink(text: string): ShareRef | null {
  for (const match of text.match(URL_IN_TEXT) ?? []) {
    const ref = parseShareRef(match.replace(URL_TRAILING, ""));
    if (ref) return withPassword(ref, PASSCODE_IN_TEXT.exec(text)?.[1] ?? "");
  }
  return null;
}

/**
 * 一段话里的全部分享链接（影库批量添加：一行一个，或者贴好几段「链接：… 提取码：…」），按出现的先后。
 * 提取码：只有一个链接时整段里找（和 findShareLink 一样，写在链接前面也认）；好几个时各找各的——链接后面、下一个链接前面那段。
 * 同一个分享（同一家、同一个码）只留一条：前面那条没提取码、后面的有，就用后面的。
 * 一个网址都没有时，整段是一个裸分享码（`swxxxx-提取码`）也认；一行一个的不认：随便一个英文词都能当成 115 的码
 */
export function findShareLinks(text: string): ShareRef[] {
  const found: Array<{ ref: ShareRef; start: number; end: number }> = [];
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const ref = parseShareRef(m[0].replace(URL_TRAILING, ""));
    if (ref) found.push({ ref, start: m.index, end: m.index + m[0].length });
  }
  if (found.length === 0) {
    const bare = parseShareRef(text.trim());
    return bare ? [bare] : [];
  }
  const out = new Map<string, ShareRef>();
  found.forEach((f, i) => {
    const scope = found.length === 1 ? text : text.slice(f.end, found[i + 1]?.start ?? text.length);
    const ref = withPassword(f.ref, PASSCODE_IN_TEXT.exec(scope)?.[1] ?? "");
    const key = `${ref.kind}:${ref.code}`;
    const prev = out.get(key);
    if (!prev || (!prev.password && ref.password)) out.set(key, ref);
  });
  return [...out.values()];
}

export interface ShareMatch {
  provider: DriveProvider;
  ref: ShareRef;
}

/**
 * 哪个账号能打开这个分享链接：先认出是哪家的，再在账号池里找同类且有分享能力的第一个。
 * 指定了 account 就只看它。认不出或没有账号返回 null。
 */
export function matchShareLink(text: string, opts: { account?: string; accounts?: AccountInfo[] } = {}): ShareMatch | null {
  const ref = parseShareText(text);
  if (!ref) return null;
  const provider = shareProviderForRef(ref, opts);
  return provider ? { provider, ref } : null;
}

/** 已经认出是哪家的分享：在账号池里挑同类且有分享能力的第一个（指定了 account 就只看它）。挑账号的规则只在这一处 */
export function shareProviderForRef(ref: ShareRef, opts: { account?: string; accounts?: AccountInfo[] } = {}): DriveProvider | null {
  const pool = (opts.accounts ?? listAccounts()).filter((a) => !opts.account || a.name === opts.account);
  for (const account of pool) {
    if (account.accountType !== ref.kind) continue;
    const provider = providerFor(account);
    if (provider.share) return provider;
  }
  return null;
}

/** 同上，但没人认出就抛 400 */
/** 认不出分享链接时的说法：界面、Telegram、智能体用同一句 */
export const UNKNOWN_SHARE_LINK = "不认识这个分享链接，目前支持 115 和夸克网盘的分享";

export function shareForLink(text: string, opts: { account?: string } = {}): ShareMatch {
  const hit = matchShareLink(text, opts);
  if (hit) return hit;
  const ref = parseShareText(text);
  if (!ref) throw new HttpError(400, UNKNOWN_SHARE_LINK);
  if (opts.account) throw new HttpError(400, `账号 ${opts.account} 打不开${KIND_LABEL[ref.kind]}的分享`);
  throw new HttpError(400, `这是${KIND_LABEL[ref.kind]}的分享，请先到「账户」页添加一个${KIND_LABEL[ref.kind]}账号`);
}

/** 分享的网盘必须和目标账号同类：115 的分享转不进夸克，反之亦然 */
export function assertSameKind(ref: ShareRef, target: DriveProvider): void {
  if (ref.kind !== target.kind) {
    throw new HttpError(400, `这是${KIND_LABEL[ref.kind]}的分享，不能转存到${KIND_LABEL[target.kind]}账号的任务里`);
  }
}
