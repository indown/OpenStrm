/**
 * 文件名解析的样本表：每条是一个真实风格的乱命名 + 期望解析出来的事实。
 * 加规则先在这里加样本；一条样本改坏了另一条，说明规则在打架。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/parse-name.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasReleaseNoise, isExtrasDirName, isNamedAfter, numericTitle, parseCjkNumber, parseMediaName, seasonDirNumber, stripSubtitleSuffix, titleCandidates, trailingNumber, type ParsedName, looksLikeReleaseDir } from "./parse-name.js";

type Expect = Partial<Omit<ParsedName, "tags" | "titles">> & { tags?: Partial<ParsedName["tags"]>; titles?: string[] };

const samples: Array<[string, Expect]> = [
  // 场景组 / PT 风格
  ["Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX", { title: "Dune Part Two", year: "2024", tags: { resolution: "2160p", source: "WEB-DL", audio: "DDP 5.1 Atmos", hdr: "DV", videoCodec: "H.265", group: "FLUX" } }],
  ["BEEF.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX", { title: "BEEF", season: 1, episode: 1, tags: { resolution: "1080p", source: "WEB-DL", videoCodec: "H.264", group: "XXX" } }],
  ["BEEF.S01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX", { title: "BEEF", season: 1, episode: undefined, cutoff: "season" }],
  ["Game.of.Thrones.S01E01.Winter.Is.Coming.1080p.BluRay.x265-RARBG", { title: "Game of Thrones", season: 1, episode: 1, tags: { source: "BluRay", videoCodec: "x265", group: "RARBG" } }],
  // 发布组写法：原盘 REMUX 叠在来源后面，音轨按出现顺序攒，声道 / MA 只跟在音频词后面才算
  ["Peter.Rabbit.2018.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.TrueHD.7.1.Atmos", { title: "Peter Rabbit", year: "2018", tags: { resolution: "2160p", source: "BluRay Remux", videoCodec: "HEVC", audio: "DTS-HD MA TrueHD 7.1 Atmos", group: undefined } }],
  ["Peter.Rabbit.2018.UHD.BluRay.2160p.DTS-HD.MA.TrueHD.7.1.Atmos.HEVC.REMUX-FraMeSToR", { title: "Peter Rabbit", year: "2018", tags: { source: "BluRay Remux", videoCodec: "HEVC", audio: "DTS-HD MA TrueHD 7.1 Atmos", group: "FraMeSToR" } }],
  ["Movie.2020.1080p.BDRemux.AVC.DTS-HD.MA.5.1-GROUP", { title: "Movie", year: "2020", tags: { source: "BluRay Remux", audio: "DTS-HD MA 5.1", group: "GROUP" } }],
  ["Movie.2020.1080p.WEB-DL.AC3-5.1.x264", { title: "Movie", year: "2020", tags: { audio: "AC3 5.1", videoCodec: "x264", group: undefined } }],
  ["Show.S01E01.1080p.WEB-DL.DD+5.1.H.264-GRP", { title: "Show", season: 1, episode: 1, tags: { audio: "DDP 5.1", videoCodec: "H.264", group: "GRP" } }],
  ["Movie.2020.1080p.BluRay.FLAC.2.0.x264-GRP", { title: "Movie", tags: { audio: "FLAC 2.0", group: "GRP" } }],
  ["Movie.2020.1080p.BluRay.DTS-HD.MA.7.1.x264", { title: "Movie", tags: { audio: "DTS-HD MA 7.1", videoCodec: "x264" } }],
  ["Movie.2020.7.1.1080p.BluRay.x264", { title: "Movie", year: "2020", tags: { audio: undefined, resolution: "1080p" } }],
  ["The.Bear.S03E01E02.1080p.WEB.h264-ETHEL", { title: "The Bear", season: 3, episode: 1, episodeEnd: 2 }],
  ["Show.Name.S02E05-E06.720p.HDTV", { title: "Show Name", season: 2, episode: 5, episodeEnd: 6 }],
  ["Blade.Runner.2049.2017.1080p.BluRay.x264", { title: "Blade Runner 2049", year: "2017" }],
  ["2012.2009.1080p.BluRay.x264-GROUP", { title: "2012", year: "2009", tags: { group: "GROUP" } }],
  ["1917 (2019)", { title: "1917", year: "2019" }],
  ["Avatar (2009)", { title: "Avatar", year: "2009" }],
  ["Avatar (2009)-cd1", { title: "Avatar", year: "2009", part: 1 }],
  ["Avatar 2009", { title: "Avatar", year: "2009" }],
  ["300 (2006) - 1080p", { title: "300", year: "2006", tags: { resolution: "1080p" } }],
  ["Blade.Runner.1982.Final.Cut.2160p.UHD.BluRay.x265", { title: "Blade Runner", year: "1982", edition: "Final Cut", tags: { resolution: "2160p" } }],
  ["The.Lord.of.the.Rings.2001.Extended.1080p", { title: "The Lord of the Rings", year: "2001", edition: "Extended" }],
  ["Ocean's Eleven 2001 1080p", { title: "Ocean's Eleven", year: "2001" }],
  ["The 100 S01E01", { title: "The 100", season: 1, episode: 1 }],
  ["Mr.Robot.S01E01.eps1.0_hellofriend.mov.1080p", { title: "Mr Robot", season: 1, episode: 1 }],
  ["Westworld 1x01 The Original", { title: "Westworld", season: 1, episode: 1 }],
  ["Frieren.Beyond.Journeys.End.S01E13.1080p", { title: "Frieren Beyond Journeys End", season: 1, episode: 13 }],
  ["Show.Name.2019.S01E01.1080p", { title: "Show Name", year: "2019", season: 1, episode: 1 }],
  ["Show.Name.S01E01.2019.1080p", { title: "Show Name", year: "2019", season: 1, episode: 1 }],
  ["The.Daily.Show.2020.01.31.1080p", { title: "The Daily Show", date: "2020-01-31" }],
  ["Conan.2019-11-14.Guest", { title: "Conan", date: "2019-11-14" }],
  ["movie.sample", { isSample: true }],
  ["Movie.2020.1080p-trailer", { title: "Movie", year: "2020", tags: { resolution: "1080p" } }],
  // 字幕组
  ["[Nekomoe kissaten][Sousou no Frieren][01][1080p][JPSC]", { title: "Sousou no Frieren", absolute: 1, tags: { group: "Nekomoe kissaten", resolution: "1080p" } }],
  ["[Nekomoe kissaten][Sousou no Frieren / 葬送的芙莉莲][13][1080p][JPSC]", { title: "葬送的芙莉莲", titles: ["葬送的芙莉莲", "Sousou no Frieren", "Sousou no Frieren / 葬送的芙莉莲"], absolute: 13 }],
  ["[ANi] 葬送的芙莉莲 - 01 [1080P][Baha][WEB-DL][AAC AVC][CHT]", { title: "葬送的芙莉莲", absolute: 1, tags: { group: "ANi", resolution: "1080p" } }],
  ["[SubsPlease] Sousou no Frieren - 28 (1080p) [ABC123]", { title: "Sousou no Frieren", absolute: 28 }],
  ["[Sakurato] Sousou no Frieren [01][AVC-8bit 1080p AAC][CHS]", { title: "Sousou no Frieren", absolute: 1 }],
  ["[LoliHouse] Kusuriya no Hitorigoto - 13 [WebRip 1080p HEVC-10bit AAC ASSx2].mkv".replace(".mkv", ""), { title: "Kusuriya no Hitorigoto", absolute: 13 }],
  ["Sousou no Frieren - 01v2 [1080p]", { title: "Sousou no Frieren", absolute: 1 }],
  ["[Group] Title [01-12][1080p]", { title: "Title", absolute: 1, absoluteEnd: 12 }],
  ["[Group] Title [SP01][1080p]", { title: "Title", isSpecial: true, episode: 1 }],
  ["[Group] Title [NCOP][1080p]", { title: "Title", isExtra: true }],
  ["[Group] Title [OVA][1080p]", { title: "Title", isSpecial: true }],
  // 中文
  ["权力的游戏.Game.of.Thrones.S01E01.1080p.BluRay.x265", { title: "权力的游戏", titles: ["权力的游戏", "Game of Thrones", "权力的游戏 Game of Thrones"], season: 1, episode: 1 }],
  ["怒呛人生S01E01", { title: "怒呛人生", season: 1, episode: 1 }],
  ["怒呛人生 第一季 第01集", { title: "怒呛人生", season: 1, episode: 1 }],
  ["怒呛人生 第一季 第1-2集", { title: "怒呛人生", season: 1, episode: 1, episodeEnd: 2 }],
  ["葬送的芙莉莲 第13话", { title: "葬送的芙莉莲", absolute: 13 }],
  ["葬送的芙莉莲2023", { title: "葬送的芙莉莲", year: "2023" }],
  ["流浪地球2.2023.4K.HDR.国语中字", { title: "流浪地球2", year: "2023", tags: { resolution: "4K", hdr: "HDR" } }],
  ["沙丘2.Dune.Part.Two.2024.2160p.国英双语.中字", { title: "沙丘2", titles: ["沙丘2", "Dune Part Two", "沙丘2 Dune Part Two"], year: "2024" }],
  ["三体 Three-Body (2023) S01E01", { title: "三体", titles: ["三体", "Three-Body", "三体 Three-Body"], year: "2023", season: 1, episode: 1 }],
  ["【高清剧集】漫长的季节.The.Long.Season.2023.S01.E01.1080p", { title: "漫长的季节", year: "2023", season: 1, episode: 1 }],
  ["繁花.Blossoms.Shanghai.2023.S01E01.2160p.WEB-DL.H265.DDP5.1-XXX@CMCT", { title: "繁花", year: "2023", season: 1, episode: 1, tags: { group: "XXX@CMCT" } }],
  ["请回答1988 E01", { title: "请回答1988", absolute: 1 }],
  ["请回答1988.S01E01.1080p", { title: "请回答1988", season: 1, episode: 1 }],
  ["EP01", { title: "", absolute: 1 }],
  ["E01", { title: "", absolute: 1 }],
  ["第01集", { title: "", absolute: 1 }],
  ["01", { title: "", absolute: 1 }],
  ["007", { title: "", absolute: 7 }],
  ["Some Show S01", { title: "Some Show", season: 1 }],
  ["Some Show Season 2", { title: "Some Show", season: 2 }],
  ["Some Show 2nd Season - 05", { title: "Some Show 2nd Season", absolute: 5 }],
  ["Movie Title 导演剪辑版 1080p", { title: "Movie Title", edition: "导演剪辑版" }],
  ["黑客帝国.The.Matrix.1999.Remastered.1080p", { title: "黑客帝国", year: "1999", edition: "Remastered" }],
  // 标题后面直接跟集数：补零的是集数；不补零的解析时不定（《流浪地球2》），交给单元按上下文判断
  ["我和僵尸有个约会01", { title: "我和僵尸有个约会", absolute: 1 }],
  ["我和僵尸有个约会01.1080p", { title: "我和僵尸有个约会", absolute: 1, tags: { resolution: "1080p" } }],
  ["某剧001", { title: "某剧", absolute: 1 }],
  ["某剧01-02", { title: "某剧", absolute: 1, absoluteEnd: 2 }],
  ["Some Show 01", { title: "Some Show", absolute: 1 }],
  ["我和僵尸有个约会10", { title: "我和僵尸有个约会10", absolute: undefined }],
  ["我和僵尸有个约会2.EP01", { title: "我和僵尸有个约会2", absolute: 1 }],
  ["流浪地球2", { title: "流浪地球2", absolute: undefined }],
  ["Class.of.09.2023", { title: "Class of 09", year: "2023", absolute: undefined }],
  ["名侦探柯南剧场版01", { title: "名侦探柯南剧场版01", absolute: undefined }],
  ["名侦探柯南 剧场版 01", { title: "名侦探柯南", edition: "剧场版", absolute: undefined }],
  // 中文分享包的目录名：发布信息粘在一起、演员 / 奖项 / 豆瓣分 / 体积跟在片名后面
  ["阿甘正传 4K原盘REMUX 杜比视界 国英双音 特效字幕", { title: "阿甘正传", tags: { resolution: "4K", source: "Remux" } }],
  ["阿甘正传4K原盘REMUX", { title: "阿甘正传", tags: { resolution: "4K", source: "Remux" } }],
  ["一次别离 奥斯卡提名 豆瓣8.8 蓝光原盘REMUX 26.38GB", { title: "一次别离", tags: { source: "BluRay Remux" } }],
  ["七宗罪 1995 布拉德皮特 豆瓣8.8 4K原盘REMUX", { title: "七宗罪", year: "1995" }],
  ["比得兔2 逃跑计划 4K原盘REMUX 国英双音", { title: "比得兔2 逃跑计划" }],
  ["沙丘 两部4K原盘REMUX 杜比视界 内封字幕", { title: "沙丘" }],
  ["漫威 复仇者联盟 全4部 4K原盘REMUX 国英双音", { title: "漫威 复仇者联盟" }],
  ["共助2  1080Web 内封字幕", { title: "共助2" }],
  ["越狱 全5季+番外 760G 原盘REMUX 终极收藏版", { title: "越狱" }],
  ["末日地堡 S01 2023 4K高码率 内封简英字幕 单集9G 共87.59G", { title: "末日地堡", year: "2023", season: 1 }],
  ["特工同盟 2024 4K Web SDR 内封简英双语字幕", { title: "特工同盟", year: "2024" }],
  ["怒火重案国粤双音", { title: "怒火重案" }],
  ["指环王 三部曲 4K", { title: "指环王" }],
  ["冰雪奇缘Ⅱ 4K原盘REMUX 杜比视界", { title: "冰雪奇缘Ⅱ", titles: ["冰雪奇缘Ⅱ", "冰雪奇缘2"], tags: { hdr: "DV" } }],
  ["与狼共舞 20周年加长版 蓝光原盘REMUX 内封字幕", { title: "与狼共舞" }],
  ["36总局 势不两立 法国 2025 奈飞 4K Web 杜比视界 精修简体中字", { title: "36总局 势不两立", year: "2025" }],
  ["乘船而去 华语 蓝光原盘REMUX 内封字幕", { title: "乘船而去" }],
  ["午夜凶铃1 日版1998 4K原盘REMUX 杜比视界 内封字幕", { title: "午夜凶铃1" }],
  // 正常片名里也有的字眼不能误伤
  ["法国贩毒网", { title: "法国贩毒网" }],
  ["中国英雄", { title: "中国英雄" }],
  ["四季", { title: "四季" }],
  ["一代宗师 2013", { title: "一代宗师", year: "2013" }],
  ["三十五岁在东京", { title: "三十五岁在东京" }],
  // 集号 / 日期后面的正文是集标题：里面的 making / menu / special / sample 不是花絮、特别篇的标记
  ["Hacks.S05E04.Whos.Making.Dinner.2160p.Stan.WEB-DL.DDP.5.1.H.265-BlackTV", { title: "Hacks", season: 5, episode: 4, isExtra: undefined, tags: { resolution: "2160p", group: "BlackTV" } }],
  ["Hacks - S05E04 - Who's Making Dinner", { title: "Hacks", season: 5, episode: 4, isExtra: undefined }],
  ["Show.S01E03.The.Christmas.Special.1080p.WEB-DL", { season: 1, episode: 3, isSpecial: undefined }],
  ["Show.S01E03.Free.Sample.1080p.WEB-DL", { season: 1, episode: 3, isSample: undefined }],
  ["Show.S00E01.Making.Of.1080p", { season: 0, episode: 1, isExtra: undefined }],
  ["Show - 05 - The Menu [1080p]", { title: "Show", absolute: 5, isExtra: undefined }],
  ["某剧 第03集 Making Of", { title: "某剧", absolute: 3, isExtra: undefined }],
  ["Conan.2019-11-14.Making.Friends", { title: "Conan", date: "2019-11-14", isExtra: undefined }],
  ["Show - S01E01 (Making Friends)", { season: 1, episode: 1, isExtra: undefined }],
  // 集号后面，技术词之后的、单独成段的还是标记
  ["show.s01e01.720p.hdtv.x264-grp.sample", { season: 1, episode: 1, isSample: true }],
  ["Show.S01E01.1080p.WEB-DL.Trailer", { season: 1, episode: 1, isExtra: true }],
  ["Show S01E05 (Preview)", { season: 1, episode: 5, isExtra: true }],
  ["[Group] Show - 01 [NCOP][1080p]", { title: "Show", absolute: 1, isExtra: true }],
  // 片名里的普通单词：后面还有年份 / 季集标记，标题没完，它是标题词
  ["The.Menu.2022.1080p.BluRay.x264", { title: "The Menu", year: "2022", isExtra: undefined }],
  ["The Menu (2022)", { title: "The Menu", year: "2022", isExtra: undefined }],
  ["菜单.The.Menu.2022.2160p.WEB-DL", { title: "菜单", titles: ["菜单", "The Menu", "菜单 The Menu"], year: "2022", isExtra: undefined }],
  ["Making.a.Murderer.S01E01.1080p.NF.WEB-DL", { title: "Making a Murderer", season: 1, episode: 1, isExtra: undefined }],
  ["Making.the.Cut.Season.2.1080p", { title: "Making the Cut", season: 2, isExtra: undefined }],
  ["Trailer Park Boys (2001)", { title: "Trailer Park Boys", year: "2001", isExtra: undefined }],
  ["Special.Ops.S01E01.1080p", { title: "Special Ops", season: 1, episode: 1, isSpecial: undefined }],
  ["Special (2019)", { title: "Special", year: "2019", isSpecial: undefined }],
  ["Sample.This.2012.1080p", { title: "Sample This", year: "2012", isSample: undefined }],
  // 后面只剩技术词 / 数字 / 什么都没有：照旧是花絮、特别篇；sp / ova / ncop 这种行话不看后面
  ["Dune.2024.Making.Of.1080p", { title: "Dune", year: "2024", isExtra: true }],
  ["Dune.2024.Trailer.2.1080p", { title: "Dune", year: "2024", isExtra: true }],
  ["Dune (2024) - Trailer", { title: "Dune", year: "2024", isExtra: true }],
  ["Show.Trailer", { title: "Show", isExtra: true }],
  ["making", { title: "", isExtra: true }],
  ["Show.S01.Special.1080p", { title: "Show", season: 1, isSpecial: true }],
  ["[Group] Show - Preview 05 [1080p]", { title: "Show", absolute: 5, isExtra: true }],
  ["[Group] Show Special [2015][BDRip]", { title: "Show", year: "2015", isSpecial: true }],
  ["孤独的美食家.SP.2019.1080p", { title: "孤独的美食家", year: "2019", isSpecial: true }],
  // 括号里整段是版本名：不是特别篇；括号里的版本名后面跟着的补零数字照旧是集数
  ["Star Wars (1977) (Special Edition)", { title: "Star Wars", year: "1977", isSpecial: undefined }],
  ["Blade Runner [Special Edition] 1982", { title: "Blade Runner", year: "1982", isSpecial: undefined }],
  ["某剧 [未删减版] 01", { title: "某剧", absolute: 1 }],
];

for (const [name, expect] of samples) {
  test(`解析：${name}`, () => {
    const p = parseMediaName(name);
    for (const [k, v] of Object.entries(expect)) {
      if (k === "tags") {
        for (const [tk, tv] of Object.entries(v as Record<string, string>)) {
          assert.equal((p.tags as Record<string, string | undefined>)[tk], tv, `${name} tags.${tk}`);
        }
        continue;
      }
      if (k === "titles") {
        assert.deepEqual(p.titles, v, `${name} titles`);
        continue;
      }
      assert.deepEqual((p as unknown as Record<string, unknown>)[k], v, `${name} ${k}（实际 ${JSON.stringify(p)}）`);
    }
  });
}

test("字幕后缀：语言和标记从末尾剥掉，主名保留", () => {
  assert.deepEqual(stripSubtitleSuffix("Movie.2020.zh-CN.forced"), { stem: "Movie.2020", lang: "zh-CN", forced: true });
  assert.deepEqual(stripSubtitleSuffix("Movie.chs"), { stem: "Movie", lang: "zh-CN" });
  assert.deepEqual(stripSubtitleSuffix("Movie.简体"), { stem: "Movie", lang: "zh-CN" });
  assert.deepEqual(stripSubtitleSuffix("Movie.cht"), { stem: "Movie", lang: "zh-TW" });
  assert.deepEqual(stripSubtitleSuffix("Movie.en.sdh"), { stem: "Movie", lang: "en", sdh: true });
  assert.deepEqual(stripSubtitleSuffix("Movie.2020"), { stem: "Movie.2020" });
  const p = parseMediaName("BEEF.S01E01.1080p.WEB-DL.chs", { subtitle: true });
  assert.equal(p.subtitleLang, "zh-CN");
  assert.equal(p.episode, 1);
});

test("标题候选：中文 / 英文 / 整段，中文优先", () => {
  assert.deepEqual(titleCandidates("权力的游戏 Game of Thrones"), ["权力的游戏", "Game of Thrones", "权力的游戏 Game of Thrones"]);
  assert.deepEqual(titleCandidates("Sousou no Frieren / 葬送的芙莉莲"), ["葬送的芙莉莲", "Sousou no Frieren", "Sousou no Frieren / 葬送的芙莉莲"]);
  assert.deepEqual(titleCandidates("BEEF"), ["BEEF"]);
  assert.deepEqual(titleCandidates("流浪地球2"), ["流浪地球2"]);
});

test("中文数字", () => {
  assert.equal(parseCjkNumber("一"), 1);
  assert.equal(parseCjkNumber("十"), 10);
  assert.equal(parseCjkNumber("十二"), 12);
  assert.equal(parseCjkNumber("二十"), 20);
  assert.equal(parseCjkNumber("二十三"), 23);
  assert.equal(parseCjkNumber("一百零一"), 101);
  assert.equal(parseCjkNumber("07"), 7);
  assert.equal(parseCjkNumber("abc"), null);
});

test("季目录 / 花絮目录", () => {
  assert.equal(seasonDirNumber("Season 1"), 1);
  assert.equal(seasonDirNumber("Season 01"), 1);
  assert.equal(seasonDirNumber("S02"), 2);
  assert.equal(seasonDirNumber("第三季"), 3);
  assert.equal(seasonDirNumber("第10季"), 10);
  assert.equal(seasonDirNumber("Specials"), 0);
  assert.equal(seasonDirNumber("Season 00"), 0);
  assert.equal(seasonDirNumber("SP"), 0);
  assert.equal(seasonDirNumber("怒呛人生"), null);
  assert.equal(seasonDirNumber("Extras"), null);
  assert.equal(isExtrasDirName("Featurettes"), true);
  assert.equal(isExtrasDirName("花絮"), true);
  assert.equal(isExtrasDirName("Season 1"), false);
});

test("有没有发布噪音：规范过的名字没有，原始命名有，集名里的普通词不算", () => {
  assert.equal(hasReleaseNoise("沙丘：第二部 (2024) - 2160p"), false);
  assert.equal(hasReleaseNoise("怒呛人生 - S01E01 - 飞鸟不鸣"), false);
  assert.equal(hasReleaseNoise("Charlotte's Web (2006)"), false);
  assert.equal(hasReleaseNoise("Cam (2018)"), false);
  assert.equal(hasReleaseNoise("Show - S01E01 - Web of Lies"), false);
  assert.equal(hasReleaseNoise("Dune (2024) - WEB-DL x265 [RARBG]"), false, "用户模板里带了来源 / 编码也是规范形状");
  assert.equal(hasReleaseNoise("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX"), true);
  assert.equal(hasReleaseNoise("Peter.Rabbit.2018.2160p.BluRay.REMUX"), true, "来源叠了 Remux 仍算强来源");
  assert.equal(hasReleaseNoise("[Nekomoe kissaten][Sousou no Frieren][01][1080p][JPSC]"), true);
  assert.equal(hasReleaseNoise("BEEF.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX"), true);
  assert.equal(hasReleaseNoise("Some Movie 2020"), false, "只是没有年份括号，不算噪音");
});

test("looksLikeReleaseDir：发布目录 vs 收件箱式目录", () => {
  for (const n of ["Captain.America.Brave.New.World.2025.2160p.WEB-DL.DD5.1.H264-COLLECTiVE", "Lord.of.the.Flies.S01.2160p.WEB-DL.H.265-HiveWeb", "亿万地堡（2025）", "钢铁之心(2025)4KHDR10", "[Nekomoe kissaten] Frieren S01", "Season 01", "season2", "Specials", "番外"]) {
    assert.equal(looksLikeReleaseDir(n), true, n);
  }
  for (const n of ["inbox", "downloads", "电影", "movie", "孤注一掷", "新下载"]) {
    assert.equal(looksLikeReleaseDir(n), false, n);
  }
});

test("名字里夹着看不见的字符（零宽空格 / BOM / 软连字符）：先去掉再解析", () => {
  const p = parseMediaName("回家的诱惑.2011.S01E\u200B36\u200B");
  assert.deepEqual([p.title, p.year, p.season, p.episode], ["回家的诱惑", "2011", 1, 36]);
  assert.equal(parseMediaName("\uFEFF怒呛人生S01E\u200D02").episode, 2);
  assert.equal(parseMediaName("Dune\u00AD.Part.Two.2024.2160p").title, "Dune Part Two");
  assert.equal(seasonDirNumber("Season\u200B 02"), 2);
  assert.equal(isExtrasDirName("花\u200B絮"), true);
  assert.equal(hasReleaseNoise("怒呛人生 - S01E\u200B01"), false, "规范形状里夹了零宽空格还是规范形状");
});

test("整个标题就是数字：是不是集数交给调用方", () => {
  assert.equal(numericTitle(parseMediaName("129 4K")), 129, "数字后面只剩技术词");
  assert.equal(numericTitle(parseMediaName("0129 4K")), 129, "前导零去掉");
  assert.equal(numericTitle(parseMediaName("007 1080p")), null, "补零的两位数解析时已经当集数了");
  assert.equal(numericTitle(parseMediaName("129")), null, "整名就是数字：解析时已经当集数了");
  assert.equal(numericTitle(parseMediaName("1917 4K")), null, "四位数不给");
  assert.equal(numericTitle(parseMediaName("2012 2009 1080p")), null, "名字里带年份的更像电影");
  assert.equal(numericTitle(parseMediaName("某剧 129 4K")), null, "还有别的标题词");
});

test("标题末尾的数字：拆成标题 + 数字，是不是集数交给调用方", () => {
  assert.deepEqual(trailingNumber(parseMediaName("我和僵尸有个约会10")), { number: 10, titles: ["我和僵尸有个约会"] });
  assert.deepEqual(trailingNumber(parseMediaName("Some Show 10")), { number: 10, titles: ["Some Show"] });
  assert.deepEqual(trailingNumber(parseMediaName("权力的游戏 Game of Thrones 10")), { number: 10, titles: ["权力的游戏", "Game of Thrones", "权力的游戏 Game of Thrones"] });
  assert.equal(trailingNumber(parseMediaName("请回答1988")), null, "四位数是标题的一部分");
  assert.equal(trailingNumber(parseMediaName("Blink182")), null, "英文字母后面直接粘数字的不算");
  assert.equal(trailingNumber(parseMediaName("名侦探柯南剧场版10")), null, "剧场版 N 是第 N 部电影");
  assert.equal(trailingNumber(parseMediaName("Dune Part 2")), null);
  assert.equal(trailingNumber(parseMediaName("我和僵尸有个约会01")), null, "已经认出集数的不再拆");
});

test("isNamedAfter：目录名解析出的片名就是识别出来的片名才算；包含、像发布目录、收件箱式的名字都不算", () => {
  const beef = ["怒呛人生", "BEEF", "Beef"];
  assert.equal(isNamedAfter("怒呛人生", beef), true, "中文片名");
  assert.equal(isNamedAfter("beef", beef), true, "原名，大小写不论");
  assert.equal(isNamedAfter("BEEF.S01.1080p.WEB-DL", beef), true, "发布目录去掉季、画质之后就是片名");
  assert.equal(isNamedAfter("怒呛人生 (2023)", beef), true, "带年份");
  assert.equal(isNamedAfter("怒呛人生 全集", beef), true, "「全集」「番外」这种标记词解析时就去掉了");
  assert.equal(isNamedAfter("怒呛人生和朋友们", beef), false, "多了词就不是：不按包含比");
  assert.equal(isNamedAfter("BEEF.S01.1080p", []), false, "像发布目录也得片名对得上");
  assert.equal(isNamedAfter("uploads", ["飞屋环游记", "Up"]), false, "uploads 不是《Up》");
  for (const n of ["inbox", "downloads", "电影", "蓝光", "Remux", "[待整理]", "美剧 2024", "Season 2"]) assert.equal(isNamedAfter(n, beef), false, n);
  assert.equal(isNamedAfter("美剧", ["美剧狂人"]), false, "片名里包含目录名不算：分类目录会被当成作品目录");
  assert.equal(isNamedAfter("A", ["A"]), false, "一个字的片名太容易撞，不认");
  assert.equal(isNamedAfter("怒呛人生", [undefined, ""]), false);
});

