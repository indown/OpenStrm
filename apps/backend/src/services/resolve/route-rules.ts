/**
 * 302 代理的路由规则：按客户端 / 来源 / 路径决定一个播放请求走直链还是交给 Emby。
 *
 * 规则从上到下看，第一条命中的决定动作；填了的条件都满足才算命中，一个条件都不填 = 全部命中；
 * 一条都没命中按 redirect（302）。relay 的意思是「别动」：PlaybackInfo 原样、流请求回源，
 * Emby 自己中转或转码——限码率的客户端、拿着 302 播不了的播放器、不想走直链的目录都用它。
 *
 * 纯函数，redirect.ts 和 playback-info.ts 两处共用，保证同一个请求在两处的裁决一致。
 */
import type { ProxyRouteAction, ProxyRouteRule } from "@openstrm/shared";
import { isInternalAddress } from "../../lib/ip.js";
import { safeDecode } from "../strm/naming.js";
import { normalizeMediaPath } from "./direct-link.js";

/** 裁决要看的东西；path 还不知道时不传（看路径的规则就不会命中） */
export type RouteContext = {
  userAgent?: string;
  client?: string;
  deviceName?: string;
  deviceId?: string;
  /** 请求来源地址（request.ip；设了 TRUST_PROXY 时是从转发链上取的客户端地址） */
  ip?: string;
  /** Emby 看到的路径（strm 里写的那个） */
  path?: string;
};

type Query = Record<string, unknown> | undefined;
type IncomingHeaders = Record<string, string | string[] | undefined> | undefined;

function firstValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

function queryString(query: Query, ...keys: string[]): string {
  for (const key of keys) {
    const value = query?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** Emby 的认证头：`MediaBrowser Client="Emby Web", Device="Chrome", DeviceId="xx", Version="4.8", Token="xx"` */
function authField(headers: IncomingHeaders, field: string): string {
  for (const name of ["x-emby-authorization", "authorization"]) {
    const raw = firstValue(headers?.[name]);
    if (!raw) continue;
    const m = new RegExp(`\\b${field}="([^"]*)"`, "i").exec(raw);
    if (m?.[1]) return m[1];
  }
  return "";
}

/**
 * 从请求里取客户端身份。Emby 生成的地址把它们放在 query（X-Emby-Client 等），
 * 客户端自己发起的请求普遍放在认证头里，两边都看。
 */
export function clientContext(query: Query, headers: IncomingHeaders): Pick<RouteContext, "client" | "deviceName" | "deviceId"> {
  return {
    client: queryString(query, "X-Emby-Client") || authField(headers, "Client") || undefined,
    deviceName: queryString(query, "X-Emby-Device-Name") || authField(headers, "Device") || undefined,
    deviceId: queryString(query, "X-Emby-Device-Id") || authField(headers, "DeviceId") || undefined,
  };
}

/** 有没有规则要看路径：有的话裁决前得先把条目查出来 */
export function rulesNeedPath(rules: ProxyRouteRule[]): boolean {
  return rules.some((r) => !!r.path?.trim());
}

function includes(haystack: string | undefined, needle: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

/** 路径前缀按目录边界比：`/mnt/115/4K` 命中 `/mnt/115/4K/a.mkv`，不命中 `/mnt/115/4K-remux/a.mkv` */
export function pathStartsWith(path: string | undefined, prefix: string): boolean {
  if (!path) return false;
  const base = normalizeMediaPath(prefix.trim()).replace(/\/+$/, "");
  if (!base) return true;
  const target = normalizeMediaPath(safeDecode(path));
  return target === base || target.startsWith(`${base}/`);
}

function matches(rule: ProxyRouteRule, ctx: RouteContext): boolean {
  if (rule.userAgent?.trim() && !includes(ctx.userAgent, rule.userAgent)) return false;
  if (rule.client?.trim() && !includes(ctx.client, rule.client)) return false;
  if (rule.deviceName?.trim() && !includes(ctx.deviceName, rule.deviceName)) return false;
  if (rule.deviceId?.trim() && ctx.deviceId?.trim() !== rule.deviceId.trim()) return false;
  if (rule.path?.trim() && !pathStartsWith(ctx.path, rule.path)) return false;
  if (rule.remote) {
    if (!ctx.ip) return false;
    const where = isInternalAddress(ctx.ip) ? "lan" : "wan";
    if (where !== rule.remote) return false;
  }
  return true;
}

/** 第一条命中的规则的动作；一条都没命中按 redirect */
export function decideRoute(rules: ProxyRouteRule[] | undefined, ctx: RouteContext): ProxyRouteAction {
  for (const rule of rules ?? []) {
    if (matches(rule, ctx)) return rule.action === "relay" ? "relay" : "redirect";
  }
  return "redirect";
}
