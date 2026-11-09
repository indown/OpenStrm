/**
 * 设置页「CloudDrive2」的检查接口对着假 gRPC 服务：三段各自成败，掩码的令牌换回库里的原值，不回令牌。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/cd2/check.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppSettings, Cd2CheckResult } from "@openstrm/shared";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { MASK } from "../../lib/secrets.js";
import { authPlugin } from "../../plugins/auth.js";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { __test_resetCd2Tokens } from "../../services/cd2/client.js";
import { FakeCd2 } from "../../test/fake-cd2.js";
import checkRoute from "./check.js";

const fake = new FakeCd2();
let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: AppSettings["cd2"];

before(async () => {
  baseline = readAppSettings().cd2;
  await fake.start();
  await writeAuthPassword("cd2-itest-pw");
  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(checkRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});
beforeEach(() => {
  fake.reset();
  fake.tree = { "/": ["115/"], "/115": ["movie/", "tv/"], "/115/movie": ["A (2013)/", "B (2020)/", "loose.mkv"] };
  __test_resetCd2Tokens();
  patchAppSettings({ cd2: {} });
});
after(async () => {
  await app.close();
  await fake.stop();
  patchAppSettings({ cd2: baseline });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const check = async (payload: Record<string, unknown>): Promise<Cd2CheckResult> => {
  const res = await app.inject({ method: "POST", url: "/api/cd2/check", headers: auth, payload });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};

test("全对：地址通、API 令牌能用、每个映射都列得出来；回包里没有令牌", async () => {
  const r = await check({ url: fake.url, apiToken: "api-token", mounts: { acc: "/115", qk: "/115/movie" } });
  assert.equal(r.system.ok, true);
  assert.match(r.system.message, /已登录/);
  assert.equal(r.auth.ok, true);
  assert.deepEqual(r.mounts.map((m) => [m.account, m.path, m.ok, m.entries]), [["acc", "/115", true, 2], ["qk", "/115/movie", true, 3]]);
  assert.equal(r.copy?.ok, true, "能看传输任务");
  assert.ok(!JSON.stringify(r).includes("api-token"));
  fake.denyCopyTasks = true;
  const limited = await check({ url: fake.url, apiToken: "api-token", mounts: { acc: "/115" } });
  assert.equal(limited.auth.ok, true, "读得了目录，凭据这段仍是绿的");
  assert.equal(limited.copy?.ok, false);
  assert.match(limited.copy!.message, /查看传输任务/);
});

test("掩码的令牌换回库里存的；库里没有就按空处理", async () => {
  patchAppSettings({ cd2: { url: fake.url, apiToken: "api-token", mounts: { acc: "/115" } } });
  const r = await check({ url: fake.url, apiToken: `${MASK}oken`, mounts: { acc: "/115" } });
  assert.equal(r.auth.ok, true, r.auth.message);
  patchAppSettings({ cd2: {} });
  const r2 = await check({ url: fake.url, apiToken: `${MASK}oken`, mounts: { acc: "/115" } });
  assert.equal(r2.auth.ok, false);
  assert.match(r2.auth.message, /没填 API 令牌/);
});

test("凭据不对：地址那段仍是通的，凭据那段报 UNAUTHENTICATED，映射不查", async () => {
  const r = await check({ url: fake.url, username: "admin", password: "wrong", mounts: { acc: "/115" } });
  assert.equal(r.system.ok, true);
  assert.equal(r.auth.ok, false);
  assert.match(r.auth.message, /用户名或密码不对/);
  assert.deepEqual(r.mounts.map((m) => [m.ok, m.message]), [[false, "凭据没过，没查"]]);
  const bad = await check({ url: fake.url, apiToken: "bad", mounts: { acc: "/115" } });
  assert.equal(bad.auth.ok, false, "API 令牌也要真验一下，不是填了就算对");
});

test("映射填错：那一条不 ok 并带 CD2 的原话，别的照常", async () => {
  const r = await check({ url: fake.url, apiToken: "api-token", mounts: { acc: "/115", qk: "/夸克" } });
  assert.deepEqual(r.mounts.map((m) => [m.account, m.ok]), [["acc", true], ["qk", false]]);
  assert.match(r.mounts[1]!.message, /object not found/);
});

test("没填地址 / 地址不通：后面两段不白跑", async () => {
  const none = await check({ url: "" });
  assert.deepEqual([none.system.ok, none.auth.ok, none.mounts], [false, false, []]);
  const down = await check({ url: "http://127.0.0.1:1", apiToken: "x", mounts: { acc: "/115" } });
  assert.equal(down.system.ok, false);
  assert.match(down.auth.message, /地址都没通/);
  assert.equal(down.mounts[0]?.ok, false);
});
