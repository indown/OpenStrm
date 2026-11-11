/**
 * CloudDrive2 Provider 对着假 gRPC 服务（test/fake-cd2.ts）：按路径找、列目录（fresh 才强制刷新）、列子树、下载地址、
 * 五个写操作回的 id（id 就是路径）、移动撞名被跳过要报出来、错误归类。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/drive/providers/cd2.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountCd2 } from "@openstrm/shared";
import { FakeCd2 } from "../../../test/fake-cd2.js";
import { __test_resetCd2Tokens, Cd2Error } from "../../cd2/client.js";
import { resetThrottle } from "../../throttle.js";
import { PartialMoveError, RemoteDirNotFoundError, type DriveProvider } from "../types.js";
import { Cd2Provider } from "./cd2.js";

const fake = new FakeCd2();
let provider: Cd2Provider;
const write = () => provider.write;
const node = (path: string, isDir = false) => ({ id: path, path, isDir });

before(async () => {
  await fake.start();
  provider = new Cd2Provider({ accountType: "cd2", name: "nas-cd2", url: fake.url, apiToken: "api-token" } satisfies AccountCd2);
});
beforeEach(() => {
  fake.reset();
  __test_resetCd2Tokens();
  fake.tree = {
    "/": ["115/", "hdd/"],
    "/115": ["tv/", "空目录/", "待删/"],
    "/115/tv": ["某剧/", "readme.txt"],
    "/115/tv/某剧": ["Season 1 /", "poster.jpg"],
    "/115/tv/某剧/Season 1 ": ["E01.mkv", "E02.mkv"],
    "/115/空目录": ["里面也空/"],
    "/115/空目录/里面也空": [],
    "/115/待删": [],
    "/hdd": [],
  };
  fake.mtimes = { "/115/tv/readme.txt": 1_700_000_000 };
});
after(async () => {
  await fake.stop();
  resetThrottle();
});

test("能力位：能写、没有分享和监控；根是 /，id 就是路径", () => {
  assert.deepEqual(provider.capabilities, { share: false, changes: false, write: true });
  assert.equal(provider.kind, "cd2");
  assert.equal(provider.rootId, "/");
  assert.equal(provider.pathIds, true);
  const asDrive: DriveProvider = provider;
  assert.equal(asDrive.share, undefined);
  assert.equal(asDrive.changes, undefined);
});

test("resolvePath：根不问 CD2；目录、文件各回类型，id 是归一过的路径；没有回 null；段两边的空格不削", async () => {
  assert.deepEqual(await provider.resolvePath("/"), { id: "/", isDir: true });
  assert.deepEqual(await provider.resolvePath(""), { id: "/", isDir: true });
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await provider.resolvePath("115/tv/"), { id: "/115/tv", isDir: true });
  assert.deepEqual(await provider.resolvePath("/115//tv/readme.txt"), { id: "/115/tv/readme.txt", isDir: false });
  assert.deepEqual(await provider.resolvePath("/115/tv/某剧/Season 1 "), { id: "/115/tv/某剧/Season 1 ", isDir: true }, "带尾空格的目录名原样找");
  assert.equal(await provider.resolvePath("/115/tv/没有"), null);
  assert.equal(await provider.resolvePath("/没有这个盘/x"), null, "父目录都不在也是 null，不是报错");
  assert.ok(fake.calls.every((c) => c.method === "FindFileByPath"), "只用 FindFileByPath，不列父目录");
});

test("listDir：默认走 CD2 的缓存，fresh 才强制刷新；条目带 id、类型、大小、修改时间", async () => {
  const entries = await provider.listDir("/115/tv");
  assert.deepEqual(entries, [
    { id: "/115/tv/某剧", name: "某剧", isDir: true, size: undefined, modifiedAt: undefined },
    { id: "/115/tv/readme.txt", name: "readme.txt", isDir: false, size: 1234, modifiedAt: 1_700_000_000_000 },
  ]);
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path, c.forceRefresh]), [["GetSubFiles", "/115/tv", false]]);
  await provider.listDir("/115/tv/", undefined, { fresh: true });
  assert.deepEqual(fake.calls.at(-1)?.forceRefresh, true);
  assert.deepEqual((await provider.listDir("/")).map((e) => e.id), ["/115", "/hdd"], "根目录下的 id 不带双斜杠");
  await assert.rejects(provider.listDir("/115/没有"), (err: unknown) => err instanceof Cd2Error && /not found/.test(err.message));
});

test("listSubtree：逐层强制刷新，给文件和没有文件的顶层目录（相对路径，口径同别家）；根不存在抛 RemoteDirNotFoundError", async () => {
  const paths = await provider.listSubtree("/115");
  assert.deepEqual(paths.sort(), ["tv/readme.txt", "tv/某剧/Season 1 /E01.mkv", "tv/某剧/Season 1 /E02.mkv", "tv/某剧/poster.jpg", "空目录"].sort());
  const listed = fake.calls.filter((c) => c.method === "GetSubFiles");
  assert.deepEqual(listed.map((c) => c.path), ["/115", "/115/tv", "/115/tv/某剧", "/115/tv/某剧/Season 1 ", "/115/空目录", "/115/空目录/里面也空", "/115/待删"]);
  assert.ok(listed.every((c) => c.forceRefresh), "同步要看最新的，每一层都绕过 CD2 的目录缓存");
  await assert.rejects(provider.listSubtree("/115/没有"), RemoteDirNotFoundError);
  // 已知 id（就是路径）时按 id 走
  assert.deepEqual(await provider.listSubtree("随便", { id: "/115/tv/某剧/Season 1 " }), ["E01.mkv", "E02.mkv"]);
});

test("walkSubtree：目录也在里面，每项带 id 和元数据；子目录中途不见了照常报错，不当成根不存在", async () => {
  const entries = await provider.walkSubtree("/115/tv");
  assert.deepEqual(
    entries.map((e) => [e.path, e.id, e.isDir]),
    [
      ["某剧", "/115/tv/某剧", true],
      ["某剧/Season 1 ", "/115/tv/某剧/Season 1 ", true],
      ["某剧/Season 1 /E01.mkv", "/115/tv/某剧/Season 1 /E01.mkv", false],
      ["某剧/Season 1 /E02.mkv", "/115/tv/某剧/Season 1 /E02.mkv", false],
      ["某剧/poster.jpg", "/115/tv/某剧/poster.jpg", false],
      ["readme.txt", "/115/tv/readme.txt", false],
    ],
  );
  assert.equal(entries.find((e) => e.path === "readme.txt")?.modifiedAt, 1_700_000_000_000);
  // 列表里说有 某剧，真去列却没有了（列到一半被人删了）
  delete fake.tree["/115/tv/某剧"];
  await assert.rejects(provider.walkSubtree("/115/tv"), (err: unknown) => err instanceof Cd2Error && !(err instanceof RemoteDirNotFoundError));
});

test("downloadLink：CD2 自己的下载地址，占位符换成账号地址的协议和 host；文件不在照常报错", async () => {
  const link = await provider.downloadLink("/115/tv/readme.txt");
  const host = new URL(fake.url).host;
  assert.equal(link.url, `${fake.url}/static/http/${host}/false/115%2Ftv%2Freadme.txt?token=dl-1&cloudname=fake&membership=1`);
  assert.equal(link.headers, undefined, "真机探测过：这个地址不用另带 authorization");
  await assert.rejects(provider.downloadLink("/115/tv/没有.mkv"), Cd2Error);
  await assert.rejects(provider.downloadLink("/115/tv"), /Cannot download directory/);
});

test("mkdir / rename：回新路径当 id；目录已经在的 mkdir 当建好了，父目录不在的照常报错", async () => {
  assert.deepEqual(await write().mkdir({ id: "/115/tv", path: "/115/tv" }, "新剧"), { id: "/115/tv/新剧", isDir: true });
  assert.deepEqual(fake.tree["/115/tv/新剧"], []);
  assert.deepEqual(await write().mkdir({ id: "/115/tv", path: "/115/tv/" }, "新剧"), { id: "/115/tv/新剧", isDir: true }, "已存在不算失败");
  await assert.rejects(write().mkdir({ id: "/115/x", path: "/115/没有" }, "y"), /does not exist/);
  await assert.rejects(write().mkdir({ id: "/115/tv", path: "/115/tv" }, "readme.txt"), /already exists/, "占着名字的是个文件：不是建好了");
  // 本地文件夹存储那种表现（真机探测到的）：已存在也回成功、父目录不在连父目录一起建——一样回新目录的路径
  fake.lenientCreateFolder = true;
  assert.deepEqual(await write().mkdir({ id: "/hdd", path: "/hdd" }, "media"), { id: "/hdd/media", isDir: true });
  assert.deepEqual(await write().mkdir({ id: "/hdd", path: "/hdd" }, "media"), { id: "/hdd/media", isDir: true });
  assert.deepEqual(await write().mkdir({ id: "/hdd/a/b", path: "/hdd/a/b" }, "c"), { id: "/hdd/a/b/c", isDir: true });
  assert.deepEqual(fake.tree["/hdd/a/b"], ["c/"]);
  fake.lenientCreateFolder = false;

  assert.deepEqual(await write().rename(node("/115/tv/readme.txt"), "说明.txt"), { id: "/115/tv/说明.txt" });
  assert.ok(fake.tree["/115/tv"]!.includes("说明.txt") && !fake.tree["/115/tv"]!.includes("readme.txt"));
  assert.deepEqual(await write().rename(node("/115/tv/某剧", true), "某剧 (2020)"), { id: "/115/tv/某剧 (2020)" });
  assert.deepEqual(fake.tree["/115/tv/某剧 (2020)/Season 1 "], ["E01.mkv", "E02.mkv"], "目录改名连子树一起");
  await assert.rejects(write().rename(node("/115/tv/说明.txt"), "某剧 (2020)"), /already exists/);
});

test("move：一次 MoveFile 挪完、带 Skip，回各自的新路径；CD2 不说哪些挪成了，挪完看源——还在原处的就是被跳过的，要当失败报出来", async () => {
  fake.tree["/hdd"] = ["E02.mkv"];
  const moved = await write().move([node("/115/tv/readme.txt"), node("/115/tv/某剧/poster.jpg")], { id: "/hdd", path: "/hdd" });
  assert.deepEqual(moved, [{ id: "/hdd/readme.txt" }, { id: "/hdd/poster.jpg" }]);
  assert.deepEqual(fake.moveRequests, [{ sources: ["/115/tv/readme.txt", "/115/tv/某剧/poster.jpg"], dest: "/hdd", policy: 2 }], "不同源目录的也是一次请求，冲突策略 Skip");
  assert.deepEqual(fake.tree["/hdd"], ["E02.mkv", "readme.txt", "poster.jpg"]);

  // 一批里一个撞名、一个没撞：没撞的照挪，抛出来的错误带着「已经挪过去的」（键是传进来的路径）
  const partial = await write()
    .move([node("/115/tv/某剧/Season 1 /E01.mkv"), node("/115/tv/某剧/Season 1 /E02.mkv")], { id: "/hdd", path: "/hdd" })
    .catch((e: unknown) => e);
  assert.ok(partial instanceof PartialMoveError, String(partial));
  assert.match(partial.message, /\/hdd 里已存在同名的 E02\.mkv/);
  assert.deepEqual([...partial.moved], [["/115/tv/某剧/Season 1 /E01.mkv", "/hdd/E01.mkv"]]);
  assert.deepEqual(fake.tree["/115/tv/某剧/Season 1 "], ["E02.mkv"], "撞名的那个留在原地，没被覆盖也没被改名");
  // 一个都没挪成（单个撞名）：普通的 Cd2Error，文案里有「已存在同名」，整理按它归 rejected
  await assert.rejects(
    write().move([node("/115/tv/某剧/Season 1 /E02.mkv")], { id: "/hdd", path: "/hdd" }),
    (err: unknown) => err instanceof Cd2Error && /\/hdd 里已存在同名的 E02\.mkv/.test(err.message),
  );
  assert.deepEqual(await write().move([], { id: "/hdd", path: "/hdd" }), []);
  assert.equal(fake.moveRequests.length, 3, "空列表不发请求");
  // 本来就在目标目录里的不用挪，也不发请求
  assert.deepEqual(await write().move([node("/hdd/readme.txt")], { id: "/hdd", path: "/hdd/" }), [{ id: "/hdd/readme.txt" }]);
  assert.equal(fake.moveRequests.length, 3);
  // 核对用的是 CD2 的缓存（它自己挪完当场就是新的），不逼它重新问网盘
  assert.ok(fake.calls.filter((c) => c.method === "GetSubFiles").every((c) => !c.forceRefresh));
  // 源已经不在了：CD2 回 NOT_FOUND，原样抛（整理按它归「预览之后变了」）
  await assert.rejects(write().move([node("/115/tv/没有.mkv")], { id: "/hdd", path: "/hdd" }), (err: unknown) => err instanceof Cd2Error && err.code === 5);
});

test("rmdirIfEmpty / remove：强制刷新列一遍，空了才删；非空回 false；删文件走普通删除", async () => {
  assert.equal(await write().rmdirIfEmpty(node("/115/tv/某剧", true)), false);
  assert.ok(fake.tree["/115/tv/某剧"], "非空的不动");
  assert.equal(fake.calls.at(-1)?.forceRefresh, true, "看的是最新的，不是 CD2 缓存里的");
  assert.ok(!fake.calls.some((c) => c.method === "DeleteFile"));
  assert.equal(await write().rmdirIfEmpty(node("/115/待删", true)), true);
  assert.equal(fake.tree["/115/待删"], undefined);
  assert.deepEqual(fake.tree["/115"], ["tv/", "空目录/"]);

  await write().remove(node("/115/tv/readme.txt"));
  assert.deepEqual(fake.tree["/115/tv"], ["某剧/"]);
  await assert.rejects(write().remove(node("/115/tv/readme.txt")), /not found/);
});

test("classifyError：令牌失效和缺权限是账号问题；找不到、连不上、别的错误不是", async () => {
  assert.equal(provider.classifyError(new Cd2Error("CD2 GetSubFiles 失败：Unauthenticated", 16)), "auth");
  assert.equal(provider.classifyError(new Cd2Error("CD2 MoveFile 失败：MoveFile permission required", 7)), "auth");
  assert.equal(provider.classifyError(new Cd2Error('CD2 GetSubFiles 失败：find by path: "/115/405 cookie" not found under "/115"', 5)), null, "路径里的字眼不算");
  assert.equal(provider.classifyError(new Cd2Error("CD2 GetSubFiles 失败：连不上", undefined, true)), null);
  assert.equal(provider.classifyError(new Cd2Error("CD2 RenameFile 失败：file already exists")), null);
  assert.equal(provider.classifyError(new Error("permission")), null);
  // 真从假服务上撞一次：缺「移动」权限
  fake.deny.add("MoveFile");
  const err = await write().move([node("/115/tv/readme.txt")], { id: "/hdd", path: "/hdd" }).catch((e: unknown) => e);
  assert.equal(provider.classifyError(err), "auth");
});
