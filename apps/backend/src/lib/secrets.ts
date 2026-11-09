/**
 * 密钥类字段的读写协议。
 *
 * 读：只给出 `••••` + 末 4 位，够用户确认"填的是哪一个"，不足以被拿去用。
 * 写：收到掩码值 → 沿用库里的原值；空串 → 清掉；其它 → 新值。
 * 表单于是不需要任何特殊交互：回填的就是掩码，原样提交等于不改。
 */
import type { AccountInfo, AppSettings } from "@openstrm/shared";

export const MASK = "••••";

export function maskSecret(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  // 太短的值连末 4 位都不露
  return value.length <= 8 ? MASK : `${MASK}${value.slice(-4)}`;
}

export function isMasked(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(MASK);
}

/** 没提交该字段或提交的是掩码 → 保留原值；否则以提交值为准（含空串 = 清除） */
export function resolveSecret(incoming: unknown, current: string | undefined): string | undefined {
  if (incoming === undefined || isMasked(incoming)) return current;
  return typeof incoming === "string" ? incoming : current;
}

/* ------------------------------- 设置 ------------------------------- */

/** [顶层键, 组内的密钥字段] */
const SETTING_SECRETS: Array<[string, string]> = [
  ["emby", "apiKey"],
  ["tmdb", "apiKey"],
  ["hdhive", "apiKey"],
  ["telegram", "botToken"],
  ["pansou", "password"],
  ["cd2", "apiToken"],
  ["cd2", "password"],
];

type Groups = Record<string, unknown>;

function group(obj: unknown, key: string): Record<string, unknown> | undefined {
  const g = (obj as Groups | undefined)?.[key];
  return g && typeof g === "object" ? (g as Record<string, unknown>) : undefined;
}

export function maskSettings(settings: AppSettings): AppSettings {
  const out: Groups = { ...settings };
  for (const [key, field] of SETTING_SECRETS) {
    const g = group(out, key);
    if (g && field in g) out[key] = { ...g, [field]: maskSecret(g[field]) };
  }
  return out as AppSettings;
}

/** 把 PUT 上来的 patch 里的掩码值换回库里的原值 */
export function unmaskSettingsPatch(patch: Partial<AppSettings>, current: AppSettings): Partial<AppSettings> {
  const out: Groups = { ...patch };
  for (const [key, field] of SETTING_SECRETS) {
    const g = group(out, key);
    if (!g || !(field in g)) continue;
    const stored = group(current, key)?.[field];
    out[key] = { ...g, [field]: resolveSecret(g[field], typeof stored === "string" ? stored : undefined) };
  }
  return out as Partial<AppSettings>;
}

/* ------------------------------- 账号 ------------------------------- */

const ACCOUNT_SECRETS = ["cookie", "password", "token"] as const;

export function maskAccount(account: AccountInfo): AccountInfo {
  const out: Groups = { ...account };
  for (const field of ACCOUNT_SECRETS) {
    if (field in out) out[field] = maskSecret(out[field]);
  }
  return out as unknown as AccountInfo;
}

/** 新建时 current 为 null：掩码值没有原值可回填，会变成 undefined，交给必填校验去拒绝 */
export function unmaskAccountPatch<T extends object>(patch: T, current: AccountInfo | null): T {
  const out: Groups = { ...(patch as Groups) };
  const stored = (current ?? {}) as Groups;
  for (const field of ACCOUNT_SECRETS) {
    if (!(field in out)) continue;
    const prev = stored[field];
    out[field] = resolveSecret(out[field], typeof prev === "string" ? prev : undefined);
  }
  return out as T;
}
