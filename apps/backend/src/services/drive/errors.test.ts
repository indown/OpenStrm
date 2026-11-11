/**
 * 网盘错误里的事实和账号问题的统一判断：登录码 / 风控按接口回来的错误认，
 * 我们自己拼的错误里带用户的路径，路径里的「405」「cookie」不能把整轮当成风控。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxiosError } from "axios";
import { PermanentError } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { Cd2Error } from "../cd2/client.js";
import { Cloud115ApiError, Cloud115Error, ShareBusyError } from "../cloud-115/client.js";
import { ShareApiError } from "../cloud-115/share.js";
import { OpenlistError } from "../openlist/client.js";
import { QuarkError } from "../quark/client.js";
import { accountIssueOf, classifyAccountIssue, driveErrorFacts, driveErrorToHttp } from "./errors.js";
import { Cd2Provider } from "./providers/cd2.js";
import { Cloud115Provider } from "./providers/cloud115.js";
import { ShareGoneError } from "./types.js";

const p115 = new Cloud115Provider({ accountType: "115", name: "a", cookie: "c" });
const pCd2 = new Cd2Provider({ accountType: "cd2", name: "c", url: "http://127.0.0.1:1", apiToken: "t" });

test("driveErrorFacts：三家的错误类和 axios 的响应算接口错误，普通 Error / PermanentError 不算；包着网盘错误的 PermanentError 看 cause", () => {
  assert.equal(driveErrorFacts(new Error("x")).api, false);
  assert.equal(driveErrorFacts(new PermanentError("File not found")).api, false);
  assert.deepEqual(driveErrorFacts(new Cloud115ApiError("115：登录超时（errno 990001）", 990001)), { transport: false, taskFailed: false, authCode: true, api: true });
  const wrapped = new PermanentError("Failed to get file info: unauthorized", { cause: new OpenlistError("unauthorized", 401) });
  assert.equal(driveErrorFacts(wrapped).authCode, true);
  assert.equal(driveErrorFacts(wrapped).status, 401);
  assert.equal(driveErrorFacts(new AxiosError("socket hang up", "ECONNRESET")).api, false, "连不上没有响应，文案也没得看");
  assert.equal(driveErrorFacts(new AxiosError("Request failed with status code 404", "ERR_BAD_REQUEST", undefined, undefined, { status: 404 } as never)).api, true);
});

test("accountIssueOf：路径里带 405 / cookie 的普通错误和 PermanentError 不算账号问题；接口回来的按码和文案认", () => {
  const idle = new Error("下载 /tv/Room 405/cookie.mkv：120 秒内没有收到数据");
  const missing = new PermanentError("File not found: x.mkv in directory: /电影/1405年. Available files: a");
  for (const provider of [undefined, p115]) {
    assert.equal(accountIssueOf(provider, idle), null);
    assert.equal(accountIssueOf(provider, missing), null);
    assert.equal(accountIssueOf(provider, new Cloud115ApiError("115：登录超时，请重新登录。（errno 990001）", 990001)), "auth");
    assert.equal(accountIssueOf(provider, new Cloud115ApiError("115：cookie 已失效", undefined)), "auth", "接口回来的文案可以猜");
    assert.equal(accountIssueOf(provider, new Cloud115Error(405, "<!doctypehtml>", "https://webapi.115.com/files")), "blocked");
    assert.equal(accountIssueOf(provider, new Cloud115Error(404, "not found")), null);
  }
  assert.equal(accountIssueOf(undefined, new PermanentError("Failed to get file info: unauthorized", { cause: new OpenlistError("unauthorized", 401) })), "auth", "OpenList 包在 PermanentError 里的 401");
  assert.equal(accountIssueOf(undefined, new QuarkError("require login", 401, 31001)), "auth");
  assert.equal(p115.classifyError(new Error("cookie 405")), null, "115 的 classifyError 只看接口层的错误");
  assert.equal(p115.classifyError(new Cloud115ApiError("115：登录超时，请重新登录。", 990001)), "auth");
  assert.equal(classifyAccountIssue("115 接口返回 405: 您的访问被阻断"), "blocked");
});

test("115 分享接口一时回不了话（太频繁、繁忙）：不是分享没了——不回 SHARE_GONE，追更也不当失效停掉", () => {
  const busy = new ShareBusyError("操作过于频繁，请稍后再试", 911);
  const http = driveErrorToHttp(busy, "失败");
  assert.ok(http instanceof HttpError);
  assert.equal(http.extra.code, "SHARE_BUSY", "资源搜索页只按 SHARE_GONE 标失效");
  assert.equal(http.extra.reason, undefined);
  assert.match(http.message, /暂时打不开：操作过于频繁/);
  assert.equal(p115.classifyError(busy), null, "追更按 gone 才停：这种只是这一轮没连上");
  assert.equal(accountIssueOf(p115, busy), null);
  // 说着频繁、其实是登录失效的照样认成账号问题
  assert.equal(p115.classifyError(new ShareBusyError("登录超时，请稍后重新登录", 990001)), "auth");
  // 真没了、提取码不对的照旧
  const gone = driveErrorToHttp(new ShareGoneError("分享已取消", 4100010), "失败");
  assert.equal(gone.extra.code, "SHARE_GONE");
  assert.equal(gone.extra.reason, "gone");
  assert.equal(driveErrorToHttp(new ShareGoneError("访问码错误", 4100012), "失败").extra.reason, "password");
  assert.equal(p115.classifyError(new ShareApiError("分享已取消", 4100010)), "gone");
});

test("driveErrorToHttp：网盘接口超时、连不上换成人话，前面带上是哪一步；原话留在括号里", () => {
  const timeout = new AxiosError("timeout of 30000ms exceeded", "ECONNABORTED", { timeout: 30_000, headers: {} } as never);
  const http = driveErrorToHttp(timeout, "发起复制失败");
  assert.ok(http instanceof HttpError);
  assert.equal(http.message, "发起复制失败：网盘接口 30 秒没有回应，稍后再试（timeout of 30000ms exceeded）");
  assert.equal(http.cause, timeout, "原始错误还挂在 cause 上");
  assert.equal(driveErrorToHttp(new AxiosError("socket hang up", "ECONNRESET"), "转存失败").message, "转存失败：连不上网盘接口（ECONNRESET），稍后再试");
  assert.equal(driveErrorToHttp(new Error("别的错误"), "转存失败").message, "别的错误", "不是网络层的照旧");
});

test("Cd2Error 的事实：没有这个路径给 404、连不上 / UNAVAILABLE / DEADLINE_EXCEEDED 值得重试、UNAUTHENTICATED 是登录码；gRPC 码不当 HTTP 状态", () => {
  const facts = (err: unknown) => driveErrorFacts(err);
  assert.deepEqual(facts(new Cd2Error('CD2 GetSubFiles 失败：find by path: "/115/tv" not found under "/115"', 5)), { status: 404, transport: false, taskFailed: false, authCode: false, api: false });
  assert.equal(facts(new Cd2Error("CD2 DeleteFile 失败：file not found: /115/x.mkv")).status, 404, "success=false 带着「没有」的文案也算");
  assert.deepEqual(facts(new Cd2Error("CD2 GetSubFiles 失败：连不上 http://x：连接被拒绝", undefined, true)), { transport: true, taskFailed: false, authCode: false, api: false });
  assert.equal(facts(new Cd2Error("CD2 GetSubFiles 失败：upstream unavailable", 14)).transport, true);
  assert.equal(facts(new Cd2Error("CD2 GetSubFiles 失败：deadline exceeded", 4)).transport, true);
  assert.deepEqual(facts(new Cd2Error("CD2 GetSubFiles 失败：Unauthenticated", 16)), { transport: false, taskFailed: false, authCode: true, api: false });
  assert.deepEqual(facts(new Cd2Error("CD2 MoveFile 失败：internal error", 13)), { transport: false, taskFailed: false, authCode: false, api: false }, "13 不是 HTTP 的 5xx，也不是 429");
  assert.equal(facts(new Cd2Error("CD2 RenameFile 失败：file already exists")).status, undefined);
});

test("CD2 的账号问题只按 gRPC 码认：令牌失效、缺权限算；文案里带着路径，路径里的 405 / cookie 不算", () => {
  assert.equal(accountIssueOf(pCd2, new Cd2Error("CD2 GetSubFiles 失败：Unauthenticated", 16)), "auth");
  assert.equal(accountIssueOf(undefined, new Cd2Error("CD2 GetSubFiles 失败：Unauthenticated", 16)), "auth", "没给 provider 也认得出登录码");
  assert.equal(accountIssueOf(pCd2, new Cd2Error("CD2 MoveFile 失败：move permission required", 7)), "auth");
  assert.equal(accountIssueOf(pCd2, new Cd2Error('CD2 GetSubFiles 失败：find by path: "/115/Room 405/cookie" not found under "/115/Room 405"', 5)), null);
  assert.equal(accountIssueOf(undefined, new Cd2Error("CD2 GetDownloadUrlPath 失败：file not found: /115/请重新登录.mkv", 5)), null);
  const http = driveErrorToHttp(new Cd2Error('CD2 GetSubFiles 失败：find by path: "/115/tv" not found under "/115"', 5), "列目录失败");
  assert.equal(http.status, 500, "上游错误不回 502");
  assert.equal(http.message, 'CD2 GetSubFiles 失败：find by path: "/115/tv" not found under "/115"');
  assert.equal(http.extra.grpcStatus, 5);
  assert.equal(driveErrorToHttp(new Cd2Error("CD2 GetSubFiles 失败：连不上", undefined, true), "列目录失败").extra.grpcStatus, undefined);
});
