/**
 * CloudDrive2 客户端对着假 gRPC 服务（test/fake-cd2.ts）：换令牌和缓存、API 令牌直接用、UNAUTHENTICATED 重登一次、
 * forceRefresh 真发出去、流里多帧合着数、NOT_FOUND 归 missing、连不上归 transport、地址补协议。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/cd2/client.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { FakeCd2 } from "../../test/fake-cd2.js";
import { __test_resetCd2Tokens, Cd2Error, cd2CopyFiles, cd2CopyTasks, cd2EnsureDir, cd2ListDir, cd2ListEntries, cd2RefreshDir, cd2SystemInfo, cd2Token, isCd2Missing, normalizeCd2Url } from "./client.js";

const fake = new FakeCd2();
let url = "";

before(async () => {
  url = await fake.start();
});
beforeEach(() => {
  fake.reset();
  fake.tree = { "/": ["115/"], "/115": ["movie/", "tv/"], "/115/movie": ["A (2013)/", "B (2020)/", "loose.mkv"] };
  __test_resetCd2Tokens();
});
after(async () => {
  await fake.stop();
});

test("GetSystemInfo 不要鉴权：地址通不通、CD2 自己登没登录", async () => {
  const info = await cd2SystemInfo({ url: url.replace("http://", "") });
  assert.deepEqual(info, { loggedIn: true, userName: "u***@example.com", systemReady: true, message: undefined });
  assert.equal(fake.calls[0]?.authorization, undefined);
  assert.equal(normalizeCd2Url("127.0.0.1:19798/"), "http://127.0.0.1:19798", "没写协议按 http、去尾斜杠");
});

test("用户名口令换 JWT：第一次 GetToken，之后复用缓存；success=false 当登录失败", async () => {
  const conn = { url, username: "admin", password: "pw" };
  assert.equal(await cd2Token(conn), "jwt-1");
  assert.equal(await cd2Token(conn), "jwt-1");
  assert.equal(await cd2ListDir(conn, "/115"), 2);
  assert.deepEqual(fake.calls.map((c) => c.method), ["GetToken", "GetSubFiles"]);
  assert.equal(fake.calls[1]?.authorization, "Bearer jwt-1");
  await assert.rejects(cd2Token({ url, username: "admin", password: "wrong" }), (err: unknown) => err instanceof Cd2Error && /用户名或密码不对/.test(err.message) && err.code === 16);
});

test("API 令牌直接带，不调 GetToken；令牌不对就是 UNAUTHENTICATED，不重试", async () => {
  assert.equal(await cd2ListDir({ url, apiToken: "api-token" }, "/115"), 2);
  assert.deepEqual(fake.calls.map((c) => [c.method, c.authorization]), [["GetSubFiles", "Bearer api-token"]]);
  fake.calls.length = 0;
  await assert.rejects(cd2ListDir({ url, apiToken: "bad" }, "/115"), (err: unknown) => err instanceof Cd2Error && err.code === 16 && !err.transport);
  assert.deepEqual(fake.calls.map((c) => c.method), ["GetSubFiles"], "API 令牌失效不会去换令牌");
});

test("JWT 失效：UNAUTHENTICATED 时清缓存重登一次再试", async () => {
  const conn = { url, username: "admin", password: "pw" };
  assert.equal(await cd2ListDir(conn, "/115"), 2);
  fake.tokens.delete("jwt-1");
  fake.calls.length = 0;
  assert.equal(await cd2ListDir(conn, "/115"), 2);
  assert.deepEqual(fake.calls.map((c) => [c.method, c.authorization]), [["GetSubFiles", "Bearer jwt-1"], ["GetToken", undefined], ["GetSubFiles", "Bearer jwt-2"]]);
});

test("刷新目录：forceRefresh=true 发出去，流里多帧的条目合着数；检查用的列目录不带 forceRefresh", async () => {
  const conn = { url, apiToken: "api-token" };
  fake.chunk = 2;
  assert.equal(await cd2RefreshDir(conn, "/115/movie"), 3, "两帧：2 + 1");
  assert.equal(await cd2ListDir(conn, "/115/movie"), 3);
  assert.deepEqual(fake.calls.map((c) => [c.path, c.forceRefresh]), [["/115/movie", true], ["/115/movie", false]]);
});

test("目录不存在是 NOT_FOUND → missing；连不上是 transport；地址不像样直接报", async () => {
  const conn = { url, apiToken: "api-token" };
  await assert.rejects(cd2RefreshDir(conn, "/115/nope"), (err: unknown) => err instanceof Cd2Error && err.code === 5 && isCd2Missing(err) && !err.transport);
  await assert.rejects(cd2SystemInfo({ url: "http://127.0.0.1:1" }), (err: unknown) => err instanceof Cd2Error && err.transport && !isCd2Missing(err) && /连不上 http:\/\/127\.0\.0\.1:1：连接被拒绝/.test(err.message));
});

test("复制引擎要的四个接口：列条目带类型和大小；逐级建目录（已存在的吞掉）；CopyFile 的请求形状和 success=false；GetCopyTasks 解码", async () => {
  const conn = { url, apiToken: "api-token" };
  fake.tree["/hdd"] = [];
  assert.deepEqual(await cd2ListEntries(conn, "/115/movie", { refresh: true }), [{ name: "A (2013)", isDir: true }, { name: "B (2020)", isDir: true }, { name: "loose.mkv", isDir: false, size: 1234 }]);
  assert.equal(fake.calls.at(-1)?.forceRefresh, true, "引擎列目录要绕过 CD2 的缓存");
  await cd2ListEntries(conn, "/115/movie");
  assert.equal(fake.calls.at(-1)?.forceRefresh, false, "浏览目录默认不刷，走 CD2 的缓存");

  await cd2EnsureDir(conn, "/hdd/media/tv");
  assert.deepEqual(fake.tree["/hdd/media"], ["tv/"]);
  assert.deepEqual(fake.tree["/hdd/media/tv"], []);
  await cd2EnsureDir(conn, "/hdd/media/tv");
  assert.deepEqual(fake.tree["/hdd/media"], ["tv/"], "已经有的不重复建、不报错");
  await assert.rejects(cd2EnsureDir(conn, "/nope/x"), (err: unknown) => err instanceof Cd2Error && /does not exist/.test(err.message), "父目录不在：CD2 回 success=false 带 does not exist，不能当「已存在」吞掉");

  await cd2CopyFiles(conn, ["/115/movie/loose.mkv", "/115/movie/A (2013)"], "/hdd/media/tv");
  assert.deepEqual(fake.copyRequests, [{ sources: ["/115/movie/loose.mkv", "/115/movie/A (2013)"], dest: "/hdd/media/tv" }]);
  let tasks = await cd2CopyTasks(conn);
  assert.deepEqual(tasks.map((t) => [t.sourcePath, t.destPath, t.status, t.totalFiles, t.uploadedFiles, t.endedAt]), [
    ["/115/movie/loose.mkv", "/hdd/media/tv", "pending", 1, 0, null],
    ["/115/movie/A (2013)", "/hdd/media/tv", "pending", 1, 0, null],
  ]);
  fake.failSources.set("/115/movie/A (2013)", "quota exceeded");
  fake.advanceCopies();
  tasks = await cd2CopyTasks(conn);
  assert.deepEqual(tasks.map((t) => [t.status, t.uploadedFiles, t.failedFiles, t.errors, typeof t.endedAt]), [["completed", 1, 0, [], "number"], ["failed", 0, 1, ["quota exceeded"], "number"]]);
  assert.deepEqual(fake.tree["/hdd/media/tv"], ["loose.mkv"]);

  fake.failNextCopy = "disk full";
  await assert.rejects(cd2CopyFiles(conn, ["/115/movie/loose.mkv"], "/hdd/media"), (err: unknown) => err instanceof Cd2Error && /disk full/.test(err.message) && !err.transport);
});

test("老版本 CD2 只有 fileType：目录（0，proto3 不发）仍认成目录", async () => {
  const conn = { url, apiToken: "api-token" };
  fake.legacyFileType = true;
  assert.deepEqual((await cd2ListEntries(conn, "/115/movie")).map((e) => [e.name, e.isDir]), [["A (2013)", true], ["B (2020)", true], ["loose.mkv", false]]);
});

test("服务端只回首部就把流关掉（没有 end / trailer）：马上按连接错误报，不等到超时", async () => {
  fake.closeWithoutEnd = true;
  const started = Date.now();
  // 流先 end 再 close 的话报「没有返回状态」，只 close 的话报「被对方关掉」：都是连接层的错，都得马上报
  await assert.rejects(cd2SystemInfo({ url }), (err: unknown) => err instanceof Cd2Error && err.transport && /关掉|没有返回状态/.test(err.message));
  assert.ok(Date.now() - started < 5000, "没有等 30 秒超时");
});
