/**
 * CloudDrive2 的「检查连接」对着假 gRPC 服务：各段各自成败。账户弹框按草稿验（掩码的令牌 / 口令换回账号里存的原值），
 * 设置页按选中的账号验；用 API 令牌时多一段按用途说的权限。回包里没有令牌。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/cd2/check.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, Cd2CheckResult } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { MASK } from "../../lib/secrets.js";
import { authPlugin } from "../../plugins/auth.js";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { __test_resetCd2Tokens } from "../../services/cd2/client.js";
import { FAKE_CD2_ALL_PERMISSIONS, FakeCd2 } from "../../test/fake-cd2.js";
import checkRoute from "./check.js";

const fake = new FakeCd2();
let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: AccountInfo[];

before(async () => {
  baseline = listAccounts();
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
  replaceAccounts([
    { accountType: "cd2", name: "nas-cd2", url: fake.url, apiToken: "api-token" },
    { accountType: "cd2", name: "by-login", url: fake.url, username: "admin", password: "pw" },
    { accountType: "openlist", name: "ol", account: "a", password: "p", url: "http://ol.local" },
  ]);
});
after(async () => {
  await app.close();
  await fake.stop();
  replaceAccounts(baseline);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const check = async (payload: Record<string, unknown>): Promise<Cd2CheckResult> => {
  const res = await app.inject({ method: "POST", url: "/api/cd2/check", headers: auth, payload });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};

test("草稿全对：地址通、API 令牌能用、每个映射都列得出来；普通令牌读不到权限表就没有权限那一段；回包里没有令牌", async () => {
  const plain = await check({ url: fake.url, apiToken: "api-token", mounts: { acc: "/115" } });
  assert.deepEqual([plain.system.ok, plain.auth.ok, plain.copy?.ok, plain.permissions], [true, true, true, undefined], "真 CD2 的默认表现：令牌没有「令牌管理」权限，权限表读不到");
  // 令牌带「令牌管理」权限的才读得到权限表
  fake.tokenManagement = true;
  const r = await check({ url: fake.url, apiToken: "api-token", mounts: { acc: "/115", qk: "/115/movie" } });
  assert.equal(r.system.ok, true);
  assert.match(r.system.message, /已登录/);
  assert.equal(r.auth.ok, true);
  assert.deepEqual(r.mounts.map((m) => [m.account, m.path, m.ok, m.entries]), [["acc", "/115", true, 2], ["qk", "/115/movie", true, 3]]);
  assert.equal(r.copy?.ok, true, "能看传输任务");
  assert.deepEqual(r.permissions, { ok: true, message: "令牌权限齐全：浏览和刷新目录、同步、整理、复制都够", missing: [] });
  assert.ok(!JSON.stringify(r).includes("api-token"));
});

test("按账号查（设置页）：用账号里存着的地址和凭据；没选、不存在、不是 CD2 账号各有各的说法", async () => {
  const r = await check({ account: "nas-cd2", mounts: { acc: "/115" } });
  assert.deepEqual([r.system.ok, r.auth.ok, r.auth.message], [true, true, "API 令牌可用"]);
  assert.deepEqual(r.mounts.map((m) => [m.account, m.ok]), [["acc", true]]);
  const login = await check({ account: "by-login" });
  assert.deepEqual([login.auth.ok, login.auth.message], [true, "用户名口令换到了令牌"]);
  assert.equal(login.permissions, undefined, "用户名口令登录的没有令牌权限这一段");
  assert.equal(login.copy?.ok, true);

  for (const [payload, why] of [
    [{ mounts: { acc: "/115" } }, "还没选 CD2 账号"],
    [{ account: "删掉了的" }, "CloudDrive2 账号不存在：删掉了的"],
    [{ account: "ol" }, "ol 不是 CloudDrive2 账号"],
  ] as const) {
    const bad = await check(payload);
    assert.deepEqual([bad.system, bad.auth, bad.mounts], [{ ok: false, message: why }, { ok: false, message: why }, []]);
  }
});

test("草稿里掩码的令牌 / 口令换回 account 那个账号存的原值；没给账号、账号不是 CD2 的按没填处理", async () => {
  const r = await check({ account: "nas-cd2", url: fake.url, apiToken: `${MASK}oken`, mounts: { acc: "/115" } });
  assert.equal(r.auth.ok, true, r.auth.message);
  const pw = await check({ account: "by-login", url: fake.url, username: "admin", password: MASK });
  assert.equal(pw.auth.ok, true, pw.auth.message);
  const typed = await check({ account: "by-login", url: fake.url, username: "admin", password: "wrong" });
  assert.equal(typed.auth.ok, false, "新打的口令以打的为准，不拿存着的顶");
  for (const account of [undefined, "ol", "不存在"]) {
    const none = await check({ ...(account ? { account } : {}), url: fake.url, apiToken: `${MASK}oken` });
    assert.equal(none.auth.ok, false);
    assert.match(none.auth.message, /没填 API 令牌/);
  }
});

test("令牌缺权限：按用途说缺哪几项；限了根目录的说出来；复制那一下探测照做", async () => {
  // 只勾了列目录、读、复制（外加能读权限表的「令牌管理」）：整理缺四项，复制缺「获取传输任务」「创建文件夹」
  fake.tokenManagement = true;
  fake.tokenInfo = { rootDir: "/115", friendlyName: "只读", expiresIn: 0, permissions: [1, 7, 10] };
  fake.denyCopyTasks = true;
  const r = await check({ account: "nas-cd2" });
  assert.equal(r.auth.ok, true, "读得了目录，凭据这段仍是绿的");
  assert.deepEqual(r.permissions?.missing, [
    { use: "organize", lacks: ["创建文件夹", "重命名", "移动", "删除"] },
    { use: "copy", lacks: ["获取传输任务", "创建文件夹"] },
  ]);
  assert.equal(r.permissions?.ok, false);
  assert.equal(r.permissions?.rootDir, "/115");
  assert.equal(r.permissions?.message, "令牌缺权限：整理缺「创建文件夹」「重命名」「移动」「删除」；复制缺「获取传输任务」「创建文件夹」；令牌限定在 /115 下");
  assert.equal(r.copy?.ok, false);
  assert.match(r.copy!.message, /获取传输任务/);

  // 连列目录都没勾的：同步也跟着缺
  fake.tokenInfo = { rootDir: "", friendlyName: "", expiresIn: 0, permissions: FAKE_CD2_ALL_PERMISSIONS.filter((p) => p !== 7) };
  fake.denyCopyTasks = false;
  const noRead = await check({ account: "nas-cd2" });
  assert.deepEqual(noRead.permissions?.missing, [{ use: "sync", lacks: ["读取文件"] }]);
  assert.equal(noRead.permissions?.rootDir, undefined);
});

test("读不到令牌的权限表（普通令牌 CD2 不给读 / 老版本没有这个接口）：不报错、没有权限这一段，退回探测传输任务", async () => {
  fake.denyCopyTasks = true;
  const r = await check({ account: "nas-cd2", mounts: { acc: "/115" } });
  assert.equal(r.auth.ok, true);
  assert.equal(r.permissions, undefined);
  assert.equal(r.copy?.ok, false);
  assert.match(r.copy!.message, /获取传输任务/);
  assert.equal(r.mounts[0]?.ok, true, "后面的映射照查");
});

test("凭据不对：地址那段仍是通的，凭据那段报 UNAUTHENTICATED，映射不查，也没有权限和复制两段", async () => {
  const r = await check({ url: fake.url, username: "admin", password: "wrong", mounts: { acc: "/115" } });
  assert.equal(r.system.ok, true);
  assert.equal(r.auth.ok, false);
  assert.match(r.auth.message, /用户名或密码不对/);
  assert.deepEqual(r.mounts.map((m) => [m.ok, m.message]), [[false, "凭据没过，没查"]]);
  assert.deepEqual([r.copy, r.permissions], [undefined, undefined]);
  const bad = await check({ url: fake.url, apiToken: "bad", mounts: { acc: "/115" } });
  assert.equal(bad.auth.ok, false, "API 令牌也要真验一下，不是填了就算对");
});

test("映射填错：那一条不 ok 并带 CD2 的原话，别的照常", async () => {
  const r = await check({ url: fake.url, apiToken: "api-token", mounts: { acc: "/115", qk: "/夸克" } });
  assert.deepEqual(r.mounts.map((m) => [m.account, m.ok]), [["acc", true], ["qk", false]]);
  assert.match(r.mounts[1]!.message, /find by path: "\/夸克" not found under "\/"/);
});

test("没填地址 / 地址不通：后面几段不白跑", async () => {
  const none = await check({ url: "" });
  assert.deepEqual([none.system.ok, none.system.message, none.auth.ok, none.mounts], [false, "还没填地址", false, []]);
  const down = await check({ url: "http://127.0.0.1:1", apiToken: "x", mounts: { acc: "/115" } });
  assert.equal(down.system.ok, false);
  assert.match(down.auth.message, /地址都没通/);
  assert.equal(down.mounts[0]?.ok, false);
});
