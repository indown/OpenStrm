/**
 * 迁移 0030：CloudDrive2 的地址和凭据从设置（app.cd2）搬成账户页里的一个 cd2 账号，设置里只留账号名和挂载映射。
 *
 * 测试库是新建的，迁移跑的时候 settings 表还是空的，这条迁移等于没动过数据。
 * 所以这里把迁移文件里的语句拿出来，对着造好的旧数据再跑一遍（同 throttle-migration.itest.ts）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/db/cd2-account-migration.itest.ts
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AccountCd2 } from "@openstrm/shared";
import { sqlite } from "./client.js";
import { getAccount, listAccounts, replaceAccounts } from "./repositories/accounts.js";
import { readAppSettings } from "./repositories/settings.js";
import { cd2AccountOf, cd2ConfigIfReady } from "../services/cd2/config.js";

const statements = fs
  .readFileSync(fileURLToPath(new URL("./migrations/0030_cd2_account.sql", import.meta.url)), "utf8")
  .split("--> statement-breakpoint");

const migrate = () => {
  for (const statement of statements) sqlite.exec(statement);
};
const put = (value: string) => sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('app.cd2', ?)").run(value);
const stored = (): unknown => {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'app.cd2'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
};
const cd2Accounts = (): AccountCd2[] => listAccounts().filter((a): a is AccountCd2 => a.accountType === "cd2");

const baseline = listAccounts();
const baselineCd2 = sqlite.prepare("SELECT value FROM settings WHERE key = 'app.cd2'").get() as { value: string } | undefined;

beforeEach(() => {
  sqlite.prepare("DELETE FROM settings WHERE key = 'app.cd2'").run();
  replaceAccounts([{ accountType: "115", name: "my115", cookie: "c" }]);
});
after(() => {
  replaceAccounts(baseline);
  sqlite.prepare("DELETE FROM settings WHERE key = 'app.cd2'").run();
  if (baselineCd2) put(baselineCd2.value);
});

test("填过地址和 API 令牌的：建出叫 cd2 的账号，令牌原样；设置里只剩账号名和映射，刷新照常能用", () => {
  const token = 'tok"en\\with-引号';
  put(JSON.stringify({ url: " http://192.168.1.10:19798 ", apiToken: token, username: "", password: "", mounts: { my115: "/115open", gone: "" } }));
  migrate();
  assert.deepEqual(stored(), { account: "cd2", mounts: { my115: "/115open", gone: "" } });
  assert.deepEqual(getAccount("cd2"), { accountType: "cd2", name: "cd2", url: "http://192.168.1.10:19798", apiToken: token }, "空串的用户名口令不带过去");
  const cfg = cd2ConfigIfReady(readAppSettings());
  assert.equal(cfg?.conn.name, "cd2");
  assert.equal(cfg?.conn.apiToken, token);
  assert.deepEqual(cfg?.mounts, { my115: "/115open" });
});

test("用户名口令登录的那种：三样都搬过去", () => {
  put(JSON.stringify({ url: "192.168.1.10:19798", username: "admin", password: "p@ss word", mounts: { my115: "/115" } }));
  migrate();
  assert.deepEqual(getAccount("cd2"), { accountType: "cd2", name: "cd2", url: "192.168.1.10:19798", username: "admin", password: "p@ss word" });
  assert.equal(cd2AccountOf(readAppSettings())?.username, "admin");
});

test("没填过地址的：不建账号，只把连接字段去掉；压根没有 app.cd2 的什么都不做", () => {
  put(JSON.stringify({ url: "  ", apiToken: "orphan", mounts: { my115: "/115" } }));
  migrate();
  assert.deepEqual(stored(), { mounts: { my115: "/115" } });
  assert.deepEqual(cd2Accounts(), []);

  sqlite.prepare("DELETE FROM settings WHERE key = 'app.cd2'").run();
  migrate();
  assert.equal(stored(), undefined);
  assert.deepEqual(cd2Accounts(), []);
});

test("只填了地址、还没填凭据的：账号照建（账户页里接着填），刷新这时还不会动", () => {
  put(JSON.stringify({ url: "http://cd2.local:19798", mounts: { my115: "/115" } }));
  migrate();
  assert.deepEqual(getAccount("cd2"), { accountType: "cd2", name: "cd2", url: "http://cd2.local:19798" });
  assert.equal(cd2AccountOf(readAppSettings()), null, "缺凭据的账号不算能用");
});

test("已经有叫 cd2 的账号：新账号换个名字，设置指向新名字，原来那个不动", () => {
  replaceAccounts([{ accountType: "openlist", name: "cd2", account: "a", password: "p", url: "http://ol" }]);
  put(JSON.stringify({ url: "http://cd2.local:19798", apiToken: "tok", mounts: { x: "/115" } }));
  migrate();
  const name = (stored() as { account: string }).account;
  assert.match(name, /^cd2-[0-9a-f]{6}$/);
  assert.equal(getAccount("cd2")?.accountType, "openlist", "同名的老账号没被盖掉");
  assert.deepEqual(getAccount(name), { accountType: "cd2", name, url: "http://cd2.local:19798", apiToken: "tok" });
  assert.equal(cd2AccountOf(readAppSettings())?.name, name);
});

test("跑两遍：不重复建账号，设置不再变", () => {
  put(JSON.stringify({ url: "http://cd2.local:19798", apiToken: "tok", mounts: { my115: "/115" } }));
  migrate();
  const once = stored();
  migrate();
  assert.deepEqual(stored(), once);
  assert.deepEqual(cd2Accounts().map((a) => a.name), ["cd2"]);
});

test("已经是新形状的（升级后又跑到）：原样；不是 JSON 对象的不碰", () => {
  replaceAccounts([{ accountType: "cd2", name: "nas-cd2", url: "http://cd2.local:19798", apiToken: "tok" }]);
  put(JSON.stringify({ account: "nas-cd2", mounts: { my115: "/115" } }));
  migrate();
  assert.deepEqual(stored(), { account: "nas-cd2", mounts: { my115: "/115" } });
  assert.deepEqual(cd2Accounts().map((a) => a.name), ["nas-cd2"]);

  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('app.cd2', 'not json')").run();
  migrate();
  assert.equal((sqlite.prepare("SELECT value FROM settings WHERE key = 'app.cd2'").get() as { value: string }).value, "not json");
  put("[1,2]");
  migrate();
  assert.deepEqual(stored(), [1, 2]);
});
