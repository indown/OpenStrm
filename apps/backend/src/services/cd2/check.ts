/**
 * 「检查连接」：对着一个 CloudDrive2 连一次，各段各自成败——地址通不通、凭据对不对、令牌的权限够不够、
 * 每个挂载映射在 CD2 里列不列得出来。账户弹框（还没保存的草稿）和设置页「网盘挂载」「复制」两节（已保存的账号）共用。不回任何令牌。
 */
import type { Cd2CheckResult, Cd2TokenUse } from "@openstrm/shared";
import { getAccount } from "../../db/repositories/accounts.js";
import { messageOf } from "../../lib/errors.js";
import { GRPC_STATUS } from "../../lib/grpc.js";
import { resolveSecret } from "../../lib/secrets.js";
import { Cd2Error, cd2CopyTasks, cd2ListDir, cd2SystemInfo, cd2Token, cd2TokenInfo, type Cd2Connection, type Cd2Permissions, type Cd2TokenInfo } from "./client.js";
import { cd2MountsOf } from "./config.js";

export interface Cd2CheckInput {
  /** 账户页里 CD2 账号的名字：没给 url 时查它存着的那份；给了 url 时掩码的令牌 / 口令按它的原值还原 */
  account?: string;
  /** 给了就按这份草稿验（账户弹框里还没保存的值） */
  url?: string;
  apiToken?: string;
  username?: string;
  password?: string;
  /** 网盘账号名 → 它在 CD2 里的路径；带了就逐个列一下。设置页不带：映射在「网盘挂载」里逐行经目录浏览接口查（还核对任务目录） */
  mounts?: Record<string, string>;
}

/** 权限在 CD2 生成令牌那一页上的叫法（2026-11-10 对着 lab 里 CD2 网页的文案核过） */
const PERMISSION_LABEL: Record<keyof Cd2Permissions, string> = {
  list: "列出文件",
  read: "读取文件",
  createFolder: "创建文件夹",
  rename: "重命名",
  move: "移动",
  copy: "复制",
  delete: "删除",
  transferTasks: "获取传输任务",
};

/** 每种用途要哪些权限。复制那行的「创建文件夹」：目标子目录不存在时要先建，建不了 CopyFile 会一直等 */
const TOKEN_USES: Array<{ use: Cd2TokenUse; label: string; needs: Array<keyof Cd2Permissions> }> = [
  { use: "browse", label: "浏览和刷新目录", needs: ["list"] },
  { use: "sync", label: "同步", needs: ["list", "read"] },
  { use: "organize", label: "整理", needs: ["list", "createFolder", "rename", "move", "delete"] },
  { use: "copy", label: "复制", needs: ["list", "copy", "transferTasks", "createFolder"] },
];

/** 令牌的权限表 → 按用途说够不够 */
export function describeTokenPermissions(info: Cd2TokenInfo): NonNullable<Cd2CheckResult["permissions"]> {
  const missing = TOKEN_USES.map(({ use, needs }) => ({ use, lacks: needs.filter((p) => !info.permissions[p]).map((p) => PERMISSION_LABEL[p]) })).filter((m) => m.lacks.length > 0);
  const labelOf = (use: Cd2TokenUse): string => TOKEN_USES.find((u) => u.use === use)!.label;
  const scope = info.rootDir ? `；令牌限定在 ${info.rootDir} 下` : "";
  const message =
    missing.length === 0
      ? `令牌权限齐全：${TOKEN_USES.map((u) => u.label).join("、")}都够${scope}`
      : `令牌缺权限：${missing.map((m) => `${labelOf(m.use)}缺${m.lacks.map((l) => `「${l}」`).join("")}`).join("；")}${scope}`;
  return { ok: missing.length === 0, message, ...(info.rootDir ? { rootDir: info.rootDir } : {}), missing };
}

/** 要验的是哪一份连接：草稿（掩码换回账号里存的原值），或者账号里存着的。验不了的说原因 */
function connectionOf(input: Cd2CheckInput): { conn: Cd2Connection } | { problem: string } {
  const name = (input.account ?? "").trim();
  const stored = name ? getAccount(name) : null;
  const saved = stored?.accountType === "cd2" ? stored : null;
  if (input.url !== undefined) {
    const url = input.url.trim();
    if (!url) return { problem: "还没填地址" };
    return { conn: { url, apiToken: resolveSecret(input.apiToken, saved?.apiToken), username: input.username, password: resolveSecret(input.password, saved?.password) } };
  }
  if (!name) return { problem: "还没选 CD2 账号" };
  if (!stored) return { problem: `CloudDrive2 账号不存在：${name}` };
  if (!saved) return { problem: `${name} 不是 CloudDrive2 账号` };
  if (!(saved.url ?? "").trim()) return { problem: `CloudDrive2 账号 ${name} 还没填地址` };
  return { conn: saved };
}

export async function checkCd2(input: Cd2CheckInput): Promise<Cd2CheckResult> {
  const target = connectionOf(input);
  if ("problem" in target) return { system: { ok: false, message: target.problem }, auth: { ok: false, message: target.problem }, mounts: [] };
  const probe = target.conn;
  let system: Cd2CheckResult["system"];
  try {
    const info = await cd2SystemInfo(probe);
    system = {
      ok: true,
      loggedIn: info.loggedIn,
      userName: info.userName,
      message: info.loggedIn ? `连上了，CD2 已登录${info.userName ? `（${info.userName}）` : ""}` : "连上了，但 CD2 自己还没登录云盘账号",
    };
  } catch (err) {
    system = { ok: false, message: messageOf(err) };
  }
  const apiToken = (probe.apiToken ?? "").trim();
  const username = (probe.username ?? "").trim();
  const conn: Cd2Connection | null = apiToken ? { url: probe.url, apiToken } : username && probe.password ? { url: probe.url, username, password: probe.password } : null;
  let auth: Cd2CheckResult["auth"];
  if (!conn) auth = { ok: false, message: "没填 API 令牌，也没填用户名和口令" };
  else if (!system.ok) auth = { ok: false, message: "地址都没通，凭据先不验" };
  else {
    // API 令牌不经 GetToken，光拿到手不算验过：带着它列一次根目录才知道对不对
    try {
      await cd2Token(conn);
      await cd2ListDir(conn, "/");
      auth = { ok: true, message: conn.apiToken ? "API 令牌可用" : "用户名口令换到了令牌" };
    } catch (err) {
      auth = { ok: false, message: messageOf(err) };
    }
  }
  let permissions: Cd2CheckResult["permissions"];
  let copy: Cd2CheckResult["copy"];
  if (conn && auth.ok) {
    // 令牌自己的权限表：读得到就按用途说缺什么。真 CD2 只给带「令牌管理」权限的令牌读，普通令牌读不到——
    // 读不到（CD2 不给、老版本没有这个接口、一时没连上）不当失败，下面那一下探测照做
    try {
      const info = await cd2TokenInfo(conn);
      if (info) permissions = describeTokenPermissions(info);
    } catch {
      permissions = undefined;
    }
    // 复制引擎选 CD2 时还要能看传输任务（GetCopyTasks）；CD2 的 API 令牌是按权限勾的，真机撞到过只勾了读和复制
    try {
      await cd2CopyTasks(conn);
      copy = { ok: true, message: "能看传输任务，复制进度盯得到" };
    } catch (err) {
      copy = {
        ok: false,
        message:
          err instanceof Cd2Error && err.code === GRPC_STATUS.PERMISSION_DENIED ? "令牌没有「获取传输任务」权限：复制引擎选 CD2 的话看不到进度，只能按目标目录核对完成" : messageOf(err),
      };
    }
  }
  const mounts: Cd2CheckResult["mounts"] = [];
  for (const [account, path] of Object.entries(cd2MountsOf({ mounts: input.mounts }))) {
    if (!conn || !auth.ok) {
      mounts.push({ account, path, ok: false, message: "凭据没过，没查" });
      continue;
    }
    try {
      const entries = await cd2ListDir(conn, path);
      mounts.push({ account, path, ok: true, entries, message: `能列出来，${entries} 个条目` });
    } catch (err) {
      mounts.push({ account, path, ok: false, message: messageOf(err) });
    }
  }
  return { system, auth, mounts, ...(copy ? { copy } : {}), ...(permissions ? { permissions } : {}) };
}
