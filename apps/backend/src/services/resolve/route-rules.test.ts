/**
 * 路由规则的纯函数测试。
 *
 * 这层出错的表现是"某个客户端突然不走直链"或"该转码的没转码"，
 * 两处生效点（redirect.ts / playback-info.ts）都靠它，所以边界钉在这里：
 *   pnpm test:file src/services/resolve/route-rules.test.ts
 */
import assert from "node:assert/strict";
import { test as t } from "node:test";
import type { ProxyRouteRule } from "@openstrm/shared";
import { clientContext, decideRoute, pathStartsWith, rulesNeedPath } from "./route-rules.js";

t("没有规则、规则都没命中：按 redirect", () => {
  assert.equal(decideRoute([], { userAgent: "VLC/3" }), "redirect");
  assert.equal(decideRoute(undefined, { userAgent: "VLC/3" }), "redirect");
  assert.equal(decideRoute([{ action: "relay", userAgent: "oldbox" }], { userAgent: "VLC/3" }), "redirect");
});

t("从上到下第一条命中的生效", () => {
  const rules: ProxyRouteRule[] = [
    { action: "redirect", userAgent: "infuse" },
    { action: "relay", userAgent: "infuse", client: "Infuse" },
    { action: "relay" },
  ];
  assert.equal(decideRoute(rules, { userAgent: "Infuse-Direct/8", client: "Infuse" }), "redirect", "第一条已经命中，后面的不看");
  assert.equal(decideRoute(rules, { userAgent: "VLC/3" }), "relay", "兜底那条接住其它所有");
});

t("填了的条件都要满足（与关系）", () => {
  const rule: ProxyRouteRule = { action: "relay", userAgent: "web", deviceName: "chrome" };
  assert.equal(decideRoute([rule], { userAgent: "Emby Web", deviceName: "Chrome Windows" }), "relay");
  assert.equal(decideRoute([rule], { userAgent: "Emby Web", deviceName: "Safari" }), "redirect");
  assert.equal(decideRoute([rule], { userAgent: "Emby Web" }), "redirect", "条件要的值请求里没有，就不算命中");
});

t("一个条件都不填 = 全部命中，等于把 302 关掉", () => {
  assert.equal(decideRoute([{ action: "relay" }], {}), "relay");
  assert.equal(decideRoute([{ action: "relay", userAgent: "  ", path: "" }], { userAgent: "x" }), "relay", "只有空白的条件当没填");
});

t("UA / 客户端 / 设备名是不分大小写的包含，设备 id 要相等", () => {
  assert.equal(decideRoute([{ action: "relay", client: "emby web" }], { client: "Emby Web" }), "relay");
  assert.equal(decideRoute([{ action: "relay", deviceId: "abc" }], { deviceId: "abc" }), "relay");
  assert.equal(decideRoute([{ action: "relay", deviceId: "abc" }], { deviceId: "abcd" }), "redirect", "设备 id 不做包含匹配");
  assert.equal(decideRoute([{ action: "relay", deviceId: " abc " }], { deviceId: "abc" }), "relay", "两边的空白都不算");
});

t("看路径的规则：路径还不知道时不命中，知道了按目录边界比", () => {
  const rules: ProxyRouteRule[] = [{ action: "relay", path: "/mnt/115/4K" }];
  assert.equal(rulesNeedPath(rules), true);
  assert.equal(rulesNeedPath([{ action: "relay", userAgent: "x" }]), false);
  assert.equal(decideRoute(rules, { userAgent: "x" }), "redirect");
  assert.equal(decideRoute(rules, { path: "/mnt/115/4K/a.mkv" }), "relay");
  assert.equal(decideRoute(rules, { path: "/mnt/115/4K-remux/a.mkv" }), "redirect");
});

t("pathStartsWith：目录边界、尾斜杠、重复斜杠、encodeURI 过的路径", () => {
  assert.equal(pathStartsWith("/mnt/115/4K/a.mkv", "/mnt/115/4K/"), true);
  assert.equal(pathStartsWith("/mnt/115/4K", "/mnt/115/4K"), true);
  assert.equal(pathStartsWith("/mnt/115//4K/a.mkv", "/mnt/115/4K"), true);
  assert.equal(pathStartsWith("/mnt/115/4K-remux/a.mkv", "/mnt/115/4K"), false);
  assert.equal(pathStartsWith("/mnt/115/%E7%94%B5%E5%BD%B1/a.mkv", "/mnt/115/电影"), true);
  assert.equal(pathStartsWith("http://ol:5244/d/115/tv/a.mkv", "http://ol:5244/d/115"), true);
  assert.equal(pathStartsWith(undefined, "/mnt"), false);
});

t("来源分内外网：回环、私有网段、IPv4 映射的 IPv6 都算内网", () => {
  const lan: ProxyRouteRule[] = [{ action: "relay", remote: "lan" }];
  const wan: ProxyRouteRule[] = [{ action: "relay", remote: "wan" }];
  for (const ip of ["127.0.0.1", "192.168.1.5", "10.0.0.3", "::ffff:172.16.0.9", "::1"]) {
    assert.equal(decideRoute(lan, { ip }), "relay", `${ip} 应算内网`);
    assert.equal(decideRoute(wan, { ip }), "redirect", `${ip} 不该算外网`);
  }
  for (const ip of ["203.0.113.9", "2001:db8::1"]) {
    assert.equal(decideRoute(wan, { ip }), "relay", `${ip} 应算外网`);
    assert.equal(decideRoute(lan, { ip }), "redirect");
  }
  assert.equal(decideRoute(wan, {}), "redirect", "没有来源地址的不命中");
});

t("clientContext：query 里的 X-Emby-* 优先，其次认证头里的 Client / Device / DeviceId", () => {
  assert.deepEqual(clientContext({ "X-Emby-Client": "Emby Web", "X-Emby-Device-Id": "d1" }, {}), {
    client: "Emby Web",
    deviceName: undefined,
    deviceId: "d1",
  });
  const headers = { "x-emby-authorization": 'MediaBrowser Client="Infuse", Device="iPad", DeviceId="abc", Version="7.8", Token="t"' };
  assert.deepEqual(clientContext({}, headers), { client: "Infuse", deviceName: "iPad", deviceId: "abc" });
  // 没有自定义头、只有标准 Authorization 的客户端
  assert.equal(clientContext({}, { authorization: 'MediaBrowser Client="Emby for Android TV", Token="t"' }).client, "Emby for Android TV");
  assert.deepEqual(clientContext(undefined, undefined), { client: undefined, deviceName: undefined, deviceId: undefined });
});
