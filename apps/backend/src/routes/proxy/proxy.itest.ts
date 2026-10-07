/**
 * 代理层离线集成测试：起一个假 Emby，把整个 proxy 插件装起来跑真实请求。
 *
 * 115 那一段用 setLinkResolver 换掉，所以不需要真账号也能验证
 * 302 / 回源 / 缓存这几条分支——它们才是最容易写错的地方。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/proxy/proxy.itest.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import Fastify from "fastify";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { deleteTask, insertTask } from "../../db/repositories/tasks.js";
import proxyPlugin from "./index.js";
import { clearLinkCache, setLinkResolver } from "./redirect.js";
import { swapPorts, swapUrlPort } from "./system-info.js";
import { resetConfigRevisionMemo } from "../../services/config-revision.js";
import { resetSettingsMemo } from "../../services/settings-safe.js";

/** 代理侧读配置有 1 秒 memo：同进程里改完设置要顺手重置，不然下一条请求还看见旧值 */
function setSettings(next: Parameters<typeof replaceAppSettings>[0]) {
  replaceAppSettings(next);
  resetSettingsMemo();
}

const MOUNT = "/mnt/pan";
const PAN_FILE = `${MOUNT}/tv/Show/ep1.mkv`;
const LOCAL_FILE = "/media/local/movie.mkv";
/** strm 里写 OpenList 地址的那种任务：前缀是 URL，代理按 URL 匹配挂载点 */
const HTTP_MOUNT = "http://ol.local:5244/d/115";
const HTTP_FILE = `${HTTP_MOUNT}/tv/Show/ep1.mkv`;
/** 挂载点里的另一个目录：路由规则按路径只让它交给 Emby 时，别的目录照常 302 */
const FOUR_K_FILE = `${MOUNT}/4K/Movie.mkv`;
/** 既不是手填挂载点也没有任务的前缀：只有手填的路径映射能让代理接管它 */
const MAPPED_MOUNT = "/mnt/mapped";
const MAPPED_FILE = `${MAPPED_MOUNT}/Show/ep1.mkv`;
/** 假 Emby 收到的条目查询次数：看路径的路由规则要查条目，结果该缓存起来 */
let itemLookups = 0;
/**
 * 真实形态的 115 直链：文件名已经是转义过的，签名里带 `+` 和 `=`。
 * 必须**原样**出现在 Location 里：再做一次 encodeURI 的话
 * `%` 会变成 `%25`，CDN 直接 403。
 */
const DIRECT_URL =
  "https://cdn-qn.115.com/lab/%E4%B8%AD%E6%96%87%E5%90%8D.mkv?t=1&u=a%2Bb&sign=xY%3D%3D";
/** 混进非 ASCII 的异常直链，只有这种才需要转义 */
const UNICODE_URL = "https://cdn.115.com/直链?t=1";

// ---- 假 Emby ----
const emby = http.createServer((req, res) => {
  const url = req.url ?? "";

  if (url.includes("/Sync/JobItems")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Items: [{ Id: "job-1", ItemName: "Show", OutputPath: PAN_FILE }] }));
    return;
  }
  if (url.includes("/Items?Ids=")) {
    const id = new URL(url, "http://x").searchParams.get("Ids");
    itemLookups++;
    // item-local 指向本地文件，item-http 是 strm 里写 OpenList 地址的条目，item-4k 在挂载点的另一个目录，其余都指向挂载点里的 strm
    const path = id === "item-local" ? LOCAL_FILE : id === "item-http" ? HTTP_FILE : id === "item-4k" ? FOUR_K_FILE : PAN_FILE;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Items: [{ Name: "Show", Path: path, MediaSources: [{ Id: id, Path: path, Container: "mkv" }] }] }));
    return;
  }
  if (url.includes("/PlaybackInfo")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      MediaSources: [
        { Id: "ms-pan", Path: PAN_FILE, Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: false, DirectStreamUrl: "/emby/Videos/ms-pan/stream.mkv?api_key=k" },
        { Id: "ms-local", Path: LOCAL_FILE, Container: "mp4", SupportsDirectPlay: false, SupportsDirectStream: false, DirectStreamUrl: "/emby/Videos/ms-local/stream.mp4?api_key=k" },
        { Id: "ms-http", Path: HTTP_FILE, Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: false, DirectStreamUrl: "/emby/Videos/ms-http/stream.mkv?api_key=k" },
        { Id: "ms-4k", Path: FOUR_K_FILE, Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: false, DirectStreamUrl: "/emby/Videos/ms-4k/stream.mkv?api_key=k" },
        { Id: "ms-mapped", Path: MAPPED_FILE, Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: false, DirectStreamUrl: "/emby/Videos/ms-mapped/stream.mkv?api_key=k" },
      ],
    }));
    return;
  }
  // Public 版（登录前客户端先问的那个）没有端口字段，只有地址；真 Emby 的路径不分大小写，桩也照做
  if (url.toLowerCase().includes("/system/info/public")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ LocalAddress: `http://192.168.1.2:${embyPort}`, ServerName: "lab", Version: "4.8.0.0", Id: "lab" }));
    return;
  }
  // 真 Emby 对 /System/Info 和 /emby/System/Info 都认，桩也照做
  if (url.includes("/System/Info")) {
    res.writeHead(200, { "content-type": "application/json", "x-lab-marker": "1", "cache-control": "no-cache" });
    res.end(JSON.stringify({
      WebSocketPortNumber: 8096,
      HttpServerPortNumber: 8096,
      LocalAddress: "http://192.168.1.2:8096",
      LocalAddresses: ["http://192.168.1.2:8096"],
    }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("upstream-ok");
});

await new Promise<void>((r) => emby.listen(0, "127.0.0.1", r));
const embyPort = (emby.address() as { port: number }).port;

// ---- 配置 ----
const baseline = readAppSettings();
setSettings({
  ...baseline,
  emby: { url: `http://127.0.0.1:${embyPort}`, apiKey: "test-key" },
  mediaMountPath: [MOUNT],
});

// ---- 被测应用 ----
const app = Fastify({ logger: false });
await app.register(proxyPlugin);
await app.ready();

let resolveCalls = 0;
let lastResolvedUa: string | undefined;
setLinkResolver(async (embyPath, userAgent) => {
  resolveCalls++;
  lastResolvedUa = userAgent;
  return embyPath.startsWith(MOUNT) || embyPath.startsWith(HTTP_MOUNT)
    ? { ok: true, url: DIRECT_URL, accountName: "主号", panPath: embyPath }
    : { ok: false, reason: "not-mounted" };
});

function reset() {
  resolveCalls = 0;
  clearLinkCache();
}

// ---- 302 重定向 ----

test("挂载点里的条目 302 到直链", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k" });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, DIRECT_URL, "已转义的直链必须原样透传，不能二次编码");
  });

test("小写路径同样命中（客户端大小写不统一）", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/videos/item-1/stream?api_key=k" });
    assert.equal(res.statusCode, 302);
  });

test("不带 /emby 前缀也命中", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/Videos/item-1/original.mkv?api_key=k" });
    assert.equal(res.statusCode, 302);
  });

test("Audio universal 命中", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Audio/item-1/universal?api_key=k" });
    assert.equal(res.statusCode, 302);
  });

test("Items Download 命中", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Items/item-1/Download?api_key=k" });
    assert.equal(res.statusCode, 302);
  });
// ---- 凭据闸门 ----

test("不带任何凭据不 302，透传给 Emby 自己裁决", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv" });
    assert.equal(res.statusCode, 200, "匿名请求不能换到直链");
    assert.equal(res.body, "upstream-ok");
    assert.equal(resolveCalls, 0, "连解析都不该发生——别拿管理员身份替匿名者查");
  });

test("令牌放在请求头里同样算已认证", async () => {
    for (const headers of [
      { "x-emby-token": "k" },
      { "x-mediabrowser-token": "k" },
      { authorization: 'MediaBrowser Client="Infuse", Token="k"' },
      { "x-emby-authorization": 'MediaBrowser Token="k", Device="tv"' },
    ]) {
      reset();
      const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv", headers });
      assert.equal(res.statusCode, 302, `${JSON.stringify(headers)} 应当被认作已认证`);
    }
  });

test("匿名请求拿不到别人已解析好的缓存直链", async () => {
    reset();
    const warm = await app.inject({
      method: "GET",
      url: "/emby/Videos/item-1/stream.mkv?api_key=k",
      headers: { "user-agent": "UA-1" },
    });
    assert.equal(warm.statusCode, 302);

    // cacheKey 只由配置版本 + 条目 + UA 决定，和凭据无关。
    // 闸门要是排在缓存查询之后，这一条就会拿到上面那个直链。
    const anon = await app.inject({
      method: "GET",
      url: "/emby/Videos/item-1/stream.mkv",
      headers: { "user-agent": "UA-1" },
    });
    assert.equal(anon.statusCode, 200, "闸门必须排在缓存查询之前");
  });

test("显式打开 allowAnonymousRedirect 后匿名也 302", async () => {
    reset();
    const current = readAppSettings();
    setSettings({
      ...current,
      emby: { ...(current.emby ?? {}), allowAnonymousRedirect: true },
    });
    resetConfigRevisionMemo();
    try {
      const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv" });
      assert.equal(res.statusCode, 302, "开关是给不带凭据的老客户端留的后路，打开就该恢复旧行为");
    } finally {
      setSettings(current);
      resetConfigRevisionMemo();
    }
  });
// ---- 换 UA 的客户端：两跳 ----

test("Infuse 先 302 回代理自己，第二跳按跟随时的 UA 换直链，缓存也按第二跳的 UA 分", async () => {
    reset();
    const first = await app.inject({
      method: "GET",
      url: "/emby/Videos/item-1/stream.mkv?api_key=k&MediaSourceId=ms-1",
      headers: { "user-agent": "Infuse-Direct/7.8" },
    });
    assert.equal(first.statusCode, 302);
    const hop = first.headers.location as string;
    assert.ok(hop.startsWith("/emby/Videos/item-1/stream.mkv?"), `第一跳应指回代理自己，实际 ${hop}`);
    assert.match(hop, /_hop=2/);
    assert.match(hop, /api_key=k/);
    assert.match(hop, /MediaSourceId=ms-1/, "原有查询串要保留");
    assert.equal(resolveCalls, 0, "第一跳不换链：这时的 UA 不是客户端去 CDN 用的那个");

    // 客户端跟随重定向时换了 UA（Infuse 就是这样）：按这一跳的 UA 换链
    const second = await app.inject({ method: "GET", url: hop, headers: { "user-agent": "AppleCoreMedia/1.0.0.21F90" } });
    assert.equal(second.statusCode, 302);
    assert.equal(second.headers.location, DIRECT_URL);
    assert.equal(resolveCalls, 1);
    assert.equal(lastResolvedUa, "AppleCoreMedia/1.0.0.21F90", "直链必须按第二跳的 UA 换，CDN 认的是它");

    // 第二跳的 UA 再来就命中缓存；第一跳的 UA 不会拿到别人的链接
    await app.inject({ method: "GET", url: hop, headers: { "user-agent": "AppleCoreMedia/1.0.0.21F90" } });
    assert.equal(resolveCalls, 1, "同一 UA 第二次应命中缓存");
  });

test("令牌只在请求头里的 Infuse：第二跳地址把令牌补进 query，丢了自定义头也过得了闸门", async () => {
    reset();
    const first = await app.inject({
      method: "GET",
      url: "/emby/Videos/item-1/stream.mkv",
      headers: { "user-agent": "Infuse/7.8", "x-emby-token": "k" },
    });
    assert.equal(first.statusCode, 302);
    assert.match(first.headers.location as string, /api_key=k/);
    const second = await app.inject({ method: "GET", url: first.headers.location as string, headers: { "user-agent": "Infuse/7.8" } });
    assert.equal(second.statusCode, 302, "第二跳没带头也该能过闸门");
    assert.equal(second.headers.location, DIRECT_URL);
  });

test("其它客户端还是一跳直达", async () => {
    reset();
    const res = await app.inject({
      method: "GET",
      url: "/emby/Videos/item-1/stream.mkv?api_key=k",
      headers: { "user-agent": "SenPlayer/4.0.8" },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, DIRECT_URL);
  });

// ---- 回源兜底 ----

test("HEAD 探测直接回源，不去换直链", async () => {
    reset();
    const res = await app.inject({ method: "HEAD", url: "/emby/Videos/item-1/stream.mkv?api_key=k" });
    assert.equal(res.statusCode, 200);
    assert.equal(resolveCalls, 0, "HEAD 不该触发直链解析");
  });

test("strm 里是 OpenList 地址的条目：换到直链就 302，换不到就回给 Emby 按 URL 拉流", async () => {
    reset();
    const hit = await app.inject({ method: "GET", url: "/emby/Videos/item-http/stream.mkv?api_key=k" });
    assert.equal(hit.statusCode, 302);
    assert.equal(hit.headers.location, DIRECT_URL);

    // 盘里找不到这个文件：回源，Emby 自己按 strm 里的 OpenList 地址去拉
    setLinkResolver(async () => ({ ok: false, reason: "not-found" }));
    try {
      clearLinkCache();
      const miss = await app.inject({ method: "GET", url: "/emby/Videos/item-http/stream.mkv?api_key=k" });
      assert.equal(miss.statusCode, 200);
      assert.equal(miss.body, "upstream-ok");
    } finally {
      setLinkResolver(async (embyPath) => {
        resolveCalls++;
        return embyPath.startsWith(MOUNT) || embyPath.startsWith(HTTP_MOUNT)
          ? { ok: true, url: DIRECT_URL, accountName: "主号", panPath: embyPath }
          : { ok: false, reason: "not-mounted" };
      });
    }
  });

test("本地文件不被 302，老老实实回源", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-local/stream.mkv?api_key=k" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "upstream-ok");
  });

test("master/live 之类不在白名单的动作回源", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/master.m3u8?api_key=k" });
    assert.equal(res.statusCode, 200);
    assert.equal(resolveCalls, 0);
  });

test("字幕请求穿过通配路由回源", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/Subtitles/0/Stream.srt?api_key=k" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "upstream-ok");
  });

test("解析抛异常也回源，不让播放直接失败", async () => {
    reset();
    setLinkResolver(async () => {
      throw new Error("115 挂了");
    });
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "upstream-ok");
    // 复原
    setLinkResolver(async (embyPath) => {
      resolveCalls++;
      return embyPath.startsWith(MOUNT) || embyPath.startsWith(HTTP_MOUNT)
        ? { ok: true, url: DIRECT_URL, accountName: "主号", panPath: embyPath }
        : { ok: false, reason: "not-mounted" };
    });
  });
// ---- 缓存 ----

test("同一条目重复请求只解析一次", async () => {
    reset();
    const a = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "UA-1" } });
    const b = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "UA-1" } });
    assert.equal(a.statusCode, 302);
    assert.equal(b.statusCode, 302);
    assert.equal(resolveCalls, 1, "第二次该走缓存");
  });

test("UA 不同要重新解析——115 直链和 UA 绑定", async () => {
    reset();
    await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "UA-1" } });
    await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "UA-2" } });
    assert.equal(resolveCalls, 2);
  });
// ---- PlaybackInfo 改写 ----

test("挂载点里的媒体源被标成可直连，本地源不动", async () => {
    reset();
    const res = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const pan = body.MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
    const local = body.MediaSources.find((s: { Id: string }) => s.Id === "ms-local");

    assert.equal(pan.SupportsDirectPlay, true);
    assert.equal(pan.SupportsDirectStream, true);
    // 路径段是条目 id，不是 MediaSource.Id——真 Emby 的 MediaSource.Id 长 mediasource_11 这样
    assert.match(pan.DirectStreamUrl, /^\/Videos\/item-1\/stream\.mkv\?/, "应指回本代理，且不带 /emby 前缀");
    assert.match(pan.DirectStreamUrl, /api_key=k/, "查询串要保留，丢了客户端就没法鉴权");

    assert.equal(local.SupportsDirectPlay, false, "本地源不该被改");
  });

test("只在任务上开了 302、没手填 mediaMountPath：PlaybackInfo 同样改写", async () => {
    const now = readAppSettings();
    setSettings({ ...now, mediaMountPath: [] });
    try {
      const before = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
      const untouched = JSON.parse(before.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
      assert.equal(untouched.SupportsDirectPlay, false, "没有任何挂载前缀时不该改写");

      insertTask({ id: "pi-302", account: "主号", originPath: "/tv", targetPath: "tv", strmPrefix: MOUNT, enable302: true });
      const after302 = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
      assert.equal(after302.statusCode, 200);
      const pan = JSON.parse(after302.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
      assert.equal(pan.SupportsDirectPlay, true, "302 的挂载点从任务现算，PlaybackInfo 不能只看手填的 mediaMountPath");
      assert.equal(pan.SupportsTranscoding, false);
      assert.match(pan.DirectStreamUrl, /^\/Videos\/item-1\/stream\.mkv\?/);
    } finally {
      deleteTask("pi-302");
      setSettings(now);
    }
  });
test("strm 里是 http 地址的媒体源：只标 DirectStream 不标 DirectPlay，播放一律经过代理", async () => {
    const before = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
    const untouched = JSON.parse(before.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-http");
    assert.match(untouched.DirectStreamUrl, /^\/emby\/Videos\/ms-http/, "没有任务用这个 URL 前缀时不该改写");

    // 前缀带尾斜杠也要对得上：任务存的和 Emby 报的都先归一化
    insertTask({ id: "pi-http", account: "主号", originPath: "tv", targetPath: "tv", strmPrefix: `${HTTP_MOUNT}/`, enable302: true });
    try {
      const res = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const web = body.MediaSources.find((s: { Id: string }) => s.Id === "ms-http");
      assert.equal(web.SupportsDirectPlay, false, "直接播放会让客户端自己去取 strm 里的 URL，绕过代理");
      assert.equal(web.SupportsDirectStream, true);
      assert.equal(web.SupportsTranscoding, false);
      assert.match(web.DirectStreamUrl, /^\/Videos\/item-1\/stream\.mkv\?/);
      const pan = body.MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
      assert.equal(pan.SupportsDirectPlay, true, "本地挂载路径的源不受影响");
    } finally {
      deleteTask("pi-http");
    }
  });
// ---- System/Info 端口改写 ----

test("端口被换掉，客户端才不会绕过代理直连 Emby", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/System/Info" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.notEqual(body.WebSocketPortNumber, 8096);
    assert.ok(!String(body.LocalAddress).includes("8096"), "地址里的端口也要换");
  });

test("swapPorts 对各种字段形态都生效", () => {
    const out = swapPorts(
      {
        WebSocketPortNumber: 8096,
        HttpServerPortNumber: 8096,
        LocalAddress: "http://a:8096",
        WanAddress: "http://b:8096",
        LocalAddresses: ["http://a:8096", "http://c:8096"],
        RemoteAddresses: ["http://d:8096"],
      },
      8096,
      8091,
    );
    assert.equal(out.WebSocketPortNumber, 8091);
    assert.equal(out.HttpServerPortNumber, 8091);
    assert.equal(out.LocalAddress, "http://a:8091");
    assert.equal(out.WanAddress, "http://b:8091");
    assert.deepEqual(out.LocalAddresses, ["http://a:8091", "http://c:8091"]);
    assert.deepEqual(out.RemoteAddresses, ["http://d:8091"]);
  });

test("端口相同时什么都不改", () => {
    const out = swapPorts({ WebSocketPortNumber: 8091, LocalAddress: "http://a:8091" }, 8091, 8091);
    assert.equal(out.LocalAddress, "http://a:8091");
  });
// ---- 转发头 ----

test("回源时带上真实客户端 IP", async () => {
    reset();
    const seen: Record<string, string | string[] | undefined> = {};
    const sniffer = http.createServer((req, res) => {
      Object.assign(seen, req.headers);
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => sniffer.listen(0, "127.0.0.1", r));
    const sniffPort = (sniffer.address() as { port: number }).port;

    const current = readAppSettings();
    setSettings({ ...current, emby: { url: `http://127.0.0.1:${sniffPort}`, apiKey: "k" } });

    await app.inject({
      method: "GET",
      url: "/Users/u1/Views",
      headers: { "x-forwarded-for": "203.0.113.9", host: "emby.example.com" },
    });

    assert.match(String(seen["x-forwarded-for"]), /^203\.0\.113\.9/, "原有转发链要保留");
    // X-Real-IP 必须是真实对端，不能采信客户端自报的 XFF——
    // 否则任何人发一个头就能让 Emby 的日志和封禁认错人
    assert.notEqual(seen["x-real-ip"], "203.0.113.9", "X-Real-IP 不能采信客户端自报的转发链");
    assert.equal(seen.host, "emby.example.com", "Host 不能被改成上游的");

    setSettings(current);
    sniffer.close();
  });
// ---- 回源与改写的边界情况 ----

test("非 ASCII 直链才转义，且只转非 ASCII 部分", async () => {
    reset();
    setLinkResolver(async () => ({ ok: true, url: UNICODE_URL, accountName: "主号", panPath: "/x" }));
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k" });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "https://cdn.115.com/%E7%9B%B4%E9%93%BE?t=1");
    setLinkResolver(async (embyPath) => {
      resolveCalls++;
      return embyPath.startsWith(MOUNT) || embyPath.startsWith(HTTP_MOUNT)
        ? { ok: true, url: DIRECT_URL, accountName: "主号", panPath: embyPath }
        : { ok: false, reason: "not-mounted" };
    });
  });

test("PlaybackInfo 接受空 body 和表单 content-type", async () => {
    // 默认 JSON 解析器会先判 400/415，handler 根本轮不到
    for (const ct of ["application/json", "application/x-www-form-urlencoded", "text/plain"]) {
      const res = await app.inject({
        method: "POST",
        url: "/emby/Items/item-1/PlaybackInfo",
        headers: { "content-type": ct },
        payload: "",
      });
      assert.equal(res.statusCode, 200, `${ct} 空 body 应当被接受`);
    }
  });

test("PlaybackInfo 关掉转码并去掉 TranscodingUrl", async () => {
    reset();
    const res = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
    const pan = JSON.parse(res.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
    assert.equal(pan.SupportsTranscoding, false, "留着转码的话限码率客户端会绕开 302");
    assert.equal(pan.TranscodingUrl, undefined);
  });

test("DirectStreamUrl 用条目 id 且带 Static=true", async () => {
    reset();
    const res = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
    const pan = JSON.parse(res.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
    // 路径段必须是条目 id，不能是 MediaSource.Id（真 Emby 里长 mediasource_11 这样）
    assert.match(pan.DirectStreamUrl, /^\/Videos\/item-1\/stream\./);
    assert.match(pan.DirectStreamUrl, /Static=true/);
    assert.ok(!/TranscodeReasons/.test(pan.DirectStreamUrl), "不该残留 TranscodeReasons");
  });

test("头里认证的客户端：PlaybackInfo 给出的地址能过闸门", async () => {
    reset();
    // Infuse / SenPlayer 这类客户端把令牌放在头里。上游若没给出带 api_key 的
    // DirectStreamUrl，重写时必须从头里补上，否则客户端拿着一个匿名地址回来，
    // 会被凭据闸门挡下——表现就是"能刷出媒体库但点播放不走直连"。
    const info = await app.inject({
      method: "POST",
      url: "/emby/Items/item-1/PlaybackInfo",
      payload: {},
      headers: { authorization: 'MediaBrowser Client="Infuse", Token="k"' },
    });
    const pan = JSON.parse(info.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
    assert.match(pan.DirectStreamUrl, /api_key=k/, "令牌要从请求头补进 DirectStreamUrl");

    const play = await app.inject({ method: "GET", url: pan.DirectStreamUrl });
    assert.equal(play.statusCode, 302, "照着 PlaybackInfo 给的地址请求，应当直接 302");
  });

test("DirectStreamUrl 不带 /emby 前缀——base 带路径的客户端才不会拼出两层", async () => {
    reset();
    const info = await app.inject({
      method: "POST",
      url: "/emby/Items/item-1/PlaybackInfo",
      payload: {},
      headers: { authorization: 'MediaBrowser Token="k"' },
    });
    const pan = JSON.parse(info.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
    assert.ok(
      !pan.DirectStreamUrl.startsWith("/emby/"),
      "Emby 自己给的地址就不带前缀，客户端会拿它去拼 base——加了就变成 /emby/emby/...",
    );

    // 代理挂在根上：客户端原样请求
    const atRoot = await app.inject({ method: "GET", url: pan.DirectStreamUrl });
    assert.equal(atRoot.statusCode, 302, "根路径部署应当命中");

    // 客户端 base 是 https://host/emby：它会把 /emby 拼在前面
    reset();
    const underEmby = await app.inject({ method: "GET", url: `/emby${pan.DirectStreamUrl}` });
    assert.equal(underEmby.statusCode, 302, "base 带 /emby 的部署同样要命中，否则全程中转");
  });

test("逐跳头不再把请求打成 500", async () => {
    for (const headers of [{ "keep-alive": "timeout=5" }, { expect: "100-continue" }]) {
      const a = await app.inject({ method: "GET", url: "/emby/System/Info", headers });
      const b = await app.inject({ method: "GET", url: "/Users/u1/Views", headers });
      assert.equal(a.statusCode, 200, "拦截路径");
      assert.equal(b.statusCode, 200, "透传路径");
    }
  });

test("拦截路径保留上游响应头", async () => {
    const res = await app.inject({ method: "GET", url: "/emby/System/Info" });
    // 只回 content-type 的话，跨源的浏览器客户端会被 CORS 拦掉
    assert.ok(res.headers["x-lab-marker"], "上游自定义响应头应当带回来");
  });

test("swapUrlPort 不碰主机名里的数字", () => {
    // 子串替换会把 emby8096.duckdns.org 改坏，同时端口没换
    assert.equal(swapUrlPort("http://emby8096.duckdns.org:8096", 8096, 8091),
                 "http://emby8096.duckdns.org:8091");
    assert.equal(swapUrlPort("http://192.168.0.80:80", 80, 8091), "http://192.168.0.80:8091");
    assert.equal(swapUrlPort("https://host:8920", 8096, 8091), "https://host:8920", "端口不匹配就别动");
    assert.equal(swapUrlPort("not-a-url", 8096, 8091), "not-a-url");
  });

test("Sync/JobItems 下载走 302（main 默认也 302）", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Sync/JobItems/job-1/File?api_key=k" });
    assert.equal(res.statusCode, 302, "离线下载不 302 的话整个文件都从 Node 过");
    assert.equal(res.headers.location, DIRECT_URL);
  });

test("改配置后旧缓存自动失效（跨进程）", async () => {
    reset();
    const a = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "UA-1" } });
    assert.equal(a.statusCode, 302);
    assert.equal(resolveCalls, 1);

    // 改一次配置：updated_at 变了，configRevision 跟着变，key 就对不上了
    const now = readAppSettings();
    setSettings({ ...now, mediaMountPath: [MOUNT, "/mnt/another"] });
    resetConfigRevisionMemo();

    await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "UA-1" } });
    assert.equal(resolveCalls, 2, "配置变了还命中旧缓存，说明失效没生效");
    setSettings(now);
    resetConfigRevisionMemo();
  });

// ---- 路由规则 ----

/** 改一下 emby 组里的规则，跑完还原；配置指纹的 memo 也要顺手重置 */
async function withEmbySettings(patch: Record<string, unknown>, fn: () => Promise<void>) {
  const now = readAppSettings();
  setSettings({ ...now, emby: { ...now.emby, ...patch } });
  resetConfigRevisionMemo();
  try {
    await fn();
  } finally {
    setSettings(now);
    resetConfigRevisionMemo();
  }
}

test("路由规则：按 UA 交给 Emby 的客户端不 302，PlaybackInfo 也原样", async () => {
    reset();
    await withEmbySettings({ routeRules: [{ action: "relay", userAgent: "oldbox" }] }, async () => {
      const relayed = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "OldBox/1.0" } });
      assert.equal(relayed.statusCode, 200);
      assert.equal(relayed.body, "upstream-ok", "命中 relay 的请求要原样回源");
      assert.equal(resolveCalls, 0, "交给 Emby 的请求不该去换直链");

      const other = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "VLC/3.0" } });
      assert.equal(other.statusCode, 302, "没命中规则的客户端照常 302");

      const info = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {}, headers: { "user-agent": "OldBox/1.0" } });
      const pan = JSON.parse(info.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
      assert.equal(pan.SupportsDirectPlay, false, "交给 Emby 的客户端，PlaybackInfo 不能改写，不然它拿不到转码");
      assert.equal(pan.SupportsTranscoding, undefined, "上游没给的字段也不该被我们补上");
      assert.match(pan.DirectStreamUrl, /^\/emby\/Videos\/ms-pan/, "地址要是上游原样的");
    });
  });

test("路由规则：按路径只让某个目录交给 Emby，其它目录照常 302；条目查询结果缓存", async () => {
    reset();
    await withEmbySettings({ routeRules: [{ action: "relay", path: `${MOUNT}/4K` }] }, async () => {
      itemLookups = 0;
      const relayed = await app.inject({ method: "GET", url: "/emby/Videos/item-4k/stream.mkv?api_key=k", headers: { "user-agent": "VLC/3.0" } });
      assert.equal(relayed.body, "upstream-ok", "4K 目录交给 Emby");
      assert.equal(resolveCalls, 0);
      assert.equal(itemLookups, 1, "裁决要看路径，得查一次条目");

      await app.inject({ method: "GET", url: "/emby/Videos/item-4k/stream.mkv?api_key=k", headers: { "user-agent": "VLC/3.0" } });
      assert.equal(itemLookups, 1, "同一条目再来一次不该再问 Emby");

      const other = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "VLC/3.0" } });
      assert.equal(other.statusCode, 302, "别的目录照常 302");
      assert.equal(other.headers.location, DIRECT_URL);

      const info = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
      const sources = JSON.parse(info.body).MediaSources;
      assert.equal(sources.find((s: { Id: string }) => s.Id === "ms-4k").SupportsDirectPlay, false, "4K 目录的源原样");
      assert.equal(sources.find((s: { Id: string }) => s.Id === "ms-pan").SupportsDirectPlay, true, "其它源照常改写");
    });
  });

test("路由规则：Infuse 命中 relay 时连第二跳都不走", async () => {
    reset();
    await withEmbySettings({ routeRules: [{ action: "relay", client: "infuse" }] }, async () => {
      const res = await app.inject({
        method: "GET",
        url: "/emby/Videos/item-1/stream.mkv",
        headers: { "user-agent": "Infuse-Direct/8.5", "x-emby-authorization": 'MediaBrowser Client="Infuse", Device="iPad", DeviceId="d1", Token="k"' },
      });
      assert.equal(res.statusCode, 200, "不该 302 回代理自己");
      assert.equal(res.body, "upstream-ok");
      assert.equal(resolveCalls, 0);
    });
  });

test("路由规则：按来源分内外网（inject 的来源是本机，算内网）", async () => {
    reset();
    await withEmbySettings({ routeRules: [{ action: "relay", remote: "lan" }] }, async () => {
      const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k" });
      assert.equal(res.body, "upstream-ok", "内网来的交给 Emby");
    });
    await withEmbySettings({ routeRules: [{ action: "relay", remote: "wan" }] }, async () => {
      const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k" });
      assert.equal(res.statusCode, 302, "规则只管外网，内网照常 302");
    });
  });

test("路由规则：条件全空的 relay 等于关掉 302，PlaybackInfo 也不碰", async () => {
    reset();
    await withEmbySettings({ routeRules: [{ action: "relay", note: "先全关" }] }, async () => {
      const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k" });
      assert.equal(res.body, "upstream-ok");
      const info = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
      const pan = JSON.parse(info.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
      assert.equal(pan.SupportsDirectPlay, false);
    });
  });

// ---- 路径映射 ----

test("路径映射的前缀算进挂载集合：PlaybackInfo 把那个目录的源标成可直连", async () => {
    reset();
    const before = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
    const untouched = JSON.parse(before.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-mapped");
    assert.equal(untouched.SupportsDirectPlay, false, "没有映射时这个前缀不归代理管");

    await withEmbySettings({ pathMappings: [{ from: `${MAPPED_MOUNT}/`, account: "主号", to: "/视频" }] }, async () => {
      const after = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
      const mapped = JSON.parse(after.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-mapped");
      assert.equal(mapped.SupportsDirectPlay, true, "映射的前缀要和挂载点一样被接管");
      assert.match(mapped.DirectStreamUrl, /^\/Videos\/item-1\/stream\.mkv\?/);
    });
  });

test("改了路由规则或路径映射，旧直链缓存立刻失效", async () => {
    reset();
    const a = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "UA-1" } });
    assert.equal(a.statusCode, 302);
    assert.equal(resolveCalls, 1);

    await withEmbySettings({ pathMappings: [{ from: "/mnt/zzz", account: "主号" }] }, async () => {
      await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "UA-1" } });
      assert.equal(resolveCalls, 2, "映射变了还命中旧缓存，说明规则没进配置指纹");
    });
    await withEmbySettings({ routeRules: [{ action: "redirect", userAgent: "nobody" }] }, async () => {
      await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k", headers: { "user-agent": "UA-1" } });
      assert.equal(resolveCalls, 3, "路由规则变了同样要重新解析");
    });
  });

// ---- System/Info/Public ----

test("System/Info/Public 也换端口：Public 版没有端口字段，Emby 的端口按上游地址推", async () => {
    const res = await app.inject({ method: "GET", url: "/emby/System/Info/Public" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.LocalAddress, "http://192.168.1.2:8091", "登录前拿到的地址也得指向代理，不然客户端连上就绕开了");
    assert.equal(body.ServerName, "lab", "其它字段原样");
    const lower = await app.inject({ method: "GET", url: "/system/info/public" });
    assert.equal(JSON.parse(lower.body).LocalAddress, "http://192.168.1.2:8091", "小写路径同样命中");
  });

after(async () => {
  setSettings(baseline);
  await app.close();
  emby.close();
});
