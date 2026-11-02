/**
 * 115 扫码登录对着本地假 115 跑：四步接口的路径 / 参数、状态流转、过期与取消、壳子错误、并发合并、会话过期、cookie 只交一次。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/cloud-115/qrcode.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { HttpError } from "../../lib/http-error.js";
import { startFake115Qrcode, type Fake115Qrcode } from "../../test/fake-115-qrcode.js";
import {
  QRCODE_CONFIRMED_KEEP_MS,
  QRCODE_MAX_SESSIONS,
  QRCODE_SESSION_TTL_MS,
  pollQrcodeLogin,
  resetQrcodeSessions,
  setQrcodeApiBase,
  setQrcodeStatusTimeoutMs,
  startQrcodeLogin,
} from "./qrcode.js";

let fake: Fake115Qrcode;

before(async () => {
  // 每问一次往前推一档：0 → 1 → 2
  fake = await startFake115Qrcode({ advanceEvery: 1 });
  setQrcodeApiBase(fake.base);
});

after(async () => {
  setQrcodeApiBase(null);
  await fake.close();
});

beforeEach(() => {
  fake.reset();
  resetQrcodeSessions();
});

async function rejects(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HttpError, `抛的不是 HttpError：${String(err)}`);
    return err;
  }
  assert.fail("没有抛错");
}

test("start：token 和图两步路径里带选的端，图内联成 data URL，uid / 到期时间回给界面", async () => {
  const now = 1_800_000_000_000;
  const s = await startQrcodeLogin("alipaymini", now);
  assert.equal(s.uid, "fake-uid-1");
  assert.equal(s.expiresAt, now + QRCODE_SESSION_TTL_MS);
  assert.match(s.image, /^data:image\/png;base64,/);
  const png = Buffer.from(s.image.slice("data:image/png;base64,".length), "base64");
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "图是 PNG");
  assert.deepEqual(
    fake.calls.map((c) => [c.method, c.path, c.app]),
    [
      ["GET", "/api/1.0/alipaymini/1.0/token/", "alipaymini"],
      ["GET", "/api/1.0/alipaymini/1.0/qrcode", "alipaymini"],
    ],
  );
  assert.equal(fake.calls[1].query.uid, "fake-uid-1");
});

test("状态流转：等扫 → 已扫 → 确认后换 cookie；换完再问还是同一份（不再问 115），两分钟后才清", async () => {
  const { uid } = await startQrcodeLogin("alipaymini");
  assert.deepEqual(await pollQrcodeLogin(uid), { status: "waiting" });
  assert.deepEqual(await pollQrcodeLogin(uid), { status: "scanned" });
  const done = await pollQrcodeLogin(uid);
  assert.deepEqual(done, {
    status: "confirmed",
    cookie: "UID=12_R2_123; CID=cid-alipaymini; SEID=seid-alipaymini; KID=kid-alipaymini",
    userName: "fake user",
  });

  const statusCalls = fake.calls.filter((c) => c.path === "/get/status/");
  assert.equal(statusCalls.length, 3);
  assert.equal(statusCalls[0].query.uid, uid);
  assert.equal(statusCalls[0].query.time, "1700000001");
  assert.equal(statusCalls[0].query.sign, "sign-1");
  assert.match(statusCalls[0].query._, /^\d{13}$/, "带毫秒时间戳防缓存");

  const login = fake.calls.find((c) => c.path.startsWith("/app/1.0/"));
  assert.ok(login);
  assert.equal(login.method, "POST");
  assert.equal(login.path, "/app/1.0/alipaymini/1.0/login/qrcode/");
  assert.equal(login.body, `app=alipaymini&account=${uid}`);

  // 交出去的那次响应可能没送到：再问还能拿到，而且不再碰 115
  const calls = fake.calls.length;
  assert.deepEqual(await pollQrcodeLogin(uid), done);
  assert.equal(fake.calls.length, calls);
  const gone = await rejects(pollQrcodeLogin(uid, Date.now() + QRCODE_CONFIRMED_KEEP_MS + 1));
  assert.equal(gone.status, 404);
  assert.equal(gone.extra.code, "QRCODE_GONE");
});

test("同时最多留几个会话：超过就淘汰最早生成的，狂点刷新不会越积越多", async () => {
  const first = await startQrcodeLogin("alipaymini");
  for (let i = 0; i < QRCODE_MAX_SESSIONS; i++) await startQrcodeLogin("alipaymini");
  assert.equal((await rejects(pollQrcodeLogin(first.uid))).status, 404);
  const last = fake.calls.filter((c) => c.path.endsWith("/token/")).length;
  assert.equal(last, QRCODE_MAX_SESSIONS + 1, "每次 start 还是会去 115 拿一次码");
});

test("选了安卓端，换 cookie 走安卓端的路径，拿到的 UID 中段是 F1", async () => {
  const { uid } = await startQrcodeLogin("android");
  fake.statusQueue = [2];
  const done = await pollQrcodeLogin(uid);
  assert.equal(done.status, "confirmed");
  assert.ok(done.status === "confirmed" && done.cookie.startsWith("UID=12_F1_123; "));
  assert.equal(fake.calls.at(-1)?.path, "/app/1.0/android/1.0/login/qrcode/");
});

test("KID 缺了不写；UID / CID / SEID 缺一个算没拿到，会话留着下次还能再换", async () => {
  const { uid } = await startQrcodeLogin("tv");
  fake.statusQueue = [2, 2];
  fake.loginResponse = { state: 1, code: 0, message: "", data: { cookie: { UID: "12_I1_123", CID: "c", SEID: "" } } };
  const err = await rejects(pollQrcodeLogin(uid));
  assert.equal(err.status, 500);
  assert.match(err.message, /没有返回完整的 cookie/);

  fake.loginResponse = { state: 1, code: 0, message: "", data: { cookie: { UID: "12_I1_123", CID: "c", SEID: "s" } } };
  assert.deepEqual(await pollQrcodeLogin(uid), { status: "confirmed", cookie: "UID=12_I1_123; CID=c; SEID=s" });
});

test("115 回 -1 / -2：过期、取消，会话作废", async () => {
  const a = await startQrcodeLogin("alipaymini");
  fake.statusQueue = [-1];
  assert.deepEqual(await pollQrcodeLogin(a.uid), { status: "expired" });
  assert.equal((await rejects(pollQrcodeLogin(a.uid))).status, 404);

  const b = await startQrcodeLogin("alipaymini");
  fake.statusQueue = [-2];
  assert.deepEqual(await pollQrcodeLogin(b.uid), { status: "cancelled" });
  assert.equal((await rejects(pollQrcodeLogin(b.uid))).status, 404);
});

test("壳子 state 为假：文案里说过期 / 取消的按结局算，别的原话带出去", async () => {
  const a = await startQrcodeLogin("alipaymini");
  fake.statusQueue = [{ state: 0, code: 40199002, message: "二维码已过期", data: {} }];
  assert.deepEqual(await pollQrcodeLogin(a.uid), { status: "expired" });

  const b = await startQrcodeLogin("alipaymini");
  fake.statusQueue = [{ state: 0, code: 40199001, message: "操作太频繁", data: {} }];
  const err = await rejects(pollQrcodeLogin(b.uid));
  assert.equal(err.status, 500);
  assert.equal(err.message, "115：操作太频繁");
  assert.equal(err.extra.code, 40199001);
  // 没说过期也没说取消，会话还在
  fake.statusQueue = [1];
  assert.deepEqual(await pollQrcodeLogin(b.uid), { status: "scanned" });
});

test("认不出的状态值当上游出错，带上原样数据", async () => {
  const { uid } = await startQrcodeLogin("alipaymini");
  fake.statusQueue = [7];
  const err = await rejects(pollQrcodeLogin(uid));
  assert.equal(err.status, 500);
  assert.match(err.message, /认不出的状态/);
});

test("换 cookie 回「IP登录异常」：原话带出去并提醒会封到第二天", async () => {
  const { uid } = await startQrcodeLogin("alipaymini");
  fake.statusQueue = [2];
  fake.loginResponse = { state: 0, code: 40101032, message: "IP登录异常,请稍候再登录", data: null };
  const err = await rejects(pollQrcodeLogin(uid));
  assert.equal(err.status, 500);
  assert.equal(err.message, "115：IP登录异常,请稍候再登录（115 会封到第二天零点，别反复试）");
});

test("并发查同一个二维码只往 115 发一次，两边拿到同一个结果", async () => {
  const { uid } = await startQrcodeLogin("alipaymini");
  const [x, y] = await Promise.all([pollQrcodeLogin(uid), pollQrcodeLogin(uid)]);
  assert.deepEqual(x, { status: "waiting" });
  assert.deepEqual(y, { status: "waiting" });
  assert.equal(fake.statusHits, 1);
  // 上一次回来之后再问才会再发
  assert.deepEqual(await pollQrcodeLogin(uid), { status: "scanned" });
  assert.equal(fake.statusHits, 2);
});

test("会话十分钟作废：到期后查是 404，新生成一个时顺手把过期的清掉", async () => {
  const now = 1_800_000_000_000;
  const a = await startQrcodeLogin("alipaymini", now);
  assert.equal((await rejects(pollQrcodeLogin(a.uid, now + QRCODE_SESSION_TTL_MS + 1))).status, 404);
  const b = await startQrcodeLogin("alipaymini", now);
  await startQrcodeLogin("alipaymini", now + QRCODE_SESSION_TTL_MS + 1);
  assert.equal((await rejects(pollQrcodeLogin(b.uid, now))).status, 404, "被 prune 掉了");
});

test("二维码接口 HTTP 500 / 数据不完整 → 上游错误，带状态码或原因", async () => {
  fake.failPath = "/api/1.0/alipaymini/1.0/token/";
  const err = await rejects(startQrcodeLogin("alipaymini"));
  assert.equal(err.status, 500);
  assert.match(err.message, /二维码接口返回 500/);
  assert.equal(err.extra.upstreamStatus, 500);

  fake.failPath = null;
  fake.tokenResponse = { state: 1, code: 0, message: "", data: { uid: "x" } };
  assert.match((await rejects(startQrcodeLogin("alipaymini"))).message, /数据不完整/);

  fake.tokenResponse = { state: 0, code: 99, message: "系统繁忙" };
  assert.equal((await rejects(startQrcodeLogin("alipaymini"))).message, "115：系统繁忙");
});

test("115 把查状态挂到超时（长轮询没变化）：不算错，回上一次的状态，会话还在", async () => {
  setQrcodeStatusTimeoutMs(150);
  try {
    const { uid } = await startQrcodeLogin("alipaymini");
    fake.hangStatusMs = 600;
    assert.deepEqual(await pollQrcodeLogin(uid), { status: "waiting" });
    fake.hangStatusMs = 0;
    fake.statusQueue = [1];
    assert.deepEqual(await pollQrcodeLogin(uid), { status: "scanned" });
    fake.hangStatusMs = 600;
    assert.deepEqual(await pollQrcodeLogin(uid), { status: "scanned" }, "挂住时回的是上一次问到的状态");
    fake.hangStatusMs = 0;
    fake.statusQueue = [2];
    assert.equal((await pollQrcodeLogin(uid)).status, "confirmed");
  } finally {
    setQrcodeStatusTimeoutMs(null);
  }
});

test("连不上才算错：指到没人听的端口 → 上游错误说连不上", async () => {
  const { uid } = await startQrcodeLogin("alipaymini");
  setQrcodeApiBase("http://127.0.0.1:1");
  try {
    const err = await rejects(pollQrcodeLogin(uid));
    assert.equal(err.status, 500);
    assert.match(err.message, /连不上网盘接口/);
  } finally {
    setQrcodeApiBase(fake.base);
  }
});
