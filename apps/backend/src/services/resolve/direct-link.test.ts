/**
 * 路径映射的纯函数测试。
 *
 * 这层出错的表现是"能播但播错文件"或"整库都不 302"，比崩溃更难查，
 * 所以边界情况都钉在这里：
 *   pnpm test:file src/services/resolve/direct-link.test.ts
 */
import assert from "node:assert/strict";
import { test as t } from "node:test";
import type { AppSettings, ProxyPathMapping, TaskDefinition } from "@openstrm/shared";
import { PermanentError } from "../../lib/errors.js";
import { deleteAccount, insertAccount } from "../../db/repositories/accounts.js";
import { deletePathCache, findPathCacheFile, upsertPathCache } from "../../db/repositories/life.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { resetSettingsMemo } from "../settings-safe.js";
import { Cloud115ApiError, type FileInfo115 } from "../cloud-115/client.js";
import { accountNameByTask, clearPathCache, effectiveMountPaths, findPickcode, joinPanPath, matchPathMapping, normalizeMediaPath, pathCacheRowMatches, resolveEmbyPath, safeDecode, setResolverDeps, stripMountPath } from "./direct-link.js";
// ---- stripMountPath ----
t("剥掉挂载前缀，剩下的就是盘内路径", () => {
  const r = stripMountPath("/mnt/pan/tv/Show/ep1.mkv", ["/mnt/pan"]);
  assert.deepEqual(r, { mount: "/mnt/pan", rest: "/tv/Show/ep1.mkv" });
});

t("互为前缀的挂载点取最长匹配", () => {
  // /mnt/115 排在前面也不能抢走 /mnt/115-4k 的路径
  const r = stripMountPath("/mnt/115-4k/movie.mkv", ["/mnt/115", "/mnt/115-4k"]);
  assert.equal(r?.mount, "/mnt/115-4k");
  assert.equal(r?.rest, "/movie.mkv");
});

t("配置里的尾部斜杠不影响匹配", () => {
  const r = stripMountPath("/mnt/pan/a.mkv", ["/mnt/pan/"]);
  assert.equal(r?.mount, "/mnt/pan");
  assert.equal(r?.rest, "/a.mkv");
});

t("路径正好等于挂载点", () => {
  assert.deepEqual(stripMountPath("/mnt/pan", ["/mnt/pan"]), { mount: "/mnt/pan", rest: "/" });
});

t("不在挂载点下返回 null——本地文件不该被 302", () => {
  assert.equal(stripMountPath("/media/local/movie.mkv", ["/mnt/pan"]), null);
});

t("前缀相同但不是目录边界，不算命中", () => {
  // /mnt/panda 不该被 /mnt/pan 匹配掉
  assert.equal(stripMountPath("/mnt/panda/a.mkv", ["/mnt/pan"]), null);
});

t("挂载点没配时返回 null", () => {
  assert.equal(stripMountPath("/mnt/pan/a.mkv", []), null);
});
// ---- safeDecode ----
t("还原 encodeURI 过的中文路径", () => {
  assert.equal(safeDecode("/mnt/pan/%E7%94%B5%E5%BD%B1/a.mkv"), "/mnt/pan/电影/a.mkv");
});

t("解不开的百分号原样返回，不抛异常", () => {
  assert.equal(safeDecode("/mnt/pan/100%/a.mkv"), "/mnt/pan/100%/a.mkv");
});
// ---- accountNameByTask ----
const tasks: TaskDefinition[] = [
  { id: "1", account: "主号", originPath: "/tv", targetPath: "/data/tv", strmPrefix: "/mnt/pan" },
  { id: "2", account: "小号", originPath: "movie", targetPath: "/data/movie", strmPrefix: "/mnt/pan" },
  { id: "3", account: "别的盘", originPath: "/tv", targetPath: "/data/x", strmPrefix: "/mnt/other" },
];

t("按 strmPrefix + originPath 反查到账号", () => {
  assert.equal(accountNameByTask("/mnt/pan", "/tv/Show/ep1.mkv", tasks), "主号");
});

t("originPath 没写前导斜杠也能匹配", () => {
  assert.equal(accountNameByTask("/mnt/pan", "/movie/x.mkv", tasks), "小号");
});

t("挂载点不同的任务不会被误选", () => {
  assert.equal(accountNameByTask("/mnt/other", "/tv/a.mkv", tasks), "别的盘");
});

t("originPath 只是名字前缀但不是目录边界，不算命中", () => {
  // /tvshows 不该匹配到 originPath 为 /tv 的任务
  assert.equal(accountNameByTask("/mnt/pan", "/tvshows/a.mkv", tasks), null);
});

t("路径正好是 originPath 本身也算命中", () => {
  assert.equal(accountNameByTask("/mnt/pan", "/tv", tasks), "主号");
});

t("没有匹配的任务返回 null，交给后面的兜底逻辑", () => {
  assert.equal(accountNameByTask("/mnt/pan", "/music/a.flac", tasks), null);
});

t("originPath 为空表示整个挂载点都归这个任务", () => {
  const whole: TaskDefinition[] = [
    { id: "9", account: "整盘", originPath: "", targetPath: "/data", strmPrefix: "/mnt/all" },
  ];
  assert.equal(accountNameByTask("/mnt/all", "/anything/a.mkv", whole), "整盘");
});

t("同一挂载点下取最长匹配的 originPath", () => {
  // /tv 和 /tv/anime 两个任务并存时，anime 下的文件必须归小号——
  // 取第一个命中的话会随任务顺序选错盘，而 life/handlers.ts 的 matchTask 是最长匹配
  const both: TaskDefinition[] = [
    { id: "a", account: "主号", originPath: "/tv", targetPath: "/d1", strmPrefix: "/mnt/pan" },
    { id: "b", account: "小号", originPath: "/tv/anime", targetPath: "/d2", strmPrefix: "/mnt/pan" },
  ];
  assert.equal(accountNameByTask("/mnt/pan", "/tv/anime/ep1.mkv", both), "小号");
  assert.equal(accountNameByTask("/mnt/pan", "/tv/other/ep1.mkv", both), "主号");
});

t("任务顺序颠倒也取最长匹配", () => {
  const reversed: TaskDefinition[] = [
    { id: "b", account: "小号", originPath: "/tv/anime", targetPath: "/d2", strmPrefix: "/mnt/pan" },
    { id: "a", account: "主号", originPath: "/tv", targetPath: "/d1", strmPrefix: "/mnt/pan" },
  ];
  assert.equal(accountNameByTask("/mnt/pan", "/tv/anime/ep1.mkv", reversed), "小号");
});

// ---- strm 前缀是 OpenList 地址 ----
t("normalizeMediaPath：压掉重复斜杠，但 scheme 后面的 // 保留", () => {
  assert.equal(normalizeMediaPath("/mnt/pan//tv///a.mkv"), "/mnt/pan/tv/a.mkv");
  assert.equal(normalizeMediaPath("http://ol:5244/d//115/tv//a.mkv"), "http://ol:5244/d/115/tv/a.mkv");
  assert.equal(normalizeMediaPath("HTTPS://ol/d/a.mkv"), "HTTPS://ol/d/a.mkv");
});

t("URL 前缀按 URL 剥挂载点：尾斜杠、重复斜杠都不影响，目录边界照样要对", () => {
  const r = stripMountPath("http://ol:5244/d/115//tv/Show/ep1.mkv", ["/mnt/pan", "http://ol:5244/d/115/"]);
  assert.deepEqual(r, { mount: "http://ol:5244/d/115", rest: "/tv/Show/ep1.mkv" });
  assert.equal(stripMountPath("http://ol:5244/d/other/a.mkv", ["http://ol:5244/d/115"]), null, "别的存储不归我们管");
  assert.equal(stripMountPath("http://ol:5244/d/1150/a.mkv", ["http://ol:5244/d/115"]), null, "不是目录边界不算命中");
  // 本地挂载路径的行为不变
  assert.deepEqual(stripMountPath("/mnt/pan//tv/a.mkv", ["/mnt/pan", "http://ol:5244/d/115"]), { mount: "/mnt/pan", rest: "/tv/a.mkv" });
});

t("URL 前缀的任务也能反查到账号，不需要路径里带账号名", () => {
  const web: TaskDefinition[] = [
    { id: "w", account: "主号", originPath: "tv", targetPath: "tv", strmPrefix: "http://ol:5244/d/115/", enable302: true },
    { id: "l", account: "小号", originPath: "tv", targetPath: "tv2", strmPrefix: "/mnt/pan/小号", enable302: true },
  ];
  assert.equal(accountNameByTask("http://ol:5244/d/115", "/tv/Show/ep1.mkv", web), "主号");
  assert.equal(accountNameByTask("/mnt/pan/小号", "/tv/Show/ep1.mkv", web), "小号");
  const settings = { mediaMountPath: ["/mnt/manual/"] } as unknown as AppSettings;
  assert.deepEqual(effectiveMountPaths(settings, web), ["/mnt/manual", "http://ol:5244/d/115", "/mnt/pan/小号"]);
});

// ---- 手填的路径映射 ----
const mappings: ProxyPathMapping[] = [
  { from: "/mnt/other", account: "小号", to: "/视频" },
  { from: "/mnt/other/电影/", account: "主号" },
  { from: "http://ol:5244/d/pan", account: "主号", to: "/" },
];

t("路径映射取最长前缀，剩下的就是相对路径", () => {
  const r = matchPathMapping("/mnt/other/电影/a.mkv", mappings);
  assert.equal(r?.mapping.account, "主号");
  assert.equal(r?.rest, "/a.mkv");
  const shorter = matchPathMapping("/mnt/other/tv/a.mkv", mappings);
  assert.equal(shorter?.mapping.account, "小号");
  assert.equal(shorter?.rest, "/tv/a.mkv");
});

t("路径映射按目录边界，不在任何前缀下返回 null", () => {
  assert.equal(matchPathMapping("/mnt/others/a.mkv", mappings), null, "/mnt/others 不该被 /mnt/other 命中");
  assert.equal(matchPathMapping("/media/a.mkv", mappings), null);
  assert.equal(matchPathMapping("/media/a.mkv", undefined), null);
});

t("没填完的映射不算数：空前缀不能把 / 当成前缀接管一切", () => {
  assert.equal(matchPathMapping("/media/a.mkv", [{ from: "", account: "主号" }]), null);
  assert.equal(matchPathMapping("/media/a.mkv", [{ from: "   ", account: "主号" }]), null);
  assert.equal(matchPathMapping("/media/a.mkv", [{ from: "/media", account: "" }]), null, "没选账号的也不算");
});

t("URL 前缀的映射同样能剥", () => {
  const r = matchPathMapping("http://ol:5244/d/pan//tv/a.mkv", mappings);
  assert.equal(r?.mapping.account, "主号");
  assert.equal(r?.rest, "/tv/a.mkv");
});

t("joinPanPath：目标目录拼上相对路径，不填就是根目录", () => {
  assert.equal(joinPanPath("/视频", "/tv/a.mkv"), "/视频/tv/a.mkv");
  assert.equal(joinPanPath("视频/", "/a.mkv"), "/视频/a.mkv", "前导斜杠补上、尾斜杠去掉");
  assert.equal(joinPanPath(undefined, "/a.mkv"), "/a.mkv");
  assert.equal(joinPanPath("", "/a.mkv"), "/a.mkv");
  assert.equal(joinPanPath("/", "/a.mkv"), "/a.mkv");
  assert.equal(joinPanPath("/视频", "/"), "/视频", "路径正好等于前缀时就是目标目录本身");
  assert.equal(joinPanPath("/", "/"), "/");
});

t("映射的前缀算进挂载集合，PlaybackInfo 才会把这些源标成可直连", () => {
  const settings = { emby: { pathMappings: [{ from: "/mnt/other/", account: "主号" }, { from: "", account: "主号" }] } } as unknown as AppSettings;
  assert.deepEqual(effectiveMountPaths(settings, []), ["/mnt/other"]);
});

// ---- findPickcode ----
const account = { name: "主号", accountType: "115", cookie: "c" } as unknown as Parameters<typeof findPickcode>[0];

t("路径 → pickcode 记在内存里：同一路径第二次（哪怕换了 UA）不再找路径；找不到的不记；清掉后重找", async () => {
  const calls: string[] = [];
  setResolverDeps({
    pathCacheFile: () => undefined,
    idToPath: (async ({ path }: { path: string }) => {
      calls.push(path);
      if (path.endsWith("missing.mkv")) throw new PermanentError("File not found");
      return "pc-a";
    }) as never,
  });
  try {
    clearPathCache();
    assert.deepEqual(await findPickcode(account, "/tv/a.mkv", "UA-1"), { pickcode: "pc-a", via: "list", fileId: null });
    assert.deepEqual(await findPickcode(account, "/tv/a.mkv", "UA-2"), { pickcode: "pc-a", via: "memo", fileId: null });
    assert.deepEqual(calls, ["/tv/a.mkv"], "pickcode 不分 UA，第二次直接用缓存");
    assert.equal(await findPickcode(account, "/tv/missing.mkv", undefined), null);
    assert.equal(await findPickcode(account, "/tv/missing.mkv", undefined), null);
    assert.equal(calls.length, 3, "找不到的不记，下次还会再找");
    clearPathCache();
    await findPickcode(account, "/tv/a.mkv", undefined);
    assert.equal(calls.length, 4, "清掉后重新找");
    await assert.rejects(
      (async () => {
        setResolverDeps({ pathCacheFile: () => undefined, idToPath: (async () => { throw new Error("ECONNRESET"); }) as never });
        await findPickcode(account, "/tv/b.mkv", undefined);
      })(),
      /ECONNRESET/,
      "网络错误照样往上抛，交给调用方回源",
    );
  } finally {
    setResolverDeps(null);
    clearPathCache();
  }
});

t("同一路径同时找两次只找一次：第二个等第一个的结果（Infuse 第二跳紧跟着预热到）", async () => {
  let listing = 0;
  setResolverDeps({
    pathCacheFile: () => undefined,
    idToPath: (async () => {
      listing += 1;
      await new Promise((r) => setTimeout(r, 20));
      return "pc-once";
    }) as never,
  });
  try {
    clearPathCache();
    const [a, b] = await Promise.all([findPickcode(account, "/tv/once.mkv", "UA-1"), findPickcode(account, "/tv/once.mkv", "UA-2")]);
    assert.equal(listing, 1);
    assert.deepEqual(a, { pickcode: "pc-once", via: "list", fileId: null });
    assert.deepEqual(b, a);
    assert.equal((await findPickcode(account, "/tv/once.mkv", undefined))?.via, "memo", "找完之后内存里有了");
  } finally {
    setResolverDeps(null);
    clearPathCache();
  }
});

const info = (over: Partial<FileInfo115>): FileInfo115 => ({ fileId: "3117196816692065836", parentId: "1001", name: "a.mkv", pickcode: "pc-db", size: 1, area: 1, ...over });

t("库里的行要和网盘档案核对：文件名一样、还在正常区；没记名字就拿路径末段比（父目录另外按路径现问）", () => {
  const row = { name: "a.mkv", path: "/tv/a.mkv" };
  assert.equal(pathCacheRowMatches(info({}), row), true);
  assert.equal(pathCacheRowMatches(info({ name: "b.mkv" }), row), false, "改过名");
  assert.equal(pathCacheRowMatches(info({ area: 7 }), row), false, "进了回收站");
  assert.equal(pathCacheRowMatches(info({ parentId: "2002" }), row), true, "父目录不在这里看");
  assert.equal(pathCacheRowMatches(info({}), { name: "", path: "/tv/a.mkv" }), true, "没记名字就拿路径末段比");
  assert.equal(pathCacheRowMatches(info({ name: "x.mkv" }), { name: "", path: "/tv/a.mkv" }), false);
});

/** 库里的一行；updatedAt 是秒，默认很久以前 */
const row = (over: { fileId: string; name: string; path: string; updatedAt?: number }) => ({ parentId: "", isDir: 0, accountName: "主号", updatedAt: 1_000_000_000, ...over });

t("库里的路径缓存有这个文件：按 file_id 取档案核对文件名，再按路径问目录 id 核对父目录，都对上才用 pickcode；对不上 / 没了 / 115 说不行都退回列目录；网络错误往上抛", async () => {
  const calls: string[] = [];
  const rows: Record<string, ReturnType<typeof row>> = {
    "/tv/a.mkv": row({ fileId: "3117196816692065836", name: "a.mkv", path: "/tv/a.mkv" }),
    "/tv/moved.mkv": row({ fileId: "2", name: "moved.mkv", path: "/tv/moved.mkv" }),
    "/tv/gone.mkv": row({ fileId: "3", name: "gone.mkv", path: "/tv/gone.mkv" }),
    "/tv/err.mkv": row({ fileId: "4", name: "err.mkv", path: "/tv/err.mkv" }),
    "/tv/down.mkv": row({ fileId: "5", name: "down.mkv", path: "/tv/down.mkv" }),
    "/renamed/show/x.mkv": row({ fileId: "6", name: "x.mkv", path: "/renamed/show/x.mkv" }),
    "/root.mkv": row({ fileId: "7", name: "root.mkv", path: "/root.mkv" }),
  };
  setResolverDeps({
    pathCacheFile: (_account, path) => rows[path] as never,
    fileInfoById: (async (id: number | string) => {
      calls.push(`info:${id}`);
      if (id === "3117196816692065836") return info({});
      if (id === "2") return info({ fileId: "2", name: "moved.mkv", parentId: "2002" });
      if (id === "3") return null;
      if (id === "4") throw new Cloud115ApiError("115：参数错误", 20001);
      if (id === "5") throw new Error("timeout of 30000ms exceeded");
      if (id === "6") return info({ fileId: "6", name: "x.mkv", parentId: "3003" });
      if (id === "7") return info({ fileId: "7", name: "root.mkv", parentId: "0" });
      throw new Error("没这个 id");
    }) as never,
    dirIdByPath: (async (path: string) => {
      calls.push(`dir:${path}`);
      // /tv 还是 1001；/renamed/show 改过名，现在这条路径上是另一个目录
      return { id: path === "tv" ? 1001 : path === "renamed/show" ? 9999 : 0 };
    }) as never,
    idToPath: (async ({ path }: { path: string }) => {
      calls.push(`list:${path}`);
      return "pc-list";
    }) as never,
  });
  try {
    clearPathCache();
    assert.deepEqual(await findPickcode(account, "/tv/a.mkv", undefined), { pickcode: "pc-db", via: "db", fileId: "3117196816692065836" });
    assert.deepEqual(calls, ["info:3117196816692065836", "dir:tv"], "file_id 原样传过去（字符串，别转成 number 失真）；档案和目录 id 都对上了就不列目录");
    assert.deepEqual(await findPickcode(account, "/tv/a.mkv", undefined), { pickcode: "pc-db", via: "memo", fileId: "3117196816692065836" });
    calls.length = 0;
    assert.deepEqual(await findPickcode(account, "/tv/moved.mkv", undefined), { pickcode: "pc-list", via: "list", fileId: null });
    assert.deepEqual(await findPickcode(account, "/tv/gone.mkv", undefined), { pickcode: "pc-list", via: "list", fileId: null });
    assert.deepEqual(await findPickcode(account, "/tv/err.mkv", undefined), { pickcode: "pc-list", via: "list", fileId: null });
    assert.deepEqual(calls, ["info:2", "dir:tv", "list:/tv/moved.mkv", "info:3", "list:/tv/gone.mkv", "info:4", "list:/tv/err.mkv"], "挪走 / 没了 / 115 说不行：都退回列目录");
    assert.deepEqual(await findPickcode(account, "/renamed/show/x.mkv", undefined), { pickcode: "pc-list", via: "list", fileId: null }, "上一级目录改过名：行里的父目录对得上也不算，按路径现问的目录 id 对不上");
    assert.deepEqual(await findPickcode(account, "/root.mkv", undefined), { pickcode: "pc-db", via: "db", fileId: "7" }, "根目录下的文件：父目录是 0，不用问目录 id");
    await assert.rejects(findPickcode(account, "/tv/down.mkv", undefined), /timeout/, "网络错误不退回列目录（列目录一样过不去），往上抛");
    assert.deepEqual(await findPickcode(account, "/tv/other.mkv", undefined), { pickcode: "pc-list", via: "list", fileId: null });
    calls.length = 0;
    assert.deepEqual(await findPickcode(account, "/tv/a.mkv", undefined, { fresh: true }), { pickcode: "pc-list", via: "list", fileId: null }, "fresh 跳过内存和库");
    assert.deepEqual(calls, ["list:/tv/a.mkv"]);
  } finally {
    setResolverDeps(null);
    clearPathCache();
  }
});

t("内存里的记录只在库里这一行没改过时才信：行比记录新（整理 / 转存改过它）就重新核对", async () => {
  const calls: string[] = [];
  let current = row({ fileId: "11", name: "a.mkv", path: "/tv/a.mkv" });
  setResolverDeps({
    pathCacheFile: () => current as never,
    fileInfoById: (async (id: string) => {
      calls.push(`info:${id}`);
      return info({ fileId: id, pickcode: `pc-${id}` });
    }) as never,
    dirIdByPath: (async () => ({ id: 1001 })) as never,
  });
  try {
    clearPathCache();
    assert.equal((await findPickcode(account, "/tv/a.mkv", undefined))?.pickcode, "pc-11");
    assert.equal((await findPickcode(account, "/tv/a.mkv", undefined))?.via, "memo");
    // 整理换了文件：同路径换成另一行、updated_at 是现在
    current = row({ fileId: "12", name: "a.mkv", path: "/tv/a.mkv", updatedAt: Math.floor(Date.now() / 1000) + 5 });
    assert.deepEqual(await findPickcode(account, "/tv/a.mkv", undefined), { pickcode: "pc-12", via: "db", fileId: "12" }, "行更新了：不信内存，重新核对新行");
    assert.deepEqual(calls, ["info:11", "info:12"]);
  } finally {
    setResolverDeps(null);
    clearPathCache();
  }
});

t("内存里记的 pickcode 取链时 115 说不行：清掉、绕过所有缓存现找一次再取；网络 / 登录问题不重找；库里核对过的和现找的取不到就是真失败", async () => {
  const baseline = readAppSettings();
  replaceAppSettings({ ...baseline, emby: { ...baseline.emby, pathMappings: [{ from: "/mnt/dl-test", account: "直链测试号" }] } });
  resetSettingsMemo();
  insertAccount({ name: "直链测试号", accountType: "115", cookie: "c" } as never);
  const calls: string[] = [];
  let linkError: (pickcode: string) => Error | null = () => null;
  setResolverDeps({
    pathCacheFile: () => row({ fileId: "9", name: "a.mkv", path: "/tv/a.mkv" }) as never,
    fileInfoById: (async () => info({ fileId: "9", pickcode: "pc-9" })) as never,
    dirIdByPath: (async () => ({ id: 1001 })) as never,
    idToPath: (async ({ path, fresh }: { path: string; fresh?: boolean }) => {
      calls.push(`list:${path}:${fresh ? "fresh" : "cached"}`);
      return "pc-fresh";
    }) as never,
    downloadUrl: (async (pickcode: string) => {
      calls.push(`link:${pickcode}`);
      const err = linkError(pickcode);
      if (err) throw err;
      return `https://cdn/${pickcode}`;
    }) as never,
  });
  try {
    clearPathCache();
    // 第一次：库路线核对过，取链成功，内存里记下 pc-9
    let r = await resolveEmbyPath("/mnt/dl-test/tv/a.mkv");
    assert.equal(r.ok && r.timings.pathVia, "db");
    assert.deepEqual(calls, ["link:pc-9"]);

    // 第二次：内存命中，115 说这个 pickcode 不行 → 现找（fresh，绕过进程内缓存）再取
    calls.length = 0;
    linkError = (pc) => (pc === "pc-9" ? new Cloud115ApiError("115：文件不存在", 20018) : null);
    r = await resolveEmbyPath("/mnt/dl-test/tv/a.mkv");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.url, "https://cdn/pc-fresh");
      assert.equal(r.timings.pathVia, "list");
    }
    assert.deepEqual(calls, ["link:pc-9", "list:/tv/a.mkv:fresh", "link:pc-fresh"]);
    assert.equal((await findPickcode({ name: "直链测试号" } as never, "/tv/a.mkv", undefined))?.pickcode, "pc-fresh", "内存里换成现找的");

    // 内存命中但取链是网络错误：不重找，照样往上抛
    calls.length = 0;
    linkError = () => new Error("timeout of 30000ms exceeded");
    await assert.rejects(resolveEmbyPath("/mnt/dl-test/tv/a.mkv"), /timeout/);
    assert.deepEqual(calls, ["link:pc-fresh"], "没有列目录");

    // 内存命中但是登录失效：也不重找
    linkError = () => new Cloud115ApiError("115：请重新登录（errno 99）", 99);
    await assert.rejects(resolveEmbyPath("/mnt/dl-test/tv/a.mkv"), /请重新登录/);
    assert.deepEqual(calls, ["link:pc-fresh", "link:pc-fresh"]);

    // 库里核对过的 pickcode 取不到链：不重找（档案刚核对过，列目录只会找到同一个文件）
    clearPathCache();
    calls.length = 0;
    linkError = () => new Cloud115ApiError("115：文件不存在", 20018);
    await assert.rejects(resolveEmbyPath("/mnt/dl-test/tv/a.mkv"), /文件不存在/);
    assert.deepEqual(calls, ["link:pc-9"]);

    // 现找的也取不到链：老老实实回 no-url
    clearPathCache();
    setResolverDeps({
      pathCacheFile: () => undefined,
      idToPath: (async () => "pc-dead") as never,
      downloadUrl: (async (pickcode: string) => {
        calls.push(`link:${pickcode}`);
        return "";
      }) as never,
    });
    calls.length = 0;
    const dead = await resolveEmbyPath("/mnt/dl-test/tv/a.mkv");
    assert.deepEqual(dead, { ok: false, reason: "no-url" });
    assert.deepEqual(calls, ["link:pc-dead"]);

    // 现找的取链抛异常：往上抛，交给调用方回源
    clearPathCache();
    setResolverDeps({
      pathCacheFile: () => undefined,
      idToPath: (async () => "pc-x") as never,
      downloadUrl: (async () => {
        throw new Error("115 风控");
      }) as never,
    });
    await assert.rejects(resolveEmbyPath("/mnt/dl-test/tv/a.mkv"), /115 风控/);
  } finally {
    setResolverDeps(null);
    clearPathCache();
    deleteAccount("直链测试号");
    replaceAppSettings(baseline);
    resetSettingsMemo();
  }
});

t("Alist 式路径（挂载点下带账号名）：盘内路径带前导斜杠，库里的路径缓存才查得到", async () => {
  const baseline = readAppSettings();
  replaceAppSettings({ ...baseline, mediaMountPath: ["/mnt/alist"], emby: { ...baseline.emby, pathMappings: [] } });
  resetSettingsMemo();
  insertAccount({ name: "直链测试号", accountType: "115", cookie: "c" } as never);
  const asked: string[] = [];
  setResolverDeps({
    pathCacheFile: (accountName, path) => {
      asked.push(`${accountName}:${path}`);
      return undefined;
    },
    idToPath: (async () => "pc-alist") as never,
    downloadUrl: (async () => "https://cdn/alist") as never,
  });
  try {
    clearPathCache();
    const r = await resolveEmbyPath("/mnt/alist/直链测试号/tv/a.mkv");
    assert.equal(r.ok && r.panPath, "/tv/a.mkv");
    assert.deepEqual(asked, ["直链测试号:/tv/a.mkv"]);
  } finally {
    setResolverDeps(null);
    clearPathCache();
    deleteAccount("直链测试号");
    replaceAppSettings(baseline);
    resetSettingsMemo();
  }
});

t("findPathCacheFile：按账号 + 路径只认文件行；同路径多行取最新的", () => {
  upsertPathCache([
    { fileId: "dl-dir", parentId: "0", name: "tv", path: "/dl/tv", isDir: true, accountName: "主号" },
    { fileId: "dl-file", parentId: "dl-dir", name: "a.mkv", path: "/dl/tv/a.mkv", isDir: false, accountName: "主号" },
    { fileId: "dl-other", parentId: "dl-dir", name: "a.mkv", path: "/dl/tv/a.mkv", isDir: false, accountName: "别的号" },
  ]);
  try {
    assert.equal(findPathCacheFile("主号", "/dl/tv/a.mkv")?.fileId, "dl-file");
    assert.equal(findPathCacheFile("别的号", "/dl/tv/a.mkv")?.fileId, "dl-other");
    assert.equal(findPathCacheFile("主号", "/dl/tv"), undefined, "目录行不算");
    assert.equal(findPathCacheFile("主号", "/dl/tv/b.mkv"), undefined);
    // 同路径换了文件、旧行还没清：取后写的那行
    upsertPathCache([{ fileId: "dl-file-2", parentId: "dl-dir", name: "a.mkv", path: "/dl/tv/a.mkv", isDir: false, accountName: "主号" }]);
    assert.equal(findPathCacheFile("主号", "/dl/tv/a.mkv")?.fileId, "dl-file-2");
  } finally {
    deletePathCache(["dl-dir", "dl-file", "dl-file-2", "dl-other"]);
  }
});
