/**
 * 生成 strm / 下载附件时单个文件失败的分类：本地文件系统的 errno、网盘那边的账号问题 / 文件没了 / 网络抖动，
 * 归成一个类别，附上人话说明和下一步建议。全量同步、网盘监控、追更、云下载、整理镜像共用；
 * 页面和通知只显示这里给的文案，不再各自解释原始错误。
 *
 * 和 organize/failures.ts 的分工：那边管网盘上的改名 / 移动（写操作的结果），这边管本地落盘和取直链 / 下载。
 * 网盘错误里的事实（状态码、连不上、登录码）由 drive/errors.ts 给，这里不认具体网盘的错误类；
 * 账号问题（登录失效 / 风控）的判断也在那边（accountIssueOf），和整理那边同一份。
 */
import axios from "axios";
import type { FileFailureAction, FileFailureKind } from "@openstrm/shared";
import { isAbortError, messageOf, PermanentError } from "../../lib/errors.js";
import { accountIssueOf, driveErrorFacts } from "../drive/errors.js";
import type { DriveProvider } from "../drive/types.js";

export interface FileFailure {
  kind: FileFailureKind;
  /** task = 整轮停：磁盘满、没权限、只读、登录失效、风控 */
  scope: "file" | "task";
  /** 下载流的自动重试只重试它为 true 的 */
  retryable: boolean;
  /** 人话：出了什么事 */
  message: string;
  /** 下一步该做什么；认不出的错误为空 */
  advice: string;
  /** 原始错误文本 */
  detail: string;
  action?: FileFailureAction;
}

export interface FileFailureContext {
  /** 相对任务目录的路径（日志里显示的那个），「去整理」按钮靠它定位目录 */
  relPath: string;
  /** download 才会把 404 / 分享失效当成「文件没了」；strm 那边的网盘错误（转存、列目录）原样给 */
  kind: "strm" | "download";
  provider?: Pick<DriveProvider, "classifyError">;
  /** mirror：整理在本地挪 strm 时的失败，撞名是本地那边的事，建议要换个说法 */
  context?: "mirror";
}

/** 本地文件系统里换多少次都一样的错误 */
const FS_PERMANENT = new Set(["ENAMETOOLONG", "EINVAL", "ENOTDIR", "EISDIR", "EEXIST", "ENOTEMPTY", "ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "ELOOP"]);
/** 本地文件系统的临时错误：打开文件数超限、忙、NFS / SMB 掉线 */
const FS_TRANSIENT = new Set(["EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EIO", "ESTALE", "ENOTCONN", "ETXTBSY"]);
const NETWORK = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ERR_NETWORK", "ERR_BAD_RESPONSE", "ECANCELED"]);
/** SMB / NTFS / exFAT 不允许的文件名：这些字符，或结尾的点 / 空格 */
const ILLEGAL_NAME = /[:*?"<>|]|[. ]$/;

export const FILE_FAILURE_LABEL: Record<FileFailureKind, string> = {
  "name-too-long": "文件名过长",
  "invalid-name": "文件名含不允许的字符",
  "name-conflict": "同名文件和目录撞了",
  "no-space": "磁盘满",
  permission: "没有写入权限",
  "read-only": "只读挂载",
  "fs-transient": "本地临时错误",
  "io-error": "存储层出错",
  gone: "网盘上已没有",
  auth: "登录失效",
  blocked: "被风控",
  network: "网络错误",
  unknown: "其它错误",
};

/** 单段文件名的上限（ext4 / btrfs / APFS 都是 255 字节；一个汉字 3 字节） */
export const NAME_MAX_BYTES = 255;

const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf("/") + 1);

/** 这些路径里有没有超过 255 字节的一段；有就返回那一段。写文件前用实际要落盘的名字来查（strm 是 .strm，下载是 .part） */
export function overlongSegment(...paths: string[]): string | null {
  for (const p of paths) {
    for (const seg of p.split("/")) {
      if (Buffer.byteLength(seg, "utf8") > NAME_MAX_BYTES) return seg;
    }
  }
  return null;
}

/** 事前就知道写不进去时抛的错：和真正的 ENAMETOOLONG 一样分类，attempted=false 让日志页标「没去碰文件系统」 */
export function nameTooLongError(segment: string): NodeJS.ErrnoException & { attempted: false } {
  return Object.assign(new Error(`ENAMETOOLONG: name too long, ${segment}`), { code: "ENAMETOOLONG", syscall: "open", attempted: false as const });
}

/** 分类器认出来的三类固定文案 */
const INVALID_NAME = {
  message: "文件名含本地文件系统不允许的字符（: * ? \" < > | 或结尾的点 / 空格）",
  advice: "data 目录挂在 SMB / NTFS / exFAT 上就会这样：用「整理」改名会替换这些字符，或者把 data 换到 ext4 / btrfs 上",
};
const GONE = { message: "网盘上已经没有这个文件", advice: "不用处理：下次全量同步会把本地多余的清掉" };
const AUTH = { message: "账号登录失效", advice: "到「账户」页更新 cookie、密码或令牌（115 可以直接重新扫码），再重新同步" };
const BLOCKED = { message: "账号被网盘风控", advice: "停一会再跑，短时间内别再触发；看「账户」页的状态" };

export function classifyFileFailure(err: unknown, ctx: FileFailureContext): FileFailure {
  const detail = messageOf(err);
  const e = err as NodeJS.ErrnoException | undefined;
  const code = typeof e?.code === "string" ? e.code : "";
  const organize: FileFailureAction = { type: "organize", subPath: dirOf(ctx.relPath) };
  const account: FileFailureAction = { type: "account" };
  const make = (kind: FileFailureKind, scope: FileFailure["scope"], retryable: boolean, message: string, advice: string, action?: FileFailureAction): FileFailure => ({
    kind,
    scope,
    retryable,
    message,
    advice,
    detail,
    ...(action ? { action } : {}),
  });

  if (isAbortError(err)) return make("unknown", "file", false, "已取消", "");

  // 本地文件系统的错误先判：它的 message 里带本地路径，交给网盘的 classifyError 按文案猜会被路径里的「405」「cookie」带偏
  if (!axios.isAxiosError(err) && (FS_PERMANENT.has(code) || FS_TRANSIENT.has(code) || code === "ENOENT")) {
    const mirror = ctx.context === "mirror";
    switch (code) {
      case "ENAMETOOLONG":
        return mirror
          ? make("name-too-long", "file", false, `模板产出的名字超过本地文件系统允许的长度（单段最多 ${NAME_MAX_BYTES} 字节，一个汉字 3 字节）`, "缩短模板（去掉可选段）后重新预览", organize)
          : make("name-too-long", "file", false, `文件名超过本地文件系统允许的长度（单段最多 ${NAME_MAX_BYTES} 字节，一个汉字 3 字节）`, "用「整理」改成标准命名，或在网盘上把名字改短", organize);
      case "EINVAL":
        return make("invalid-name", "file", false, INVALID_NAME.message, INVALID_NAME.advice, organize);
      case "ENOTDIR":
      case "EISDIR":
      case "EEXIST":
      case "ENOTEMPTY":
        return mirror
          ? make("name-conflict", "file", false, "本地已经有同名的文件或目录挡着", "网盘上已经挪好了；在「strm 管理」里删掉或合并本地那份，再「重试」补本地")
          : make("name-conflict", "file", false, "路径上有同名的文件和目录撞在一起", "在网盘上改掉其中一个的名字；本地多出来的那个可以在「strm 管理」里删掉");
      case "ENOSPC":
      case "EDQUOT":
        return make("no-space", "task", false, "磁盘满了（data 目录所在的盘）", "清理或扩容 data 目录所在的磁盘，然后重新同步");
      case "EACCES":
      case "EPERM":
        return make("permission", "task", false, "没有写入 data 目录的权限", "检查 data 目录的属主和权限；改过 PUID / PGID 的话，之前用 root 生成的文件要 chown 一次");
      case "EROFS":
        return make("read-only", "task", false, "data 目录是只读挂载", "检查 docker-compose 里 data 目录的挂载参数");
      case "ELOOP":
        return make("io-error", "file", false, "路径里有软链接环", "检查 data 目录里的软链接");
      case "EMFILE":
      case "ENFILE":
        return make("fs-transient", "file", true, "打开的文件太多", "把设置里的下载并发调低一些，再重新同步", { type: "settings" });
      case "EAGAIN":
      case "EBUSY":
      case "ETXTBSY":
        return make("fs-transient", "file", true, `文件系统忙（${code}）`, "稍后再跑一次");
      case "ENOENT":
        // SMB / NTFS 上非法字符可能报 ENOENT（建目录那步就挂），所以每一段都要看
        if (ctx.relPath.split("/").some((seg) => ILLEGAL_NAME.test(seg))) return make("invalid-name", "file", false, INVALID_NAME.message, INVALID_NAME.advice, organize);
        return make("io-error", "file", true, "写到一半目录不见了", "检查 data 目录是不是被别的程序清理了，稍后再跑一次");
      default:
        return make("io-error", "file", true, `存储层出错（${code}）`, "检查 data 所在的磁盘或网络挂载，稍后再跑一次");
    }
  }

  // 网盘自己认出的账号问题：cookie 失效 / 风控都是整轮的事（只看接口回来的错误，路径里的「405」「cookie」不算，见 accountIssueOf）
  const facts = driveErrorFacts(err);
  const issue = accountIssueOf(ctx.provider, err);
  if (issue === "auth") return make("auth", "task", false, AUTH.message, AUTH.advice, account);
  if (issue === "blocked") return make("blocked", "task", false, BLOCKED.message, BLOCKED.advice, account);
  // 「文件没了」只在取直链 / 下载时成立；strm 那边（转存、列目录）的 404 和分享失效原样给
  if (ctx.kind === "download" && (issue === "gone" || err instanceof PermanentError || facts.status === 404 || facts.status === 410)) {
    return make("gone", "file", false, GONE.message, GONE.advice);
  }
  const transport = facts.transport || NETWORK.has(code);
  if (transport || facts.taskFailed || (facts.status !== undefined && (facts.status >= 500 || facts.status === 429))) {
    return make("network", "file", true, `取文件时网络出错（${code || facts.status || "连接失败"}）`, "已自动重试；仍失败就稍后再跑一次");
  }
  return make("unknown", "file", true, detail, "");
}

/**
 * 监控 / 追更 / 云下载 / 整理镜像里的一句话：认得出就「原因；建议（原文）」，认不出就原文。
 * 原文一定带上：这些地方只存这一句，分类错了也得留下真正的错误可查
 */
export function describeFileFailure(err: unknown, ctx: FileFailureContext): string {
  const f = classifyFileFailure(err, ctx);
  if (f.kind === "unknown" || !f.advice) return f.message;
  const raw = f.detail.length > 200 ? `${f.detail.slice(0, 200)}…` : f.detail;
  return `${f.message}；${f.advice}${raw && raw !== f.message ? `（${raw}）` : ""}`;
}

/** 执行历史 / 通知里的摘要：「5 个文件失败：文件名过长 3、磁盘满 2」；全认不出时列几个文件名 */
export function summarizeFailures(counts: Partial<Record<FileFailureKind, number>>, files: string[]): string {
  const total = files.length;
  const parts = (Object.entries(counts) as Array<[FileFailureKind, number]>)
    .filter(([k, n]) => n > 0 && k !== "unknown")
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${FILE_FAILURE_LABEL[k]} ${n}`);
  const unknown = counts.unknown ?? 0;
  if (unknown > 0) parts.push(`其它 ${unknown}`);
  if (parts.length === 0 || (parts.length === 1 && unknown === total)) {
    const shown = files.slice(0, 3).map(baseOf).join("、");
    return `${total} 个文件失败：${shown}${total > 3 ? " 等" : ""}`;
  }
  return `${total} 个文件失败：${parts.join("、")}`;
}
