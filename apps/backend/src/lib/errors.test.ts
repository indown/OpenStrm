/**
 * isAbortError 要认得中止的三种样子：signal.throwIfAborted() 的 DOMException、
 * timers/promises 的 AbortError、axios 的 CanceledError；普通错误、PermanentError、超时不算。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/lib/errors.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AxiosError, CanceledError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import axios from "axios";
import { isAbortError, isTimeoutError, networkErrorText, PermanentError } from "./errors.js";

test("throwIfAborted 的 DOMException、timers/promises 的 AbortError、axios 的 CanceledError 都算中止", async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(isAbortError(ac.signal.reason), true, "DOMException AbortError");
  const fromSleep = await sleep(1000, undefined, { signal: ac.signal }).then(() => null, (e: unknown) => e);
  assert.equal(isAbortError(fromSleep), true, "timers/promises 的 AbortError");
  assert.equal(isAbortError(new CanceledError("canceled")), true, "axios CanceledError");
});

test("普通错误、PermanentError、axios 超时不算中止", () => {
  assert.equal(isAbortError(new Error("boom")), false);
  assert.equal(isAbortError(new PermanentError("not found")), false);
  assert.equal(isAbortError(new AxiosError("timeout of 30000ms exceeded", "ECONNABORTED")), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError("AbortError"), false);
});

test("networkErrorText：超时说几秒没回应、连不上说连不上，原话留在括号里；接口回了话的、不是网络层的回 null", () => {
  const config = { timeout: 30_000, headers: {} } as InternalAxiosRequestConfig;
  const timeout = new AxiosError("timeout of 30000ms exceeded", "ECONNABORTED", config);
  assert.equal(networkErrorText(timeout), "网盘接口 30 秒没有回应，稍后再试（timeout of 30000ms exceeded）");
  assert.equal(networkErrorText(new AxiosError("connect ETIMEDOUT 1.2.3.4:443", "ETIMEDOUT")), "网盘接口没有回应，稍后再试（connect ETIMEDOUT 1.2.3.4:443）", "不知道超时设了多久就不说秒数");
  assert.equal(networkErrorText(new AxiosError("socket hang up", "ECONNRESET")), "连不上网盘接口（ECONNRESET），稍后再试");
  // 系统自己会再试的地方只要原因本身：不叫人「稍后再试」，也不带英文原话
  assert.equal(networkErrorText(timeout, { brief: true }), "网盘接口 30 秒没有回应");
  assert.equal(networkErrorText(new AxiosError("socket hang up", "ECONNRESET"), { brief: true }), "连不上网盘接口（ECONNRESET）");
  const res = { status: 500, statusText: "", headers: {}, config, data: "" } as AxiosResponse;
  assert.equal(networkErrorText(new AxiosError("Request failed with status code 500", "ERR_BAD_RESPONSE", config, null, res)), null, "接口回了话：不是网络层的事");
  assert.equal(networkErrorText(new CanceledError("canceled")), null, "自己掐的不算");
  assert.equal(networkErrorText(new Error("timeout")), null, "不是 axios 的错误不猜");
});

test("isTimeoutError：超时码、只在文案里说 timeout 的都算；回了话的、被取消的、连不上的不算", () => {
  const mk = (over: Record<string, unknown>) => Object.assign(new axios.AxiosError("x"), over);
  assert.equal(isTimeoutError(mk({ code: "ECONNABORTED", message: "timeout of 30000ms exceeded" })), true);
  assert.equal(isTimeoutError(mk({ code: "ETIMEDOUT" })), true);
  assert.equal(isTimeoutError(mk({ code: "ERR_BAD_RESPONSE", message: "request timeout" })), true);
  assert.equal(isTimeoutError(mk({ code: "ECONNREFUSED" })), false);
  assert.equal(isTimeoutError(mk({ code: "ECONNABORTED", response: { status: 500 } })), false);
  assert.equal(isTimeoutError(new axios.CanceledError("canceled")), false);
  assert.equal(isTimeoutError(new Error("timeout")), false);
});
