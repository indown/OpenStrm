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
import { accountNameByTask, effectiveMountPaths, joinPanPath, matchPathMapping, normalizeMediaPath, safeDecode, stripMountPath } from "./direct-link.js";
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
