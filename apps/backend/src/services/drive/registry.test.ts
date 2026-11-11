/**
 * 注册表：按账号类型分派、认分享链接时谁先谁后、同类校验、测试注入口。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/drive/registry.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AccountInfo } from "@openstrm/shared";
import { HttpError } from "../../lib/http-error.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { assertSameKind, matchShareLink, providerFor, setDriveProviderFactory } from "./registry.js";
import { isMountLayerKind } from "./types.js";

const a115: AccountInfo = { accountType: "115", name: "a", cookie: "c" };
const quark: AccountInfo = { accountType: "quark", name: "q", cookie: "c" };
const ol: AccountInfo = { accountType: "openlist", name: "o", account: "u", password: "p", url: "http://x" };
const cd2: AccountInfo = { accountType: "cd2", name: "c", url: "http://127.0.0.1:1", apiToken: "t" };

after(() => setDriveProviderFactory(null));

test("providerFor：按账号类型分派，能力位各不相同", () => {
  assert.equal(providerFor(a115).kind, "115");
  assert.equal(providerFor(quark).kind, "quark");
  assert.equal(providerFor(ol).kind, "openlist");
  assert.equal(providerFor(a115).capabilities.share, true);
  assert.equal(providerFor(ol).capabilities.share, false);
  assert.equal(providerFor(ol).rootId, "/");
  assert.equal(providerFor(cd2).kind, "cd2");
  assert.deepEqual(providerFor(cd2).capabilities, { share: false, changes: false, write: true });
  assert.equal(providerFor(cd2).rootId, "/");
});

test("pathIds / 挂载层账号：OpenList 和 CloudDrive2 的 id 就是路径，它们是挂载层不是网盘", () => {
  assert.deepEqual([a115, quark, ol, cd2].map((a) => providerFor(a).pathIds), [false, false, true, true]);
  assert.deepEqual([a115, quark, ol, cd2].map((a) => isMountLayerKind(a.accountType)), [false, false, true, true]);
  assert.equal(isMountLayerKind(undefined), false);
});

test("115 只认自家域名和裸分享码，别家的链接不抢", () => {
  const share = providerFor(a115).share!;
  assert.deepEqual(share.parseLink("https://115cdn.com/s/swhk9bx3wwq?password=sff1"), {
    kind: "115",
    code: "swhk9bx3wwq",
    password: "sff1",
    url: "https://115cdn.com/s/swhk9bx3wwq?password=sff1",
  });
  assert.equal(share.parseLink("swhk9bx3wwq")?.code, "swhk9bx3wwq");
  assert.equal(share.parseLink("https://pan.quark.cn/s/1ed94d530d63"), null);
  assert.equal(share.parseLink(""), null);
});

test("matchShareLink：按账号池里的网盘挑，指定账号就只问它", () => {
  const accounts = [a115, ol];
  assert.equal(matchShareLink("https://115.com/s/abc123", { accounts })?.provider.kind, "115");
  assert.equal(matchShareLink("https://pan.quark.cn/s/abc123", { accounts }), null);
  assert.equal(matchShareLink("https://115.com/s/abc123", { accounts, account: "o" }), null);
});

test("assertSameKind：分享的网盘和目标账号不同类就 400", () => {
  const p = providerFor(a115);
  assert.doesNotThrow(() => assertSameKind({ kind: "115", code: "x", password: "", url: "" }, p));
  assert.throws(
    () => assertSameKind({ kind: "quark", code: "x", password: "", url: "" }, p),
    (e: unknown) => e instanceof HttpError && e.status === 400 && /夸克网盘的分享/.test(e.message),
  );
});

test("setDriveProviderFactory：返回 null 的账号照旧走真实现", () => {
  const fake = new FakeDrive("115", a115, { share: true });
  setDriveProviderFactory((account) => (account.name === "a" ? fake : null));
  assert.equal(providerFor(a115), fake);
  assert.equal(providerFor(quark).kind, "quark");
  setDriveProviderFactory(null);
  assert.notEqual(providerFor(a115), fake);
});
