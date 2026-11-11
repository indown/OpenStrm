/**
 * 凭据形状检查：只有 115 的网页版 cookie 会被拦。夹具用短 UID，避开 check-hygiene 的凭据形状。
 * 凭据齐不齐：四种账号各缺什么。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/drive/credentials.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialProblem, missingCredentials } from "./credentials.js";

test("credentialProblem：115 的 A1 cookie 报 WEB_COOKIE，别的端、别的网盘、没有 UID 的都放过", () => {
  assert.equal(credentialProblem("115", "UID=12_A1_123; CID=c; SEID=s")?.code, "WEB_COOKIE");
  assert.equal(credentialProblem("115", "UID=12_D1_123; CID=c; SEID=s"), null);
  assert.equal(credentialProblem("115", "CID=c; SEID=s"), null);
  assert.equal(credentialProblem("quark", "UID=12_A1_123; __puus=x"), null);
  assert.equal(credentialProblem("openlist", undefined), null);
  assert.equal(credentialProblem("115", 123), null);
});

test("missingCredentials：四种账号各缺什么；没带 accountType（只改备注之类）不查", () => {
  assert.match(missingCredentials({ accountType: "115", name: "a" }) ?? "", /cookie/);
  assert.equal(missingCredentials({ accountType: "115", name: "a", cookie: "c" }), null);
  assert.match(missingCredentials({ accountType: "quark", name: "a" }) ?? "", /cookie/);
  assert.match(missingCredentials({ accountType: "openlist", name: "a", account: "u", password: "p" }) ?? "", /url/);
  assert.equal(missingCredentials({ accountType: "openlist", name: "a", account: "u", password: "p", url: "http://ol" }), null);

  assert.match(missingCredentials({ accountType: "cd2", name: "a", apiToken: "t" }) ?? "", /地址/);
  assert.match(missingCredentials({ accountType: "cd2", name: "a", url: "  ", apiToken: "t" }) ?? "", /地址/);
  assert.match(missingCredentials({ accountType: "cd2", name: "a", url: "http://cd2:19798/x/y", apiToken: "t" }) ?? "", /不像个地址/);
  assert.match(missingCredentials({ accountType: "cd2", name: "a", url: "cd2:19798" }) ?? "", /令牌/);
  assert.match(missingCredentials({ accountType: "cd2", name: "a", url: "cd2:19798", username: "u" }) ?? "", /令牌/, "只有用户名、没有口令不算一组");
  assert.equal(missingCredentials({ accountType: "cd2", name: "a", url: "cd2:19798", apiToken: "t" }), null);
  assert.equal(missingCredentials({ accountType: "cd2", name: "a", url: "https://cd2.example.com/", username: "u", password: "p" }), null);

  assert.equal(missingCredentials({ name: "a", note: "x" }), null);
});
