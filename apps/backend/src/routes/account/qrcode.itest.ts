/**
 * 115 扫码登录的两个路由：只认会话（令牌 403）、入参校验、生成 → 轮询 → 确认带 cookie → 再问 404。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/account/qrcode.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppSettings } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import accountQrcodeRoute from "./qrcode.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { createApiToken, deleteAllApiTokens } from "../../db/repositories/api-tokens.js";
import { patchAppSettings, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { resetQrcodeSessions, setQrcodeApiBase } from "../../services/cloud-115/qrcode.js";
import { startFake115Qrcode, type Fake115Qrcode } from "../../test/fake-115-qrcode.js";

let app: FastifyInstance;
let session: Record<string, string>;
let fake: Fake115Qrcode;
let baseline: AppSettings;

before(async () => {
  baseline = readAppSettings();
  await writeAuthPassword("qrcode-itest-pw");
  fake = await startFake115Qrcode({ advanceEvery: 1 });
  setQrcodeApiBase(fake.base);
  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(accountQrcodeRoute);
  await app.ready();
  session = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  setQrcodeApiBase(null);
  resetQrcodeSessions();
  await fake.close();
  deleteAllApiTokens();
  replaceAppSettings(baseline);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

test("没登录 401；智能体令牌 403：账号凭据的接口不对令牌开放", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/account/115/qrcode", payload: { app: "alipaymini" } })).statusCode, 401);
  patchAppSettings({ agent: { enabled: true } });
  const { token } = createApiToken({ name: "全档", scopes: ["read", "run", "write", "danger"], toolsets: ["sync", "transfer", "organize", "follow", "strm"], expiresAt: null });
  const headers = { authorization: `Bearer ${token}` };
  const start = await app.inject({ method: "POST", url: "/api/account/115/qrcode", headers, payload: { app: "alipaymini" } });
  assert.equal(start.statusCode, 403);
  assert.equal(start.json().code, "TOKEN_NOT_ALLOWED");
  const poll = await app.inject({ method: "GET", url: "/api/account/115/qrcode/x", headers });
  assert.equal(poll.statusCode, 403);
  assert.equal(fake.calls.length, 0, "没碰 115");
});

test("app 不在名单里（网页、桌面端）→ 400 VALIDATION", async () => {
  for (const bad of ["web", "linux", "", undefined]) {
    const res = await app.inject({ method: "POST", url: "/api/account/115/qrcode", headers: session, payload: { app: bad } });
    assert.equal(res.statusCode, 400, String(bad));
    assert.equal(res.json().code, "VALIDATION");
    assert.match(res.json().message, /^app/);
  }
});

test("生成 → 轮询到确认带 cookie → 再问还是同一份；不存在的 uid 是 404", async () => {
  fake.reset();
  const start = await app.inject({ method: "POST", url: "/api/account/115/qrcode", headers: session, payload: { app: "wechatmini" } });
  assert.equal(start.statusCode, 201, start.body);
  const { uid, image, expiresAt } = start.json();
  assert.equal(typeof uid, "string");
  assert.match(image, /^data:image\/png;base64,/);
  assert.ok(expiresAt > Date.now());

  const poll = () => app.inject({ method: "GET", url: `/api/account/115/qrcode/${encodeURIComponent(uid)}`, headers: session });
  assert.deepEqual((await poll()).json(), { status: "waiting" });
  assert.deepEqual((await poll()).json(), { status: "scanned" });
  const done = (await poll()).json();
  assert.equal(done.status, "confirmed");
  assert.equal(done.cookie, "UID=12_R1_123; CID=cid-wechatmini; SEID=seid-wechatmini; KID=kid-wechatmini");
  assert.equal(done.userName, "fake user");

  // 那一次响应要是没送到（前端超时、连接断了），再问还能拿到，不用重扫
  const again = await poll();
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), done);
  const unknown = await app.inject({ method: "GET", url: "/api/account/115/qrcode/nope", headers: session });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().code, "QRCODE_GONE");
});

test("115 那边出错：500 带原话，界面能照着说", async () => {
  fake.reset();
  fake.tokenResponse = { state: 0, code: 99, message: "系统繁忙" };
  const res = await app.inject({ method: "POST", url: "/api/account/115/qrcode", headers: session, payload: { app: "tv" } });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().message, "115：系统繁忙");
  assert.equal(res.json().code, 99);
  fake.tokenResponse = null;
});
