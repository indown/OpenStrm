/**
 * 配置指纹，用来让代理进程的直链缓存能跨进程失效。
 *
 * 代理和 API 是两个进程，改账号 cookie、改 mediaMountPath 都发生在 API 那边，
 * 代理进程里的内存 LRU 收不到任何通知，所以缓存要自己解决失效。
 *
 * 做法是把指纹拼进缓存 key：配置一变，旧 key 自然再也命中不了。
 *
 * 指纹取"会影响解析结果的那些字段"的哈希，而不是表的 updated_at——
 * updated_at 是 unixepoch() 的秒级粒度，同一秒内改完配置就检测不到。
 */
import { createHash } from "node:crypto";
import { listAccounts } from "../db/repositories/accounts.js";
import { listTasks } from "../db/repositories/tasks.js";
import { readSettingsSafe } from "./settings-safe.js";

/** 指纹本身也缓存一下，别让每个请求都去扫三张表 */
const MEMO_MS = 5_000;
let memo = { value: "0", at: 0 };

function fingerprint(): string {
  const settings = readSettingsSafe();
  // 账号只取 name + cookie 的哈希：换了 cookie 必须让旧直链失效，
  // 但没必要把 cookie 原文带进内存里的 key。
  // 夸克不参与 302，而且它的 cookie 每次请求都可能轮换 __puus，算进去会让 115 的直链缓存跟着作废
  const accounts = listAccounts().map((a) => [
    a.name,
    a.accountType,
    createHash("sha1")
      .update("cookie" in a && a.accountType !== "quark" ? (a.cookie ?? "") : "")
      .digest("base64url")
      .slice(0, 8),
  ]);
  // enable302 决定这个任务的 strmPrefix 算不算挂载点，翻转它就该让旧直链失效
  const tasks = listTasks().map((t) => [t.account, t.strmPrefix ?? "", t.originPath ?? "", t.enable302 ? 1 : 0]);
  // 路径映射改了，同一条目可能换盘换目录；路由规则改了，缓存着直链的条目可能该交给 Emby 了
  const rules = { mappings: settings.emby?.pathMappings ?? [], routes: settings.emby?.routeRules ?? [] };

  return createHash("sha1")
    .update(JSON.stringify({ mount: settings.mediaMountPath ?? [], accounts, tasks, rules }))
    .digest("base64url")
    .slice(0, 12);
}

export function configRevision(): string {
  const now = Date.now();
  if (now - memo.at < MEMO_MS) return memo.value;

  let value: string;
  try {
    value = fingerprint();
  } catch {
    // 库还没迁移完就先用固定值，降级期间缓存照常工作
    value = "0";
  }

  memo = { value, at: now };
  return value;
}

/** 测试用：强制下次重新读库 */
export function resetConfigRevisionMemo(): void {
  memo = { value: "0", at: 0 };
}
