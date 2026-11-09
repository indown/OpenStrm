/**
 * 设置页「CloudDrive2」一节 → 能用的配置。url、凭据（API 令牌或用户名 + 口令）、挂载映射三样齐了才算配好，
 * 缺哪样都当没配：这是顺手刷缓存的事，不该因为没配而报错。
 */
import type { AppSettings, Cd2Settings } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { normConfigDir } from "../copy/paths.js";
import type { Cd2Connection } from "./client.js";

export interface Cd2Config {
  conn: Cd2Connection;
  /** 网盘账号名 → 它在 CD2 里的路径（云盘名） */
  mounts: Record<string, string>;
}

/** 只看凭据和地址，不管映射：检查接口用 */
export function cd2ConnectionOf(c: Cd2Settings | undefined): Cd2Connection | null {
  const url = (c?.url ?? "").trim();
  if (!url) return null;
  const apiToken = (c?.apiToken ?? "").trim();
  const username = (c?.username ?? "").trim();
  const password = c?.password ?? "";
  if (!apiToken && !(username && password)) return null;
  return { url, ...(apiToken ? { apiToken } : { username, password }) };
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
  const conn = cd2ConnectionOf(settings.cd2);
  if (!conn) return null;
  const mounts = cd2MountsOf(settings.cd2);
  if (Object.keys(mounts).length === 0) return null;
  return { conn, mounts };
}
