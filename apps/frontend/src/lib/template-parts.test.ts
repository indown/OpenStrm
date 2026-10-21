/**
 *   pnpm --filter @openstrm/frontend test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasTopLevelSlash, joinMovie, joinTv, splitMovie, splitRenderedPath, splitTv, topLevelSlashes } from "./template-parts";

const MOVIE = "{category}/{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}";
const TV = "{category}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {episodeTitle}].{ext}";

test("电影：最后一个顶层斜杠之前是目录（可以多层），之后是文件名", () => {
  assert.deepEqual(splitMovie(MOVIE), { dir: "{category}/{title} ({year}) {idTag}", file: "{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}" });
  assert.deepEqual(splitMovie("{title}.{ext}"), { dir: "", file: "{title}.{ext}" });
  assert.deepEqual(splitMovie("{category}/{year}/{title} ({year}) {idTag}/{originalName}.{ext}"), { dir: "{category}/{year}/{title} ({year}) {idTag}", file: "{originalName}.{ext}" });
});

test("可选段里的斜杠不算分层：[{collection}/] 留在目录那一格", () => {
  const t = "{category}/[{collection}/]{title} ({year}) {idTag}/{title} ({year}).{ext}";
  assert.deepEqual(splitMovie(t), { dir: "{category}/[{collection}/]{title} ({year}) {idTag}", file: "{title} ({year}).{ext}" });
  assert.deepEqual(topLevelSlashes("a/[b/c]/d"), [1, 7]);
});

test("剧集：倒数第二段含季变量且不含片名才是季目录；没有季目录时季那格留空", () => {
  assert.deepEqual(splitTv(TV), {
    dir: "{category}/{title} ({year}) {idTag}",
    season: "Season {season00}",
    file: "{title} - S{season00}E{episode00}[ - {episodeTitle}].{ext}",
  });
  assert.deepEqual(splitTv("{category}/{title} ({year}) {idTag}/{title} - S{season00}E{episode00}.{ext}"), {
    dir: "{category}/{title} ({year}) {idTag}",
    season: "",
    file: "{title} - S{season00}E{episode00}.{ext}",
  });
  // 季写进剧目录名里：不是季目录
  assert.deepEqual(splitTv("{category}/{title} S{season00}/{title} - E{episode00}.{ext}"), {
    dir: "{category}/{title} S{season00}",
    season: "",
    file: "{title} - E{episode00}.{ext}",
  });
  assert.deepEqual(splitTv("{title}/{season}/{episode}.{ext}"), { dir: "{title}", season: "{season}", file: "{episode}.{ext}" });
  assert.deepEqual(splitTv("{title} - S{season00}E{episode00}.{ext}"), { dir: "", season: "", file: "{title} - S{season00}E{episode00}.{ext}" });
});

test("拆了再拼一字不差（设置页的脏状态是比字符串）", () => {
  const samples = [
    MOVIE,
    TV,
    "{title}.{ext}",
    "{category}/[{collection}/]{title} ({year}) {idTag}/{title} ({year}).{ext}",
    "{category}/{year}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {absolute000}].{ext}",
    "{category}/{title} ({year}) {idTag}/{originalName}.{ext}",
    "a/b/c/d/e.{ext}",
    "{title} \\[x\\]/{title}.{ext}",
  ];
  for (const t of samples) {
    assert.equal(joinMovie(splitMovie(t)!), t, `movie: ${t}`);
    assert.equal(joinTv(splitTv(t)!), t, `tv: ${t}`);
  }
});

test("括号不配对拆不了；转义的括号不算括号", () => {
  assert.equal(splitMovie("{title} [{year}/{title}.{ext}"), null);
  assert.equal(splitTv("{title}]/{title}.{ext}"), null);
  assert.deepEqual(splitMovie("{title} \\[x/{title}.{ext}"), { dir: "{title} \\[x", file: "{title}.{ext}" });
});

test("文件名 / 季目录那格有没有分层斜杠", () => {
  assert.equal(hasTopLevelSlash("{title}.{ext}"), false);
  assert.equal(hasTopLevelSlash("[{collection}/]{title}.{ext}"), false);
  assert.equal(hasTopLevelSlash("Season {season00}/{title}.{ext}"), true);
});

test("渲染结果按最后一个斜杠分目录和文件", () => {
  assert.deepEqual(splitRenderedPath("电影/沙丘 (2024)/沙丘 (2024).mkv"), { dir: "电影/沙丘 (2024)", file: "沙丘 (2024).mkv" });
  assert.deepEqual(splitRenderedPath("沙丘.mkv"), { dir: "", file: "沙丘.mkv" });
});
