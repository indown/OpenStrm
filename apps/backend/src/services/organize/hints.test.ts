/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/hints.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizeHint } from "@openstrm/shared";
import { hintFor } from "./hints.js";
import { buildUnits, type ScopeEntry } from "./units.js";

const videoExts = new Set([".mkv", ".mp4"]);
const unitOf = (paths: string[]) => {
  const es: ScopeEntry[] = paths.map((p, i) => ({ path: p, isDir: false, id: `n${i}` }));
  const units = buildUnits(es, { scopePath: "", scopes: [""], taskRootName: "tv", videoExts, rules: [] });
  assert.equal(units.length, 1);
  return units[0];
};
const hint = (path: string, over: Partial<OrganizeHint> = {}): OrganizeHint => ({
  path, mediaType: "tv", tmdbId: 19389, season: 2, episodeOffset: 0, seasonFallback: null, titles: ["我和僵尸有个约会"], label: "僵尸", ...over,
});

test("单元的视频全被同一条提示覆盖、写了片名的都对得上：照它认；字幕、花絮不算", () => {
  const unit = unitOf(["某剧/我和僵尸有个约会.EP03.mkv", "某剧/03.mp4", "某剧/我和僵尸有个约会.EP03.chs.srt", "某剧/sample.mkv"]);
  const r = hintFor(unit, [hint("某剧/我和僵尸有个约会.EP03.mkv"), hint("某剧/03.mp4")]);
  assert.equal(r.hint?.tmdbId, 19389, r.note);
  assert.equal(r.note, undefined);
});

test("用不了的提示：只覆盖了一部分、几条不一样、片名对不上都不用，说一句为什么；没带提示的单元什么都不说；提示没记片名就不核对", () => {
  const unit = unitOf(["某剧/我和僵尸有个约会.EP03.mkv", "某剧/我和僵尸有个约会.EP04.mkv"]);
  assert.deepEqual(hintFor(unit, []), { hint: null });
  assert.deepEqual(hintFor(unit, [hint("别处/x.mkv")]), { hint: null });
  const partial = hintFor(unit, [hint("某剧/我和僵尸有个约会.EP03.mkv")]);
  assert.equal(partial.hint, null);
  assert.equal(partial.note, "这部作品里还有不是追更「僵尸」这次带来的文件，没沿用追更「僵尸」上次的整理");
  const mixed = hintFor(unit, [hint("某剧/我和僵尸有个约会.EP03.mkv"), hint("某剧/我和僵尸有个约会.EP04.mkv", { season: 3 })]);
  assert.deepEqual(mixed, { hint: null, note: "这批文件带的追更提示不一样，没沿用追更「僵尸」上次的整理" });
  const other = hintFor(unit, [hint("某剧/我和僵尸有个约会.EP03.mkv", { titles: ["beef"] }), hint("某剧/我和僵尸有个约会.EP04.mkv", { titles: ["beef"] })]);
  assert.deepEqual(other, { hint: null, note: "「我和僵尸有个约会.EP03.mkv」的片名和追更「僵尸」上次的整理对不上，没沿用" });
  const untitled = hintFor(unit, [hint("某剧/我和僵尸有个约会.EP03.mkv", { titles: [] }), hint("某剧/我和僵尸有个约会.EP04.mkv", { titles: [] })]);
  assert.equal(untitled.hint?.tmdbId, 19389);
});
