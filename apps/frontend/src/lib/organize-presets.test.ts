/**
 *   pnpm --filter @openstrm/frontend test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TEMPLATES, SERVERS, STRUCTURES, buildTemplate, detectServer, detectStructure, serverFromIdTag } from "./organize-presets";
import { splitMovie, splitTv } from "./template-parts";

test("默认模板和后端 services/organize/settings.ts 的 DEFAULT_TEMPLATES 一字不差", () => {
  assert.equal(DEFAULT_TEMPLATES.movie, "{category}/{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}");
  assert.equal(DEFAULT_TEMPLATES.tv, "{category}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {episodeTitle}].{ext}");
});

test("结构 × 服务器生成模板：结构只动目录，服务器只动文件名细节", () => {
  assert.equal(buildTemplate("movie", "yearDir", "emby"), "{category}/{year}/{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}");
  assert.equal(buildTemplate("movie", "collection", "jellyfin"), "{category}/[{collection}/]{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}");
  assert.equal(buildTemplate("movie", "keepName", "plex"), "{category}/{title} ({year}) {idTag}/{originalName}.{ext}");
  assert.equal(buildTemplate("tv", "absolute", "emby"), "{category}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {absolute000}][ - {episodeTitle}].{ext}");
  assert.equal(buildTemplate("tv", "default", "plex"), "{category}/{title} ({year}) {idTag}/Season {season00}/{title} ({year}) - s{season00}e{episode00}[ - {episodeTitle}].{ext}");
  assert.equal(buildTemplate("tv", "keepName", "kodi"), "{category}/{title} ({year}) {idTag}/Season {season00}/{originalName}.{ext}");
  // 生成的每一条都能按层拆开、文件名那格没有斜杠
  for (const s of SERVERS) {
    for (const st of STRUCTURES.movie) assert.ok(!splitMovie(buildTemplate("movie", st.key, s.key))!.file.includes("/"), `${s.key}/${st.key}`);
    for (const st of STRUCTURES.tv) assert.equal(splitTv(buildTemplate("tv", st.key, s.key))!.season, "Season {season00}", `${s.key}/${st.key}`);
  }
});

test("反推：等于哪个结构就是哪个，改过一个字就是自定义；服务器要整套都对上", () => {
  for (const s of SERVERS) {
    for (const st of STRUCTURES.tv) assert.equal(detectStructure("tv", buildTemplate("tv", st.key, s.key), s.key), st.key);
    for (const st of STRUCTURES.movie) assert.equal(detectStructure("movie", `  ${buildTemplate("movie", st.key, s.key)}  `, s.key), st.key, "首尾空白不算改");
  }
  assert.equal(detectStructure("movie", DEFAULT_TEMPLATES.movie.replace("{edition}", "{source}"), "emby"), null);
  assert.equal(detectStructure("tv", buildTemplate("tv", "default", "plex"), "emby"), null, "Plex 的文件名在 Emby 下不是预设");

  const emby = { idTag: "emby" as const, specials: "season00" as const, extrasDir: "extras", movie: DEFAULT_TEMPLATES.movie, tv: buildTemplate("tv", "absolute", "emby") };
  assert.equal(detectServer(emby), "emby");
  assert.equal(detectServer({ ...emby, idTag: "jellyfin" }), "jellyfin", "模板一样，靠 id 标签分 Emby / Jellyfin");
  assert.equal(detectServer({ ...emby, specials: "specials" }), null, "特别篇目录名不对就不算 Emby");
  assert.equal(detectServer({ ...emby, movie: "{title}.{ext}" }), null);
  assert.equal(detectServer({ idTag: "plex", specials: "specials", extrasDir: "Other", movie: buildTemplate("movie", "yearDir", "plex"), tv: buildTemplate("tv", "default", "plex") }), "plex");
  assert.equal(detectServer({ idTag: "none", specials: "specials", extrasDir: "extras", movie: buildTemplate("movie", "default", "kodi"), tv: buildTemplate("tv", "default", "kodi") }), "kodi");
});

test("id 标签写法推服务器：自定义模板时预设按它生成文件名细节", () => {
  assert.equal(serverFromIdTag("emby"), "emby");
  assert.equal(serverFromIdTag("jellyfin"), "jellyfin");
  assert.equal(serverFromIdTag("plex"), "plex");
  assert.equal(serverFromIdTag("none"), "kodi");
  assert.equal(serverFromIdTag(undefined), "emby");
});
