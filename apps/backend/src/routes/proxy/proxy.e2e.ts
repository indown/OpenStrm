/**
 * 代理层的真机验收：跑在**真的 Emby** 前面，而不是桩。
 *
 * 离线的 proxy.itest.ts 用假 Emby，覆盖不到真实响应的形状：
 * Emby 4.9 的 MediaSource.Id 长 `mediasource_11` 这样、strm 条目的
 * Container 是 `strm` 而不是视频容器、PlaybackInfo 默认给 TranscodingUrl。
 *
 * 可选地和 main 分支的 nginx/njs 栈做逐项对照，确认 Node 取代 nginx 之后功能没退化。
 *
 * 用法（scripts/emby-lab.sh 会把环境准备好并打印这些变量）：
 *   EMBY_URL=http://127.0.0.1:8096 EMBY_API_KEY=xxx EMBY_USER_ID=xxx \
 *   STRM_ITEM_ID=11 LOCAL_ITEM_ID=7 MOUNT=/mnt/pan \
 *   STUB_FS_GET=http://127.0.0.1:8000 \
 *   [MAIN_PROXY=http://127.0.0.1:8091] \
 *   CONFIG_DIR=... DATA_DIR=... npx tsx src/routes/proxy/proxy.e2e.ts
 */
import assert from "node:assert/strict";
import net from "node:net";
import Fastify from "fastify";
import { initDb } from "../../db/migrate.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import proxyPlugin from "./index.js";
import { clearLinkCache, setLinkResolver } from "./redirect.js";

/**
 * 这些用例会写 settings 表。没指定 CONFIG_DIR 就会写到开发者真实的库上，
 * 把 Emby 地址改成一个测试用的死端口——直接拒绝跑。
 */
if (!process.env.CONFIG_DIR) {
  console.error("拒绝在默认 CONFIG_DIR 上运行：请显式指定 CONFIG_DIR / DATA_DIR 到临时目录");
  process.exit(2);
}


const need = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`缺少环境变量 ${name}，先跑 scripts/emby-lab.sh`);
    process.exit(2);
  }
  return v;
};

const EMBY_URL = need("EMBY_URL");
const API_KEY = need("EMBY_API_KEY");
const USER_ID = need("EMBY_USER_ID");
const STRM_ITEM = need("STRM_ITEM_ID");
const LOCAL_ITEM = need("LOCAL_ITEM_ID");
const MOUNT = process.env.MOUNT || "/mnt/pan";
const STUB = need("STUB_FS_GET");
const MAIN = process.env.MAIN_PROXY; // 有就做 A/B 对照

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  pass++;
  console.log("  ok  " + name);
};

await initDb();
const baseline = readAppSettings();
replaceAppSettings({
  ...baseline,
  emby: { url: EMBY_URL, apiKey: API_KEY },
  mediaMountPath: [MOUNT],
});

/**
 * 走和 main 完全相同的解析链：调同一个 /api/fs/get 桩。
 * 115 那一段本来就没法在测试里真调，重点是代理层的行为。
 */
setLinkResolver(async (embyPath) => {
  if (!embyPath.startsWith(MOUNT)) return { ok: false, reason: "not-mounted" };
  const rest = embyPath.slice(MOUNT.length);
  const res = await fetch(`${STUB}/api/fs/get`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "lab-token" },
    body: JSON.stringify({ path: rest }),
  });
  const body = (await res.json()) as { code: number; data?: { raw_url: string } };
  if (body.code !== 200 || !body.data) return { ok: false, reason: "not-found" };
  return { ok: true, url: body.data.raw_url, accountName: "lab", panPath: rest, timings: { pathMs: 0, linkMs: 0 } };
});

const app = Fastify({ logger: false, requestTimeout: 300_000 });
await app.register(proxyPlugin);
await app.listen({ port: 0, host: "127.0.0.1" });
const V2 = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

/** 桩返回的直链，Location 必须和它逐字节一致 */
const RAW_LINK = await (async () => {
  const res = await fetch(`${STUB}/api/fs/get`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "lab-token" },
    body: JSON.stringify({ path: "/probe" }),
  });
  return ((await res.json()) as { data: { raw_url: string } }).data.raw_url;
})();

type Hit = { status: number; location?: string; headers: Headers; body: string };
async function hit(base: string, path: string, init: RequestInit = {}): Promise<Hit> {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  return {
    status: res.status,
    location: res.headers.get("location") ?? undefined,
    headers: res.headers,
    body: await res.text(),
  };
}

/**
 * 逐跳头必须用原始 socket 发：undici 在客户端侧就会拒掉 keep-alive/expect，
 * fetch 根本送不出去，也就验不到服务端的处理。
 */
function rawRequest(base: string, path: string, extraHeaders: string): Promise<number> {
  const { port, hostname } = new URL(base);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\n${extraHeaders}Connection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      // Expect: 100-continue 时会先来一个 100 Continue 的中间响应，取最后一个状态行
      const codes = [...data.matchAll(/^HTTP\/1\.[01] (\d{3})/gm)].map((m) => Number(m[1]));
      resolve(codes.length ? codes[codes.length - 1] : -1);
    });
    socket.on("error", () => resolve(-1));
  });
}

const PBI_BODY = JSON.stringify({
  DeviceProfile: {
    MaxStreamingBitrate: 120000000,
    DirectPlayProfiles: [{ Container: "mkv", Type: "Video" }],
  },
});

try {
  console.log("302 直链（真 Emby 的条目）");

  for (const [name, path] of [
    ["stream", `/emby/Videos/${STRM_ITEM}/stream?api_key=${API_KEY}`],
    ["stream 小写", `/emby/videos/${STRM_ITEM}/stream?api_key=${API_KEY}`],
    ["stream 无 /emby 前缀", `/Videos/${STRM_ITEM}/stream?api_key=${API_KEY}`],
    ["stream.mkv 带扩展名", `/emby/Videos/${STRM_ITEM}/stream.mkv?api_key=${API_KEY}`],
    ["original", `/emby/Videos/${STRM_ITEM}/original?api_key=${API_KEY}`],
    ["Items Download", `/emby/Items/${STRM_ITEM}/Download?api_key=${API_KEY}`],
  ] as const) {
    await t(`${name} → 302 且直链原样透传`, async () => {
      clearLinkCache();
      const r = await hit(V2, path);
      assert.equal(r.status, 302);
      assert.equal(r.location, RAW_LINK, "已转义的直链不能被二次编码");
    });
  }

  console.log("不该 302 的");

  await t("本地文件回源，不被 302", async () => {
    clearLinkCache();
    const r = await hit(V2, `/emby/Videos/${LOCAL_ITEM}/stream?api_key=${API_KEY}&Static=true`);
    assert.notEqual(r.status, 302, "本地文件被 302 说明挂载点判断错了");
    assert.equal(r.status, 200);
  });

  await t("HEAD 探测回源", async () => {
    clearLinkCache();
    const r = await hit(V2, `/emby/Videos/${STRM_ITEM}/stream?api_key=${API_KEY}`, { method: "HEAD" });
    assert.notEqual(r.status, 302);
  });

  console.log("PlaybackInfo（真 Emby 的响应形状）");

  await t("strm 源被标成可直连、转码关闭，DirectStreamUrl 可跟进", async () => {
    const r = await hit(V2, `/emby/Items/${STRM_ITEM}/PlaybackInfo?UserId=${USER_ID}&api_key=${API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: PBI_BODY,
    });
    assert.equal(r.status, 200);
    const source = JSON.parse(r.body).MediaSources[0];
    assert.equal(source.SupportsDirectPlay, true);
    assert.equal(source.SupportsDirectStream, true);
    assert.equal(source.SupportsTranscoding, false, "转码没关的话限码率客户端会绕开 302");
    assert.ok(source.DirectStreamUrl, "必须给出 DirectStreamUrl");

    // 关键：客户端照着这个 URL 请求，必须真的拿到 302
    clearLinkCache();
    const followed = await hit(V2, source.DirectStreamUrl);
    assert.equal(followed.status, 302, "客户端跟着 DirectStreamUrl 走应当拿到 302");
    assert.equal(followed.location, RAW_LINK);
  });

  await t("空 body / 表单 content-type 都不被挡", async () => {
    for (const ct of ["application/json", "application/x-www-form-urlencoded", "text/plain"]) {
      const r = await hit(V2, `/emby/Items/${STRM_ITEM}/PlaybackInfo?UserId=${USER_ID}&api_key=${API_KEY}`, {
        method: "POST",
        headers: { "content-type": ct },
        body: "",
      });
      assert.equal(r.status, 200, `${ct} 空 body 被挡了`);
    }
  });

  console.log("其他接口");

  await t("System/Info 端口改写成本代理端口", async () => {
    const r = await hit(V2, `/emby/System/Info?api_key=${API_KEY}`);
    const info = JSON.parse(r.body);
    const port = (app.server.address() as { port: number }).port;
    assert.equal(info.WebSocketPortNumber, port, "不改的话客户端会绕过代理直连 Emby");
  });

  await t("basehtmlplayer 打了 crossorigin 补丁", async () => {
    const r = await hit(V2, "/web/modules/htmlvideoplayer/basehtmlplayer.js");
    assert.equal(r.status, 200);
    assert.ok(r.body.length > 1000, "拿到的应当是真的播放器脚本");
    assert.ok(!r.body.includes('"anonymous"'), "补丁没生效，web 端会因 CORS 播不了 115 直链");
  });

  await t("逐跳头不会把请求打成 500", async () => {
    for (const extra of ["Keep-Alive: timeout=5\r\n", "Expect: 100-continue\r\n"]) {
      for (const path of [`/emby/System/Info?api_key=${API_KEY}`, `/emby/Users/${USER_ID}/Items?api_key=${API_KEY}`]) {
        assert.equal(await rawRequest(V2, path, extra), 200, `${extra.trim()} ${path}`);
      }
    }
  });

  if (MAIN) {
    console.log("与 main(nginx) 逐项对照");

    const cases: Array<[string, string, RequestInit?]> = [
      ["stream", `/emby/Videos/${STRM_ITEM}/stream?api_key=${API_KEY}`],
      ["original", `/emby/Videos/${STRM_ITEM}/original?api_key=${API_KEY}`],
      ["Items Download", `/emby/Items/${STRM_ITEM}/Download?api_key=${API_KEY}`],
      ["本地文件", `/emby/Videos/${LOCAL_ITEM}/stream?api_key=${API_KEY}&Static=true`],
      ["用户条目列表", `/emby/Users/${USER_ID}/Items?api_key=${API_KEY}`],
    ];
    for (const [name, path, init] of cases) {
      await t(`main 与 v2 一致：${name}`, async () => {
        clearLinkCache();
        const a = await hit(MAIN, path, init);
        const b = await hit(V2, path, init);
        assert.equal(b.status, a.status, `状态码不一致 main=${a.status} v2=${b.status}`);
        assert.equal(b.location, a.location, "Location 不一致");
      });
    }

    await t("main 与 v2 一致：逐跳头", async () => {
      const path = `/emby/System/Info?api_key=${API_KEY}`;
      const extra = "Keep-Alive: timeout=5\r\n";
      assert.equal(await rawRequest(V2, path, extra), await rawRequest(MAIN, path, extra));
    });

    await t("main 与 v2 一致：PlaybackInfo 的直连判定", async () => {
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: PBI_BODY,
      };
      const path = `/emby/Items/${STRM_ITEM}/PlaybackInfo?UserId=${USER_ID}&api_key=${API_KEY}`;
      const pick = (raw: string) => {
        const s = JSON.parse(raw).MediaSources[0];
        return [s.SupportsDirectPlay, s.SupportsDirectStream, s.SupportsTranscoding];
      };
      const a = await hit(MAIN, path, init);
      const b = await hit(V2, path, init);
      assert.deepEqual(pick(b.body), pick(a.body));
    });
  } else {
    console.log("（未设 MAIN_PROXY，跳过与 main 的对照）");
  }

  console.log(`\n${pass} passed`);
} finally {
  replaceAppSettings(baseline);
  await app.close();
}
