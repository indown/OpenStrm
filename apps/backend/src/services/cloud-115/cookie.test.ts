/**
 * 115 cookie 的登录端识别。夹具故意用短的 UID（`12_A1_123`）：scripts/check-hygiene.sh 把
 * `UID=<3 位以上>_X1_<6 位以上>` 当成真凭据，像真的那样写进来提交会被拦。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/cloud-115/cookie.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieFromParts, cookieSsoent, isWebCookie } from "./cookie.js";

test("cookieSsoent：UID 在开头 / 中间 / 带空格都能取出中段", () => {
  assert.equal(cookieSsoent("UID=12_A1_123; CID=c; SEID=s"), "A1");
  assert.equal(cookieSsoent("CID=c; UID=12_D1_123; SEID=s"), "D1");
  assert.equal(cookieSsoent("CID=c;UID=12_R2_123;SEID=s"), "R2");
  assert.equal(cookieSsoent("CID=c;  UID=12_F1_123 ;SEID=s"), "F1");
  // 开发者工具的 cookie 表格复制出来是换行 / 制表符分开的
  assert.equal(cookieSsoent("CID=c\nUID=12_A1_123\nSEID=s"), "A1");
  assert.equal(cookieSsoent("CID\tc\tUID=12_A1_123\tSEID=s"), "A1");
});

test("cookieSsoent：没有 UID、形状不对、名字只是以 UID 结尾的都回 null", () => {
  assert.equal(cookieSsoent("CID=c; SEID=s"), null);
  assert.equal(cookieSsoent("UID=12; CID=c"), null);
  assert.equal(cookieSsoent("UID=12_web_123; CID=c"), null);
  assert.equal(cookieSsoent("XUID=12_A1_123; CID=c"), null);
  assert.equal(cookieSsoent(""), null);
});

test("isWebCookie：只有 A1 算网页版", () => {
  assert.equal(isWebCookie("UID=12_A1_123; CID=c; SEID=s"), true);
  assert.equal(isWebCookie("UID=12_D1_123; CID=c; SEID=s"), false);
  assert.equal(isWebCookie("UID=12_R2_123; CID=c; SEID=s"), false);
  assert.equal(isWebCookie("CID=c; SEID=s"), false);
});

test("cookieFromParts：三个必有字段拼成一串，KID 有才写；缺一个就是没拿到", () => {
  assert.equal(cookieFromParts({ UID: "12_R2_123", CID: "c", SEID: "s", KID: "k" }), "UID=12_R2_123; CID=c; SEID=s; KID=k");
  assert.equal(cookieFromParts({ UID: "12_R2_123", CID: "c", SEID: "s" }), "UID=12_R2_123; CID=c; SEID=s");
  assert.equal(cookieFromParts({ UID: "12_R2_123", CID: "c", SEID: "", KID: "k" }), null);
  assert.equal(cookieFromParts({ UID: "12_R2_123", CID: "c" }), null);
  assert.equal(cookieFromParts(null), null);
  assert.equal(cookieFromParts("UID=12_R2_123" as unknown as Record<string, unknown>), null);
});
