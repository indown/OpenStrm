/**
 *   pnpm test:file src/services/organize/settings.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TEMPLATES, resolveOrganizeSettings } from "./settings.js";

test("任务自己的命名设定盖过全局：模板 / id 标签 / 集标题；留空的沿用全局；分类和识别词仍是全局的", () => {
  const settings = { organize: { templates: { movie: "{title}/{title}.{ext}", tv: "" }, idTag: "jellyfin" as const, episodeTitle: true, rules: ["a => b"] } };
  const global = resolveOrganizeSettings(settings);
  assert.equal(global.templates.movie, "{title}/{title}.{ext}");
  assert.equal(global.templates.tv, DEFAULT_TEMPLATES.tv);
  assert.equal(global.idTag, "jellyfin");
  assert.equal(global.episodeTitle, true);

  const own = resolveOrganizeSettings(settings, { organize: { templates: { tv: "{title}/S{season00}E{episode00}.{ext}", movie: "  " }, idTag: "plex", episodeTitle: false } });
  assert.equal(own.templates.movie, "{title}/{title}.{ext}", "任务上留空的电影模板沿用全局");
  assert.equal(own.templates.tv, "{title}/S{season00}E{episode00}.{ext}");
  assert.equal(own.idTag, "plex");
  assert.equal(own.episodeTitle, false, "任务上明确关掉就关");
  assert.deepEqual(own.rules, ["a => b"]);

  assert.deepEqual(resolveOrganizeSettings(settings, { organize: { libraryType: "tv" } }).templates, global.templates, "任务上没设就是全局");
  assert.deepEqual(resolveOrganizeSettings(settings, null).templates, global.templates);
});
