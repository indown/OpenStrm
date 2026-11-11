/**
 * 远程目录浏览接口的夸克分支：按路径找到目录再列子目录、id 给 fid；路径不存在 404、指向文件 400、接口报错 500 带原话。
 * CloudDrive2 账号走同一个接口（以前复制目标另有一个 /api/cd2/list）：对着假 gRPC 服务，id 是完整路径。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/directory/remote.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import remoteRoute from "./remote.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { deleteAccount, insertAccount, listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { resetThrottle } from "../../services/throttle.js";
import { clearQuarkCaches, setQuarkApiBase } from "../../services/quark/client.js";
import { __test_resetCd2Tokens } from "../../services/cd2/client.js";
import { FakeCd2 } from "../../test/fake-cd2.js";

const tree: Record<string, Array<{ fid: string; file_name: string; file: boolean }>> = {
  "0": [
    { fid: "d-tv", file_name: "tv", file: false },
    { fid: "f-x", file_name: "x.txt", file: true },
  ],
  "d-tv": [
    { fid: "d-a", file_name: "A", file: false },
    { fid: "d-b", file_name: "B &amp; C", file: false },
    { fid: "f-y", file_name: "y.mkv", file: true },
  ],
};
let failMode: "none" | "code" = "none";
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname !== "/file/sort") {
    res.writeHead(404);
    return res.end();
  }
  if (failMode === "code") return json(200, { status: 200, code: 31001, message: "require login [guest]" });
  const list = tree[url.searchParams.get("pdir_fid") ?? ""] ?? [];
  json(200, { status: 200, code: 0, data: { list }, metadata: { _total: list.length } });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let app: FastifyInstance;
let auth: Record<string, string>;
const baseline = listAccounts();

before(async () => {
  setQuarkApiBase(base);
  replaceAccounts([{ accountType: "quark", name: "qk", cookie: "c=1" }]);
  // 默认口令下除改密外一律 403，先换掉
  await writeAuthPassword("remote-itest-pw");
  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(remoteRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  setQuarkApiBase(null);
  clearQuarkCaches();
  resetThrottle();
  replaceAccounts(baseline);
  await writeAuthPassword(DEFAULT_AUTH.password);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const list = (path: string) =>
  app.inject({ method: "POST", url: "/api/directory/remote/list", headers: auth, payload: { account: "qk", path } });

test("夸克：根目录只列子目录，id 是 fid", async () => {
  const res = await list("");
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), [{ name: "tv", id: "d-tv", isDir: true, hasChildren: true }]);
});

test("夸克：按名字逐段进入子目录，名字反转义", async () => {
  const res = await list("tv");
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    res.json().map((n: { name: string; id: string }) => [n.name, n.id]),
    [["A", "d-a"], ["B & C", "d-b"]],
  );
});

test("夸克：路径不存在 404，指向文件 400，接口报错 500 且 message 是接口原话", async () => {
  assert.equal((await list("tv/nope")).statusCode, 404);
  assert.equal((await list("x.txt")).statusCode, 400);
  failMode = "code";
  try {
    clearQuarkCaches();
    const res = await list("tv");
    assert.equal(res.statusCode, 500);
    assert.match(res.json().message, /require login/);
    assert.equal(res.json().code, 31001);
  } finally {
    failMode = "none";
  }
});

test("CloudDrive2 账号：只给目录、id 是完整路径，要文件时排在目录后面；路径不存在 404、指向文件 400、CD2 报错 500 带原话", async () => {
  const fake = new FakeCd2();
  await fake.start();
  __test_resetCd2Tokens();
  fake.tree = { "/": ["115/", "hdd/"], "/115": ["movie/", "tv/", "readme.txt"], "/115/movie": [], "/115/tv": [], "/hdd": [] };
  insertAccount({ accountType: "cd2", name: "nas-cd2", url: fake.url, apiToken: "api-token" });
  const cd2 = (path: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/api/directory/remote/list", headers: auth, payload: { account: "nas-cd2", path, ...extra } });
  try {
    const root = await cd2("");
    assert.equal(root.statusCode, 200, root.body);
    assert.deepEqual(root.json(), [
      { name: "115", id: "/115", isDir: true, hasChildren: true },
      { name: "hdd", id: "/hdd", isDir: true, hasChildren: true },
    ]);
    assert.deepEqual((await cd2("/115")).json().map((n: { id: string }) => n.id), ["/115/movie", "/115/tv"]);
    assert.deepEqual(
      (await cd2("115", { withFiles: true })).json().map((n: { name: string; isDir: boolean; size?: number }) => [n.name, n.isDir, n.size]),
      [["movie", true, undefined], ["tv", true, undefined], ["readme.txt", false, 1234]],
    );
    assert.ok(fake.calls.filter((c) => c.method === "GetSubFiles").every((c) => !c.forceRefresh), "浏览走 CD2 的缓存，不逼它重新问网盘");
    assert.equal((await cd2("/115/nope")).statusCode, 404);
    assert.equal((await cd2("/115/readme.txt")).statusCode, 400);
    fake.deny.add("GetSubFiles");
    const denied = await cd2("/115");
    assert.equal(denied.statusCode, 500);
    assert.match(denied.json().message, /GetSubFiles permission required/);
    assert.equal(denied.json().grpcStatus, 7);
  } finally {
    deleteAccount("nas-cd2");
    await fake.stop();
  }
});
