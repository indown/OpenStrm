/**
 * 算要让挂载层刷新哪些目录（services/mount-cache/refresh.ts 的纯函数部分）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountDirsToRefresh } from "./refresh.js";

test("只刷条目的父目录，去重，浅的在前；不往上刷到根", () => {
  assert.deepEqual(mountDirsToRefresh(["/tv/Show/Season 1/E01.mkv", "/tv/Show/Season 1/E02.mkv"]), ["/tv/Show/Season 1"]);
  assert.deepEqual(mountDirsToRefresh(["/tv/Show/Season 1/E01.mkv", "/tv/Show/Season 1", "/tv/Show"]), ["/tv", "/tv/Show", "/tv/Show/Season 1"], "新建的目录由调用方把目录本身报上来，父目录才会刷");
});

test("源和目标两边：同一目录内改名只刷它一处，跨目录挪动两处都刷", () => {
  assert.deepEqual(mountDirsToRefresh(["/movie/A (2013)/a.mkv", "/movie/A (2013)/b.mkv"]), ["/movie/A (2013)"]);
  assert.deepEqual(mountDirsToRefresh(["/movie/A (2013)/a.mkv", "/movie/A (2014)/a.mkv"]), ["/movie/A (2013)", "/movie/A (2014)"]);
});

test("删掉的目录不刷（刷了只会 object not found），它的父目录照刷", () => {
  assert.deepEqual(mountDirsToRefresh(["/movie/old/a.mkv", "/movie/new/a.mkv", "/movie/old"], { removed: ["/movie/old"] }), ["/movie", "/movie/new"]);
});

test("根目录下的条目只刷根；空路径忽略；斜杠归一但段里的空格留着", () => {
  assert.deepEqual(mountDirsToRefresh(["/x.mkv", "", "//tv//Season 1 /e.mkv"]), ["/", "/tv/Season 1 "]);
  assert.deepEqual(mountDirsToRefresh([]), []);
});
