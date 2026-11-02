/**
 * 凭据形状检查：只有 115 的网页版 cookie 会被拦。夹具用短 UID，避开 check-hygiene 的凭据形状。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/drive/credentials.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialProblem } from "./credentials.js";

test("credentialProblem：115 的 A1 cookie 报 WEB_COOKIE，别的端、别的网盘、没有 UID 的都放过", () => {
  assert.equal(credentialProblem("115", "UID=12_A1_123; CID=c; SEID=s")?.code, "WEB_COOKIE");
  assert.equal(credentialProblem("115", "UID=12_D1_123; CID=c; SEID=s"), null);
  assert.equal(credentialProblem("115", "CID=c; SEID=s"), null);
  assert.equal(credentialProblem("quark", "UID=12_A1_123; __puus=x"), null);
  assert.equal(credentialProblem("openlist", undefined), null);
  assert.equal(credentialProblem("115", 123), null);
});
