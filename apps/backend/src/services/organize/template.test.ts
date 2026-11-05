/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/template.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanValue, episodeToken, idTagFor, releaseJoin, renderTemplate, templateVarNames, validateTemplate } from "./template.js";
import { DEFAULT_TEMPLATES } from "./settings.js";

const movie = { title: "沙丘：第二部", year: "2024", idTag: "[tmdbid=693134]", resolution: "2160p", ext: "mkv" };

test("默认电影模板：可选段和空分类段", () => {
  const r = renderTemplate(DEFAULT_TEMPLATES.movie, movie);
  assert.deepEqual(r.errors, []);
  assert.equal(r.path, "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv");
  const withCat = renderTemplate(DEFAULT_TEMPLATES.movie, { ...movie, category: "电影", edition: "导演剪辑版" });
  assert.equal(withCat.path, "电影/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 导演剪辑版 - 2160p.mkv");
  const noRes = renderTemplate(DEFAULT_TEMPLATES.movie, { ...movie, resolution: "" });
  assert.equal(noRes.path, "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024).mkv");
});

test("默认剧集模板：季集补零、多集范围、集标题可选", () => {
  const r = renderTemplate(DEFAULT_TEMPLATES.tv, { title: "怒呛人生", year: "2023", idTag: "[tmdbid=153312]", season00: "01", episode00: episodeToken(1, undefined, 2), ext: "mkv" });
  assert.equal(r.path, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  const multi = renderTemplate(DEFAULT_TEMPLATES.tv, { title: "怒呛人生", year: "2023", idTag: "[tmdbid=153312]", season00: "01", episode00: episodeToken(1, 2, 2), episodeTitle: "飞鸟不鸣", ext: "mkv" });
  assert.equal(multi.path, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01-E02 - 飞鸟不鸣.mkv");
});

test("变量清洗：冒号策略、非法字符、斜杠", () => {
  assert.equal(cleanValue("Mission: Impossible", "smart"), "Mission - Impossible");
  assert.equal(cleanValue("Mission:Impossible", "smart"), "Mission-Impossible");
  assert.equal(cleanValue("Mission: Impossible", "delete"), "Mission Impossible");
  assert.equal(cleanValue("Mission: Impossible", "dash"), "Mission- Impossible");
  assert.equal(cleanValue("Mission: Impossible", "spaceDash"), "Mission - Impossible");
  assert.equal(cleanValue('What? <Why> "Who" | 1/2'), "What Why Who  1-2".replace(/\s{2,}/g, " "));
  assert.equal(cleanValue("  Trailing. "), "Trailing");
  assert.equal(cleanValue("沙丘：第二部"), "沙丘：第二部", "全角冒号原样保留");
});

test("超长段：截标题不截扩展名", () => {
  const long = "很长".repeat(120);
  const r = renderTemplate("{title}.{ext}", { title: long, ext: "mkv" }, { maxSegmentBytes: 60 });
  assert.ok(r.path.endsWith(".mkv"));
  assert.ok(Buffer.byteLength(r.path, "utf8") <= 60);
});

test("模板校验：未知变量、括号不配对、缺 ext", () => {
  assert.deepEqual(validateTemplate(DEFAULT_TEMPLATES.tv), []);
  assert.match(validateTemplate("{titel}.{ext}")[0], /titel/);
  assert.match(validateTemplate("{title}[ - {year}.{ext}").join("\n"), /\[/);
  assert.match(validateTemplate("{title}").join("\n"), /ext/);
});

test("转义和 id 标签风格", () => {
  assert.equal(renderTemplate("\\[{title}\\].{ext}", { title: "A", ext: "mkv" }).path, "[A].mkv");
  assert.equal(idTagFor("emby", 1), "[tmdbid=1]");
  assert.equal(idTagFor("jellyfin", 1), "[tmdbid-1]");
  assert.equal(idTagFor("plex", 1), "{tmdb-1}");
  assert.equal(idTagFor("none", 1), "");
  assert.equal(idTagFor("emby", undefined), "");
});

test("兜底链和发布组后缀：{a|b} a 空就用 b，:. 把空格换成点", () => {
  const vars = { enTitle: "", originalTitle: "Dune: Part Two", title: "沙丘：第二部", year: "2024", resolution: "2160p", source: "WEB-DL", audio: "DDP 5.1 Atmos", group: "FLUX", ext: "mkv" };
  assert.equal(
    renderTemplate("{enTitle|originalTitle:.}.{year}[.{resolution}][.{source:.}][.{audio:.}][-{group}].{ext}", vars).path,
    "Dune.Part.Two.2024.2160p.WEB-DL.DDP.5.1.Atmos-FLUX.mkv",
  );
  assert.equal(renderTemplate("{enTitle|title}.{ext}", vars).path, "沙丘：第二部.mkv");
  assert.equal(renderTemplate("{title:_}.{ext}", { title: "Peter Rabbit", ext: "mkv" }).path, "Peter_Rabbit.mkv");
  assert.equal(renderTemplate("{title:-}.{ext}", { title: "Peter Rabbit", ext: "mkv" }).path, "Peter-Rabbit.mkv");
  assert.equal(renderTemplate("{title: .}.{ext}", { title: "Peter Rabbit", ext: "mkv" }).path, "Peter.Rabbit.mkv", "后缀两边的空格不算");
  // 可选段看的是兜底之后的值
  assert.equal(renderTemplate("{title}[ - {enTitle|edition:.}].{ext}", { title: "A", enTitle: "", edition: "", ext: "mkv" }).path, "A.mkv");
  assert.equal(renderTemplate("{title}[ - {enTitle|edition:.}].{ext}", { title: "A", enTitle: "", edition: "Director's Cut", ext: "mkv" }).path, "A - Directors.Cut.mkv");
});

test("发布组写法的标点：引号 / 逗号 / 叹号去掉，& 写成 and，冒号留下的横线丢掉", () => {
  assert.equal(releaseJoin("Mission - Impossible", "."), "Mission.Impossible");
  assert.equal(releaseJoin("Schindler's List", "."), "Schindlers.List");
  assert.equal(releaseJoin("Fast & Furious 9", "."), "Fast.and.Furious.9");
  assert.equal(releaseJoin("I, Robot!", "."), "I.Robot");
  assert.equal(releaseJoin("DTS-HD MA TrueHD 7.1 Atmos", "."), "DTS-HD.MA.TrueHD.7.1.Atmos");
  assert.equal(releaseJoin("WEB-DL", "."), "WEB-DL", "词里的连字符不动");
  assert.equal(renderTemplate("{title:.}.{ext}", { title: "Mission: Impossible", ext: "mkv" }, { colon: "smart" }).path, "Mission.Impossible.mkv");
});

test("模板校验：兜底链里的未知变量、坏后缀", () => {
  assert.deepEqual(validateTemplate("{enTitle|originalTitle:.}.{year}.{ext}"), []);
  assert.match(validateTemplate("{enTitle|titel:.}.{ext}")[0], /titel/);
  assert.match(validateTemplate("{title:x}.{ext}")[0], /后缀只能是/);
  assert.match(validateTemplate("{title:}.{ext}")[0], /后缀只能是/);
});

test("templateVarNames：兜底链、带后缀、可选段里的变量都算（探测要靠它判断模板用没用 {audio}）", () => {
  const names = templateVarNames("{category}/{title} ({year}) {idTag}/{enTitle|originalTitle:.}.{year}[.{resolution}][.{source:.}][.{audio:.}][-{group}].{ext}");
  assert.deepEqual([...names].sort(), ["audio", "category", "enTitle", "ext", "group", "idTag", "originalTitle", "resolution", "source", "title", "year"]);
  assert.ok(!templateVarNames("{title}.{ext}").has("audio"));
});
