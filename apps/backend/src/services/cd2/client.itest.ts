/**
 * CloudDrive2 客户端对着假 gRPC 服务（test/fake-cd2.ts）：换令牌和缓存、API 令牌直接用、UNAUTHENTICATED 重登一次、
 * forceRefresh 真发出去、流里多帧合着数、NOT_FOUND 归 missing、连不上归 transport、地址补协议；
 * CD2 账号当网盘用的几个接口：按路径找条目、改名 / 移动 / 删除、下载地址、令牌权限。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/cd2/client.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { FakeCd2 } from "../../test/fake-cd2.js";
import {
  __test_resetCd2Tokens,
  Cd2Error,
  cd2CopyFiles,
  cd2CopyTasks,
  cd2Delete,
  cd2DownloadUrl,
  cd2EnsureDir,
  cd2FindFile,
  cd2ListDir,
  cd2ListEntries,
  cd2Move,
  cd2RefreshDir,
  cd2Rename,
  cd2SystemInfo,
  cd2Token,
  cd2TokenInfo,
  fillDownloadUrl,
  isCd2AlreadyExists,
  isCd2Missing,
  normalizeCd2Url,
} from "./client.js";

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

test("FindFileByPath：找到的带类型、大小、修改时间；找不到回 null；列目录也带修改时间", async () => {
  const conn = { url, apiToken: "api-token" };
  fake.mtimes["/115/movie/loose.mkv"] = 1_700_000_000;
  assert.deepEqual(await cd2FindFile(conn, "/115/movie", "loose.mkv"), { name: "loose.mkv", isDir: false, size: 1234, modifiedAt: 1_700_000_000_000 });
  assert.deepEqual(await cd2FindFile(conn, "/115", "movie"), { name: "movie", isDir: true });
  assert.equal(await cd2FindFile(conn, "/115/movie", "nope.mkv"), null);
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path]), [
    ["FindFileByPath", "/115/movie/loose.mkv"],
    ["FindFileByPath", "/115/movie"],
    ["FindFileByPath", "/115/movie/nope.mkv"],
  ]);
  assert.deepEqual((await cd2ListEntries(conn, "/115/movie")).at(-1), { name: "loose.mkv", isDir: false, size: 1234, modifiedAt: 1_700_000_000_000 });
});

test("改名、移动、删除：目录树真的变了；撞名是 ALREADY_EXISTS、不存在是 NOT_FOUND，都当错误抛；移动撞名被跳过不报错；缺权限是 PERMISSION_DENIED", async () => {
  const conn = { url, apiToken: "api-token" };
  fake.tree["/115/movie/A (2013)"] = ["a.mkv"];
  fake.tree["/115/tv"] = ["loose.mkv"];

  await cd2Rename(conn, "/115/movie/A (2013)", "A (2014)");
  assert.deepEqual(fake.tree["/115/movie/A (2014)"], ["a.mkv"], "目录改名，里面的跟着走");
  assert.equal(fake.tree["/115/movie/A (2013)"], undefined);
  await assert.rejects(
    cd2Rename(conn, "/115/movie/A (2014)", "B (2020)"),
    (err: unknown) => err instanceof Cd2Error && err.code === 6 && /"B \(2020\)" already exists in "\/115\/movie"/.test(err.message) && !err.transport && isCd2AlreadyExists(err),
  );
  await assert.rejects(cd2Rename(conn, "/115/movie/nope", "x"), (err: unknown) => err instanceof Cd2Error && err.code === 5 && isCd2Missing(err));

  // 一次带两个源：目标里已有同名的（loose.mkv）按 Skip 留在原处，另一个照挪，整个调用不报错——哪些挪成了回包里看不出来
  await cd2Move(conn, ["/115/movie/A (2014)", "/115/movie/loose.mkv"], "/115/tv");
  assert.deepEqual(fake.moveRequests, [{ sources: ["/115/movie/A (2014)", "/115/movie/loose.mkv"], dest: "/115/tv", policy: 2 }]);
  assert.deepEqual(fake.tree["/115/tv/A (2014)"], ["a.mkv"]);
  assert.deepEqual(fake.tree["/115/movie"], ["B (2020)/", "loose.mkv"], "被跳过的还在原处");
  await cd2Move(conn, [], "/115/tv");
  assert.equal(fake.moveRequests.length, 1, "空的不发请求");
  await assert.rejects(cd2Move(conn, ["/115/movie/B (2020)"], "/115/nope"), (err: unknown) => err instanceof Cd2Error && err.code === 5 && isCd2Missing(err));
  await assert.rejects(cd2Move(conn, ["/115/movie/没有.mkv"], "/115/tv"), (err: unknown) => isCd2Missing(err));

  await cd2Delete(conn, "/115/movie/loose.mkv");
  assert.deepEqual(fake.tree["/115/movie"], ["B (2020)/"]);
  await assert.rejects(cd2Delete(conn, "/115/movie/loose.mkv"), (err: unknown) => err instanceof Cd2Error && err.code === 5 && isCd2Missing(err));

  fake.deny.add("RenameFile");
  await assert.rejects(cd2Rename(conn, "/115/movie/B (2020)", "C"), (err: unknown) => err instanceof Cd2Error && err.code === 7 && /permission required/.test(err.message));
  assert.deepEqual(fake.tree["/115/movie"], ["B (2020)/"], "被拒的没改动");
});

test("下载地址：占位符换成 CD2 地址的协议、host:port 和 false；有效期带出来；文件不在是 missing", async () => {
  const conn = { url, apiToken: "api-token" };
  fake.tree["/115/movie"].push("带 空格.mkv");
  const host = new URL(url).host;
  // CD2 回的路径整个编码过（斜杠是 %2F），后面带着访问用的查询参数：原样接上，只换占位符
  assert.deepEqual(await cd2DownloadUrl(conn, "/115/movie/带 空格.mkv"), {
    url: `${url}/static/http/${host}/false/${encodeURIComponent("115/movie/带 空格.mkv")}?token=dl-1&cloudname=fake&membership=1`,
  });
  fake.downloadExpiresIn = 600;
  assert.equal((await cd2DownloadUrl(conn, "/115/movie/loose.mkv")).expiresIn, 600);
  await assert.rejects(cd2DownloadUrl(conn, "/115/movie/nope.mkv"), (err: unknown) => isCd2Missing(err));
  await assert.rejects(cd2DownloadUrl(conn, "/115/movie"), (err: unknown) => err instanceof Cd2Error && err.code === 3 && /Cannot download directory/.test(err.message) && !isCd2Missing(err));
  assert.equal(fillDownloadUrl("https://cd2.example.com:8443/", "/static/{SCHEME}/{HOST}/{PREVIEW}/a.mkv?token=t"), "https://cd2.example.com:8443/static/https/cd2.example.com:8443/false/a.mkv?token=t");
  assert.equal(fillDownloadUrl("192.168.1.10:19798", "static/{SCHEME}/{HOST}/{PREVIEW}/a.mkv"), "http://192.168.1.10:19798/static/http/192.168.1.10:19798/false/a.mkv", "没写协议按 http，路径没带头斜杠也接得上");
});

test("GetApiTokenInfo：普通令牌读不了自己的权限表（要「令牌管理」权限）回 null；读得到时带权限、根目录、有效期；用户名口令登录的不问；令牌不对照常报", async () => {
  const conn = { url, apiToken: "api-token" };
  fake.tokenInfo = { rootDir: "/115", friendlyName: "lab", expiresIn: 3600, permissions: [1, 7, 10] };
  assert.equal(await cd2TokenInfo(conn), null, "真 CD2 的默认表现：token management permission required");
  fake.tokenManagement = true;
  assert.deepEqual(await cd2TokenInfo(conn), {
    rootDir: "/115",
    friendlyName: "lab",
    expiresIn: 3600,
    permissions: { list: true, createFolder: false, read: true, rename: false, move: false, copy: true, delete: false, transferTasks: false },
  });
  fake.calls.length = 0;
  assert.equal(await cd2TokenInfo({ url, username: "admin", password: "pw" }), null);
  assert.deepEqual(fake.calls, [], "没有 API 令牌就不问");
  await assert.rejects(cd2TokenInfo({ url, apiToken: "bad" }), (err: unknown) => err instanceof Cd2Error && err.code === 16);
});
