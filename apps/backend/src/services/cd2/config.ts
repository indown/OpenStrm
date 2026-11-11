/**
 * 设置页「CloudDrive2」一节 → 能用的配置。挂载层只有一个 CD2：设置里选的那个 CloudDrive2 账号（地址和凭据在账户页），
 * 加上各网盘账号在它里面的路径。账号和映射都齐了才算配好，缺哪样都当没配：这是顺手刷缓存的事，不该因为没配而报错。
 */
import type { AccountCd2, AppSettings, Cd2Settings } from "@openstrm/shared";
import { getAccount } from "../../db/repositories/accounts.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { normConfigDir } from "../copy/paths.js";
import { missingCredentials } from "../drive/credentials.js";

export interface Cd2Config {
  /** 设置里选的 CD2 账号；它本身就能当连接传给 cd2/client.ts */
  conn: AccountCd2;
  /** 网盘账号名 → 它在 CD2 里的路径（云盘名） */
  mounts: Record<string, string>;
}

/** 设置里选的 CD2 账号的状况：能用就带着账号，用不了说是哪一种 */
export type Cd2AccountState =
  | { ok: true; account: AccountCd2 }
  | { ok: false; reason: "unset" | "missing" | "wrong-type" | "incomplete"; name: string };

export function cd2AccountState(settings: AppSettings = readAppSettings()): Cd2AccountState {
  const name = (settings.cd2?.account ?? "").trim();
  if (!name) return { ok: false, reason: "unset", name: "" };
  const acc = getAccount(name);
  if (!acc) return { ok: false, reason: "missing", name };
  if (acc.accountType !== "cd2") return { ok: false, reason: "wrong-type", name };
  if (missingCredentials(acc)) return { ok: false, reason: "incomplete", name };
  return { ok: true, account: acc };
}

/** 用不了的那四种各一句话；复制配置和检查接口说的是同一句 */
export function cd2AccountProblem(state: Cd2AccountState): string | null {
  if (state.ok) return null;
  switch (state.reason) {
    case "unset":
      return "设置页的 CloudDrive2 一节还没选 CD2 账号";
    case "missing":
      return `CloudDrive2 账号不存在：${state.name}`;
    case "wrong-type":
      return `${state.name} 不是 CloudDrive2 账号`;
    case "incomplete":
      return `CloudDrive2 账号 ${state.name} 缺少地址或凭据`;
  }
}

/** 选了、账号在、类型对、地址和凭据齐才给 */
export function cd2AccountOf(settings: AppSettings = readAppSettings()): AccountCd2 | null {
  const state = cd2AccountState(settings);
  return state.ok ? state.account : null;
}

export function cd2MountsOf(c: Cd2Settings | undefined): Record<string, string> {
  const mounts: Record<string, string> = {};
  for (const [name, path] of Object.entries(c?.mounts ?? {})) {
    const norm = normConfigDir(path);
    if (norm) mounts[name] = norm;
  }
  return mounts;
}

export function cd2ConfigIfReady(settings: AppSettings = readAppSettings()): Cd2Config | null {
  const conn = cd2AccountOf(settings);
  if (!conn) return null;
  const mounts = cd2MountsOf(settings.cd2);
  if (Object.keys(mounts).length === 0) return null;
  return { conn, mounts };
}
