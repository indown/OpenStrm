/**
 * 文件名 / 目录名 → 结构化事实：标题、年份、季、集、绝对集数、版本标签、字幕语言。
 * 纯函数，不碰网络和设置；规则改动先过 parse-name.test.ts 的样本表。
 *
 * 思路：
 *   - 先把方括号段、日期、粘连的 CJK+S01E01 拆开，再按空格 / 点 / 下划线分词；
 *   - 从左到右扫，第一个「季集 / 年份 / 技术词 / 特别篇」标记切断标题，后面全是噪音；
 *   - 字幕组风格 `[Group][Title][01][1080p][JPSC]`：第一段是字幕组，纯数字段是绝对集数；
 *   - 标题里同时有中文和英文时给出多个候选，识别时依次去 TMDB 搜；
 *   - 零宽空格这类看不见的字符先去掉（分享里的文件名常夹着它们躲关键词过滤，`S01E\u200B36` 看着正常却认不出）；
 *   - 标题后面粘着的补零数字（`我和僵尸有个约会01`）是集数；不补零的（`流浪地球2`）和整个标题就是数字的（`129 4K`）
 *     解析时不定，见 `trailingNumber` / `numericTitle`；
 *   - 特别篇 / 花絮 / sample 的标记要看位置：集号后面、技术词前面的正文是集标题（`S05E04.Whos.Making.Dinner`），
 *     片名里后面还跟着年份 / 季集标记的普通单词是标题词（`The.Menu.2022`），都不算标记。
 */
import { stripInvisible } from "../../lib/text.js";

export interface ParsedTags {
  resolution?: string;
  source?: string;
  videoCodec?: string;
  audio?: string;
  hdr?: string;
  group?: string;
}

export type ParseCutoff = "episode" | "season" | "year" | "tech" | "date" | "special" | "extra" | "part" | "edition";

export interface ParsedName {
  /** 首选标题（有中文优先中文） */
  title: string;
  /** 依次尝试的标题候选：中文、英文、整段 */
  titles: string[];
  year?: string;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  /** 没有季标记的集数（字幕组的 [13]、`- 13`、`第13话`）：到底是第几季第几集要结合目录和 TMDB 判断 */
  absolute?: number;
  absoluteEnd?: number;
  isSpecial?: boolean;
  /** NCOP / PV / 花絮 / 预告 这类附加内容 */
  isExtra?: boolean;
  isSample?: boolean;
  /** 日播：YYYY-MM-DD */
  date?: string;
  part?: number;
  edition?: string;
  tags: ParsedTags;
  subtitleLang?: string;
  forced?: boolean;
  sdh?: boolean;
  cutoff?: ParseCutoff;
}

/* ------------------------------- 词表 ------------------------------- */

const RESOLUTION: Record<string, string> = {
  "2160p": "2160p", "1080p": "1080p", "1080i": "1080i", "720p": "720p", "576p": "576p", "480p": "480p",
  "4k": "4K", "8k": "8K", "uhd": "UHD", "2160": "2160p", "1080": "1080p", "720": "720p", "4320p": "4320p",
};
const SOURCE: Record<string, string> = {
  bluray: "BluRay", "blu-ray": "BluRay", bdrip: "BDRip", brrip: "BRRip", bdremux: "Remux", remux: "Remux",
  "web-dl": "WEB-DL", webdl: "WEB-DL", webrip: "WEBRip", web: "WEB", hdtv: "HDTV", hdtvrip: "HDTVRip", hdrip: "HDRip",
  dvdrip: "DVDRip", dvd: "DVD", uhdrip: "UHDRip", "uhd-bluray": "BluRay", hdcam: "HDCAM", hdts: "HDTS", cam: "CAM",
  dvdscr: "DVDSCR", screener: "Screener", 蓝光: "BluRay", 原盘: "Remux",
};
const VIDEO: Record<string, string> = {
  x264: "x264", x265: "x265", h264: "H.264", "h.264": "H.264", h265: "H.265", "h.265": "H.265", hevc: "HEVC",
  avc: "AVC", av1: "AV1", xvid: "XviD", divx: "DivX", vp9: "VP9", "10bit": "10bit", "8bit": "8bit", "10-bit": "10bit", hi10p: "Hi10P",
};
const AUDIO: Record<string, string> = {
  aac: "AAC", ac3: "AC3", eac3: "EAC3", "e-ac3": "EAC3", "e-ac-3": "EAC3", dd: "DD", "dd+": "DDP", ddp: "DDP", dts: "DTS",
  "dts-hd": "DTS-HD", dtshd: "DTS-HD", "dts-x": "DTS-X", dtsx: "DTS-X", truehd: "TrueHD", atmos: "Atmos", flac: "FLAC",
  opus: "Opus", mp3: "MP3", lpcm: "LPCM", pcm: "PCM", "aac2.0": "AAC", "aac5.1": "AAC", "ddp5.1": "DDP", "ddp2.0": "DDP",
  "dd5.1": "DD", "dd2.0": "DD", "ac3-5.1": "AC3",
};
const HDR: Record<string, string> = {
  hdr: "HDR", hdr10: "HDR10", "hdr10+": "HDR10+", hdr10plus: "HDR10+", dv: "DV", dovi: "DV", dolbyvision: "DV", sdr: "SDR", hlg: "HLG",
};
/** 只用来切断标题、不落进标签的噪音 */
const NOISE = new Set([
  "51", "71", "20", "51ch", "71ch", "20ch",
  "repack", "proper", "limited", "internal", "rerip", "complete", "multi", "multisub", "subbed", "dubbed", "dual", "dual-audio",
  "nfofix", "3d", "hsbs", "sbs", "hou", "60fps", "120fps", "24fps", "ma", "rip", "amzn", "nflx", "nf", "hmax", "max", "hulu",
  "dsnp", "dsny", "disney", "aptv", "atvp", "atv", "ami", "pcok", "pmtp", "itunes", "cr", "crunchyroll", "bilibili", "b-global",
  "baha", "ani", "viu", "iqiyi", "iq", "tencent", "youku", "mgtv", "hq", "fhd", "hd", "chs", "cht", "chi", "eng", "jpn", "jap",
  "kor", "ger", "fre", "ita", "spa", "rus", "jpsc", "jptc", "gb", "big5", "gb_jp", "big5_jp", "sc", "tc", "cn", "5.1", "7.1", "2.0",
  "6ch", "2ch", "8ch", "bit", "bits", "kbps", "hdr-x", "hqx", "hi-res", "web-rip", "webcap", "hc", "hardsub", "softsub",
  "国语", "粤语", "中字", "双语", "简中", "繁中", "简繁", "内封", "内嵌", "外挂", "中英", "中日", "英语", "日语", "韩语", "字幕", "特效",
  "简体", "繁体", "高清", "超清", "完结", "全集", "合集", "高码", "修复", "国粤", "台配", "国配", "官方", "无字", "生肉", "熟肉",
  "简日", "繁日", "简繁日", "简繁内封", "简体中字", "繁体中字", "中文字幕", "内嵌字幕", "外挂字幕", "更新至", "连载",
]);
/**
 * 中文分享包目录名里粘在一起的发布信息（`4K原盘REMUX`、`国英双音`、`内封简英字幕`、`豆瓣8.8`、`单集9G`、`全5季`、`两部4K…`）：
 * 含汉字的词里出现就当技术词，切断标题。只看含汉字的词，英文发布名照旧走上面的词表。
 * 正常片名里也会有的字眼卡严一点：「国英」要跟着双 / 音 / 字 / 语（「中国英雄」不算），中文数字加「季」不算（《四季》），
 * 国家 / 地区只认整个词（「36总局 势不两立 法国 2025」；《法国贩毒网》不算）
 */
const CJK_RELEASE =
  /原盘|remux|蓝光|bluray|杜比|全景声|双音|三音|音轨|双语|双字|国英[双音字语]|国粤[双音字语]|中英[双字]|简英|繁英|字幕|中字|高码|码率|豆瓣|评分|奥斯卡|金像|金马|金球|戛纳|提名|影帝|影后|单集|收藏版|珍藏版|典藏版|纪念版|周年|加长版|日版|美版|港版|台版|韩版|国版|意版|法版|英版|剪辑版|未删减|重制版|终极版|完整版|洗版|奈飞|网飞|4k|8k|2160p|1080p|720p|hdr|web-?dl|^共\d|^(?:法国|韩国|日本|美国|英国|德国|意大利|西班牙|泰国|印度|香港|台湾|大陆|国产|华语|欧美|日韩|俄罗斯|加拿大|澳大利亚|丹麦|瑞典|伊朗|巴西|墨西哥)$|^全[\d两二三四五六七八九十]+[季部集]|^\d+[季部集]|^[两二三四五六七八九十]部|\d(?:g|gb)$/;
/** 英文 / 数字粘在一起的技术词（`1080Web`、`4KHDR`）和体积（`760G`、`26.38GB`） */
const GLUED_TECH = /^(?:4k|8k|2160p?|1080p?|720p?)(?:web|bluray|remux|hdr|dv|sdr|hdtv|uhd)/;
const RE_SIZE = /^(?:\d{2,}|\d+\.\d+)(?:g|gb|t|tb)$/;

/** 粘在中文词里的发布信息顺手记成标签（整理的命名模板用得上） */
function cjkReleaseTags(w: string, tags: ParsedTags): void {
  if (/4k|2160p/.test(w)) tags.resolution ??= "4K";
  else if (/1080p/.test(w)) tags.resolution ??= "1080p";
  else if (/720p/.test(w)) tags.resolution ??= "720p";
  if (/remux|原盘/.test(w)) tags.source ??= "Remux";
  else if (/蓝光|bluray/.test(w)) tags.source ??= "BluRay";
  else if (/web-?dl/.test(w)) tags.source ??= "WEB-DL";
  if (/杜比视界/.test(w)) tags.hdr ??= "DV";
  else if (/hdr10\+/.test(w)) tags.hdr ??= "HDR10+";
  else if (/hdr/.test(w)) tags.hdr ??= "HDR";
}

/** 罗马数字（冰雪奇缘Ⅱ）：比对时当阿拉伯数字，搜 TMDB 时多给一个阿拉伯数字的候选 */
const ROMAN_DIGITS: Record<string, string> = {
  Ⅰ: "1", Ⅱ: "2", Ⅲ: "3", Ⅳ: "4", Ⅴ: "5", Ⅵ: "6", Ⅶ: "7", Ⅷ: "8", Ⅸ: "9", Ⅹ: "10", Ⅺ: "11", Ⅻ: "12",
  ⅰ: "1", ⅱ: "2", ⅲ: "3", ⅳ: "4", ⅴ: "5", ⅵ: "6", ⅶ: "7", ⅷ: "8", ⅸ: "9", ⅹ: "10", ⅺ: "11", ⅻ: "12",
};
const RE_ROMAN = /[Ⅰ-Ⅻⅰ-ⅻ]/g;
export const romanToArabic = (s: string): string => s.replace(RE_ROMAN, (ch) => ROMAN_DIGITS[ch] ?? ch);

const CJK_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 多词版本名：小写、按空格分好；顺序从长到短，先匹配长的 */
const EDITIONS: Array<{ words: string[]; label: string }> = [
  { words: ["director's", "cut"], label: "Director's Cut" },
  { words: ["directors", "cut"], label: "Director's Cut" },
  { words: ["final", "cut"], label: "Final Cut" },
  { words: ["extended", "cut"], label: "Extended" },
  { words: ["extended", "edition"], label: "Extended" },
  { words: ["theatrical", "cut"], label: "Theatrical" },
  { words: ["theatrical", "edition"], label: "Theatrical" },
  { words: ["ultimate", "edition"], label: "Ultimate Edition" },
  { words: ["ultimate", "cut"], label: "Ultimate Cut" },
  { words: ["special", "edition"], label: "Special Edition" },
  { words: ["collectors", "edition"], label: "Collector's Edition" },
  { words: ["collector's", "edition"], label: "Collector's Edition" },
  { words: ["anniversary", "edition"], label: "Anniversary Edition" },
  { words: ["open", "matte"], label: "Open Matte" },
  { words: ["extended"], label: "Extended" },
  { words: ["unrated"], label: "Unrated" },
  { words: ["uncut"], label: "Uncut" },
  { words: ["imax"], label: "IMAX" },
  { words: ["remastered"], label: "Remastered" },
  { words: ["criterion"], label: "Criterion" },
  { words: ["导演剪辑版"], label: "导演剪辑版" },
  { words: ["导剪版"], label: "导演剪辑版" },
  { words: ["加长版"], label: "加长版" },
  { words: ["未删减版"], label: "未删减版" },
  { words: ["未分级版"], label: "未分级版" },
  { words: ["剧场版"], label: "剧场版" },
  { words: ["终极剪辑版"], label: "终极剪辑版" },
  { words: ["修复版"], label: "修复版" },
];

const SUBTITLE_LANG: Record<string, string> = {
  "zh-cn": "zh-CN", "zh-hans": "zh-CN", zh: "zh-CN", chs: "zh-CN", chi: "zh-CN", zho: "zh-CN", sc: "zh-CN", 简: "zh-CN", 简体: "zh-CN",
  简中: "zh-CN", 中文: "zh-CN", chinese: "zh-CN", "chs&eng": "zh-CN", 简英: "zh-CN", 中英: "zh-CN", 简繁: "zh-CN", gb: "zh-CN",
  "zh-tw": "zh-TW", "zh-hant": "zh-TW", "zh-hk": "zh-HK", cht: "zh-TW", tc: "zh-TW", 繁: "zh-TW", 繁体: "zh-TW", 繁中: "zh-TW",
  "cht&eng": "zh-TW", 繁英: "zh-TW", big5: "zh-TW",
  en: "en", eng: "en", english: "en", 英文: "en", 英语: "en",
  ja: "ja", jp: "ja", jpn: "ja", japanese: "ja", 日文: "ja", 日语: "ja",
  ko: "ko", kor: "ko", korean: "ko", 韩文: "ko", 韩语: "ko",
  fr: "fr", fre: "fr", fra: "fr", french: "fr", de: "de", ger: "de", deu: "de", german: "de", es: "es", spa: "es", spanish: "es",
  ru: "ru", rus: "ru", russian: "ru", it: "it", ita: "it", italian: "it", pt: "pt", por: "pt", "pt-br": "pt-BR", th: "th", tha: "th",
  vi: "vi", vie: "vi", ar: "ar", ara: "ar", hi: "hi", hin: "hi",
};
const SUBTITLE_FLAGS = new Set(["forced", "default", "sdh", "cc", "hearing", "强制", "默认"]);

/* ------------------------------- 正则 ------------------------------- */

const RE_SXXEXX = /^s(\d{1,2})e(\d{1,4})(?:[-~]?e?(\d{1,4}))?$/i;
const RE_SXX = /^s(\d{1,2})$/i;
const RE_NXN = /^(\d{1,2})x(\d{1,3})$/i;
const RE_EXX = /^ep?(\d{1,4})(?:[-~]e?p?(\d{1,4}))?$/i;
const RE_CN_EP = /^第(\d{1,4}|[零〇一二两三四五六七八九十百]+)(?:[-~](\d{1,4}))?[集话話期回]$/;
const RE_CN_SEASON = /^第(\d{1,2}|[一二两三四五六七八九十]+)[季部]$/;
const RE_SEASON_WORD = /^season$/i;
const RE_SEASON_ATTACHED = /^season(\d{1,2})$/i;
const RE_YEAR = /^(19|20)\d{2}$/;
const RE_SPECIAL = /^(sp|special|specials|ova|oad|oav|特别篇|特別篇|番外|番外篇|sp\d{1,2}|ova\d{1,2}|oad\d{1,2})$/i;
const RE_SPECIAL_NUM = /^(?:sp|ova|oad)(\d{1,2})$/i;
const RE_EXTRA = /^(ncop|nced|pv|cm|menu|trailer|trailers|preview|featurette|featurettes|bts|making|makingof|behindthescenes|creditless)\d*$/i;
/** 上面几类标记里本身是普通单词的：也可能就是片名里的词（《The Menu》《Making a Murderer》《Special Ops》），要看位置，见 `titleGoesOn` */
const RE_WORD_MARKER = /^(special|specials|menu|trailer|trailers|preview|making|bts|sample)$/i;
const RE_PART = /^(?:part|pt|cd|disc|disk|dvd)[.\-_ ]?(\d{1,2})$/i;
const RE_PART_CN = /^(?:上|中|下)[部集]?$/;
const RE_TECH_GROUP = /^(.+?)-([A-Za-z0-9@_]{2,})$/;
const RE_AT_GROUP = /^@([A-Za-z0-9_]{2,})$/;
const RE_BARE_EP = /^(\d{1,3})(?:v\d)?$/;
const RE_BARE_EP_RANGE = /^(\d{1,3})[-~](\d{1,3})$/;
const RE_DATE = /(?<![\d])((?:19|20)\d{2})[.\-_ ](\d{2})[.\-_ ](\d{2})(?![\d])/;
const RE_CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
const RE_LATIN = /[A-Za-z]/;

/* ------------------------------- 小工具 ------------------------------- */

export function parseCjkNumber(s: string): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let current = 0;
  let sawTen = false;
  for (const ch of s) {
    if (ch === "十") {
      total += (current || 1) * 10;
      current = 0;
      sawTen = true;
      continue;
    }
    if (ch === "百") {
      total += (current || 1) * 100;
      current = 0;
      sawTen = true;
      continue;
    }
    const d = CJK_DIGITS[ch];
    if (d === undefined) return null;
    current = current * 10 + d;
  }
  total += current;
  return sawTen || s.length <= 3 || /^[零〇一二两三四五六七八九]+$/.test(s) ? total : null;
}

function lower(s: string): string {
  return s.toLowerCase();
}

type Chunk = { kind: "text"; value: string } | { kind: "bracket"; value: string };

/** 先把方括号 / 圆括号段拆出来，其余按分隔符分词。全角括号先换成半角 */
function chunk(input: string): Chunk[] {
  const s = input.replace(/【/g, "[").replace(/】/g, "]").replace(/（/g, "(").replace(/）/g, ")").replace(/｛/g, "{").replace(/｝/g, "}");
  const out: Chunk[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text.trim()) out.push({ kind: "text", value: text });
    text = "";
  };
  while (i < s.length) {
    const ch = s[i];
    const close = ch === "[" ? "]" : ch === "(" ? ")" : ch === "{" ? "}" : null;
    if (close) {
      const end = s.indexOf(close, i + 1);
      if (end !== -1) {
        flush();
        out.push({ kind: "bracket", value: s.slice(i + 1, end).trim() });
        i = end + 1;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** 被点号拆坏的技术词先粘回去：H.264 → H264、DDP5.1 → DDP5、DTS-HD.MA → DTS-HD、Blu-ray 已经带连字符不用管 */
function glueDottedTech(text: string): string {
  return text
    .replace(/\b([Hh])\.(26[45])\b/g, "$1$2")
    .replace(/\b(DDP|DD|AAC|AC3|EAC3|DTS|TrueHD|Atmos|FLAC|E-?AC-?3)(\d)\.(\d)\b/gi, "$1$2")
    .replace(/\b(\d)\.(\d)(ch)?\b/gi, "$1$2$3")
    .replace(/\bDTS-HD\.MA\b/gi, "DTS-HD")
    .replace(/\bWEB\.DL\b/gi, "WEB-DL")
    .replace(/\bBlu\.Ray\b/gi, "BluRay");
}

/** 文本段分词：空格 / 点 / 下划线；`Title - 01` 的 ` - ` 是强分隔，单独产出一个 "-" 记号 */
function splitWords(text: string): string[] {
  return glueDottedTech(text)
    .replace(/\s+-\s+/g, " - ")
    .split(/[\s._]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** CJK 和 `S01E01` / 年份 / `EP01` / 补零的集数粘在一起时拆开：`怒呛人生S01E01`、`葬送的芙莉莲2023`、`我和僵尸有个约会01` */
function unglue(s: string): string {
  return s
    .replace(/([぀-ヿ一-鿿가-힯])(?=[Ss]\d{1,2}[Ee]\d{1,4}\b)/g, "$1 ")
    // 补零的集数；`剧场版01` 是第 1 部电影，不拆
    .replace(/([぀-ヿ一-鿿가-힯])(?<!剧场版|劇場版|电影版|大电影)(?=0\d{1,2}(?:v\d)?(?:[-~]\d{1,3})?(?:$|[\s._\-[(【（]))/g, "$1 ")
    .replace(/([぀-ヿ一-鿿가-힯])(?=[Ee][Pp]?\d{1,4}\b)/g, "$1 ")
    .replace(/([぀-ヿ一-鿿가-힯])(?=(?:19|20)\d{2}\s*$)/g, "$1 ")
    .replace(/([぀-ヿ一-鿿가-힯])(?=第[零〇一二两三四五六七八九十百\d]+[季集话話期部回])/g, "$1 ")
    .replace(/(第[零〇一二两三四五六七八九十百\d]+[季集话話期部回])(?=[぀-ヿ一-鿿가-힯])/g, "$1 ")
    .replace(/\b((?:19|20)\d{2})(?=[぀-ヿ一-鿿])/g, "$1 ")
    // 片名和发布信息粘在一起（`阿甘正传4K原盘REMUX`、`怒火重案国粤双音`）：从发布信息那里拆开，片名才留得下来
    .replace(/([㐀-䶿一-鿿])(?=4k|8k|2160p|1080p|720p|原盘|remux|蓝光|杜比|国英[双音字语]|国粤[双音字语]|内封|中字|高码|豆瓣|单集|全\d{1,2}[季部集])/gi, "$1 ");
}

function stripEdges(w: string): string {
  return w.replace(/^[-–—~]+|[-–—~]+$/g, "");
}

/** 标题候选：`中文 / English`、`中文 English` 拆成多个，中文优先 */
export function titleCandidates(title: string): string[] {
  const out = titleCandidatesRaw(title);
  // 《冰雪奇缘Ⅱ》：TMDB 上叫「冰雪奇缘2」
  for (const c of [...out]) {
    const arabic = romanToArabic(c);
    if (arabic !== c && !out.includes(arabic)) out.push(arabic);
  }
  return out;
}

function titleCandidatesRaw(title: string): string[] {
  const t = title.trim();
  if (!t) return [];
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.replace(/\s+/g, " ").trim().replace(/^[-–—:：,，]+|[-–—:：,，]+$/g, "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  if (/\s*\/\s*/.test(t)) {
    const parts = t.split(/\s*\/\s*/).filter(Boolean);
    const cjk = parts.filter((p) => RE_CJK.test(p));
    for (const p of [...cjk, ...parts]) push(p);
    push(t);
    return out;
  }
  const hasCjk = RE_CJK.test(t);
  const hasLatin = RE_LATIN.test(t);
  if (hasCjk && hasLatin) {
    // 按词分：带 CJK 的词整个归中文（《沙丘2》的 2 跟着中文走），其余归英文
    const words = t.split(/\s+/);
    const cjkPart = words.filter((w) => RE_CJK.test(w)).join(" ");
    const latinPart = words.filter((w) => !RE_CJK.test(w)).join(" ");
    if (cjkPart.length >= 1) push(cjkPart);
    if (latinPart.replace(/[^A-Za-z]/g, "").length >= 2) push(latinPart);
  }
  push(t);
  return out;
}

/** 标题归一化（比对用）：小写、去标点和空白、全角转半角 */
export function normalizeTitle(s: string): string {
  return romanToArabic(s)
    .toLowerCase()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-–—_.,:：;；!！?？'’"“”()（）[\]【】《》「」『』·・&+]/g, "")
    .replace(/^the/, "");
}

/* ------------------------------- 字幕语言 ------------------------------- */

interface SubtitleSuffix {
  stem: string;
  lang?: string;
  forced?: boolean;
  sdh?: boolean;
}

/** 从字幕文件的主名末尾剥语言 / 标记段：`Movie.zh-CN.forced` → stem Movie */
export function stripSubtitleSuffix(stem: string): SubtitleSuffix {
  const parts = stem.split(".");
  const out: SubtitleSuffix = { stem };
  while (parts.length > 1) {
    const last = lower(parts[parts.length - 1].trim());
    if (SUBTITLE_FLAGS.has(last)) {
      if (last === "forced" || last === "强制") out.forced = true;
      else if (last === "sdh" || last === "cc" || last === "hearing") out.sdh = true;
      parts.pop();
      continue;
    }
    const lang = SUBTITLE_LANG[last];
    if (lang && !out.lang) {
      out.lang = lang;
      parts.pop();
      continue;
    }
    break;
  }
  out.stem = parts.join(".");
  return out;
}

/* ------------------------------- 主流程 ------------------------------- */

export interface ParseOptions {
  /** 字幕文件：先剥语言段 */
  subtitle?: boolean;
}

export function parseMediaName(rawName: string, opts: ParseOptions = {}): ParsedName {
  const result: ParsedName = { title: "", titles: [], tags: {} };
  let name = stripInvisible(rawName ?? "").trim();
  if (!name) return result;

  if (opts.subtitle) {
    const sub = stripSubtitleSuffix(name);
    name = sub.stem;
    if (sub.lang) result.subtitleLang = sub.lang;
    if (sub.forced) result.forced = true;
    if (sub.sdh) result.sdh = true;
  }

  // 日播日期先摘掉，不然分词会把它拆成三段数字
  const dateMatch = RE_DATE.exec(name);
  if (dateMatch) {
    result.date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    name = name.replace(dateMatch[0], " DATEMARK ");
  }
  name = unglue(name);

  // 整个名字就是一个 1-3 位数字（01.mkv / 第 07 集那种散集）：它是集数，不是标题
  const bare = /^0*(\d{1,3})(?:v\d)?$/.exec(name.trim());
  if (bare && !dateMatch) {
    result.absolute = Number(bare[1]);
    result.cutoff = "episode";
    return result;
  }

  const chunks = chunk(name);
  const animeStyle = chunks.length >= 2 && chunks[0].kind === "bracket" && chunks.filter((c) => c.kind === "bracket").length >= 2 && /^\s*\[/.test(name.trim());

  /** 标题词；bracket 段的标题也进这里 */
  const titleWords: string[] = [];
  let cut = false;
  let yearBeforeCut: string | undefined;
  let yearAfterCut: string | undefined;
  /** 集号 / 日期之后、技术词之前的正文是集标题（`S05E04.Whos.Making.Dinner.2160p`）：里面的词不是标记 */
  let episodeTitle = false;
  const cutAt = (why: ParseCutoff) => {
    if (why === "tech") episodeTitle = false;
    if (!cut) {
      cut = true;
      result.cutoff = why;
    }
  };
  const setEpisode = (ep: number, end?: number) => {
    if (result.episode === undefined) {
      result.episode = ep;
      if (end !== undefined && end > ep) result.episodeEnd = end;
      episodeTitle = true;
    }
  };
  const setAbsolute = (ep: number, end?: number) => {
    if (result.absolute === undefined && result.episode === undefined) {
      result.absolute = ep;
      if (end !== undefined && end > ep) result.absoluteEnd = end;
      episodeTitle = true;
    }
  };
  const setSeason = (n: number) => {
    if (result.season === undefined) result.season = n;
  };

  /** 认技术词 / 噪音；认出来返回 true（并记标签） */
  const tech = (word: string): boolean => {
    const w = lower(word);
    if (RESOLUTION[w]) {
      result.tags.resolution ??= RESOLUTION[w];
      return true;
    }
    if (SOURCE[w]) {
      result.tags.source ??= SOURCE[w];
      return true;
    }
    if (VIDEO[w]) {
      result.tags.videoCodec ??= VIDEO[w];
      return true;
    }
    if (AUDIO[w]) {
      result.tags.audio ??= AUDIO[w];
      return true;
    }
    if (HDR[w]) {
      result.tags.hdr ??= HDR[w];
      return true;
    }
    if (NOISE.has(w)) return true;
    // 2160p.WEB-DL 已经拆开；`DDP5.1` 被点拆成 ddp5 / 1，`DDP5` 也认
    if (/^(ddp|dd|aac|ac3|eac3|dts|truehd|atmos|flac)\d{1,2}(\.\d)?(ch)?$/.test(w)) {
      result.tags.audio ??= AUDIO[w.replace(/\d.*$/, "")] ?? w.toUpperCase();
      return true;
    }
    if (/^\d{1,2}bit$/.test(w)) return true;
    if (/^\d+fps$/.test(w)) return true;
    if (/^v\d$/.test(w)) return true;
    if (RE_CJK.test(w) && CJK_RELEASE.test(w)) {
      cjkReleaseTags(w, result.tags);
      return true;
    }
    if (GLUED_TECH.test(w) || RE_SIZE.test(w)) return true;
    return false;
  };

  /** 一个词是不是标记（季集 / 年份 / 特别篇 …），是就登记并切断。`inTitle`：这个词在标题 / 集标题的正文里，不当特别篇 / 花絮 / sample 的标记 */
  const marker = (word: string, ctx: { bracket: boolean; afterDash: boolean; nextIsTech: boolean; atEnd?: boolean; inTitle?: boolean }): boolean => {
    const w = stripEdges(word);
    if (!w) return false;
    let m: RegExpExecArray | null;
    if ((m = RE_SXXEXX.exec(w))) {
      setSeason(Number(m[1]));
      setEpisode(Number(m[2]), m[3] ? Number(m[3]) : undefined);
      cutAt("episode");
      return true;
    }
    if ((m = RE_NXN.exec(w))) {
      setSeason(Number(m[1]));
      setEpisode(Number(m[2]));
      cutAt("episode");
      return true;
    }
    if ((m = RE_SXX.exec(w))) {
      setSeason(Number(m[1]));
      cutAt("season");
      return true;
    }
    if ((m = RE_SEASON_ATTACHED.exec(w))) {
      setSeason(Number(m[1]));
      cutAt("season");
      return true;
    }
    if ((m = RE_CN_SEASON.exec(w))) {
      const n = parseCjkNumber(m[1]);
      if (n !== null) {
        setSeason(n);
        cutAt("season");
        return true;
      }
    }
    if ((m = RE_CN_EP.exec(w))) {
      const n = parseCjkNumber(m[1]);
      if (n !== null) {
        if (result.season !== undefined) setEpisode(n, m[2] ? Number(m[2]) : undefined);
        else setAbsolute(n, m[2] ? Number(m[2]) : undefined);
        cutAt("episode");
        return true;
      }
    }
    if ((m = RE_EXX.exec(w)) && (w.length >= 3 || /^e\d{2,}$/i.test(w))) {
      const n = Number(m[1]);
      if (result.season !== undefined) setEpisode(n, m[2] ? Number(m[2]) : undefined);
      else setAbsolute(n, m[2] ? Number(m[2]) : undefined);
      cutAt("episode");
      return true;
    }
    if (!ctx.inTitle) {
      if (RE_SPECIAL.test(w)) {
        result.isSpecial = true;
        const sm = RE_SPECIAL_NUM.exec(w);
        if (sm) setEpisode(Number(sm[1]));
        cutAt("special");
        return true;
      }
      if (RE_EXTRA.test(w)) {
        result.isExtra = true;
        cutAt("extra");
        return true;
      }
      if (lower(w) === "sample") {
        result.isSample = true;
        cutAt("extra");
        return true;
      }
    }
    if ((m = RE_PART.exec(w))) {
      result.part ??= Number(m[1]);
      cutAt("part");
      return true;
    }
    if (w === "DATEMARK") {
      episodeTitle = true;
      cutAt("date");
      return true;
    }
    if (RE_YEAR.test(w)) {
      if (cut) {
        yearAfterCut ??= w;
        return true;
      }
      // 标题开头的年份（《2012》《1917》）先当标题，后面再有年份或技术词再定
      if (titleWords.length === 0 && !ctx.bracket) {
        titleWords.push(w);
        return true;
      }
      // 已经有一个年份在前、又来一个：前一个属于标题（《银翼杀手 2049 2017》）
      if (yearBeforeCut !== undefined) {
        titleWords.push(yearBeforeCut);
        yearBeforeCut = w;
        return true;
      }
      yearBeforeCut = w;
      return true;
    }
    // 字幕组风格的 [01] / [01-12]、`- 01`；带前导零的 `01 [1080p]`、名字最后的 `某剧 01` / `某剧 01-02`（`剧场版 01` 是第 1 部电影，不算）
    const paddedTail = /^0\d{1,2}(?:v\d|[-~]\d{1,3})?$/.test(w) && (ctx.nextIsTech || (!!ctx.atEnd && result.edition === undefined));
    if (ctx.bracket || ctx.afterDash || paddedTail) {
      if ((m = RE_BARE_EP_RANGE.exec(w))) {
        setAbsolute(Number(m[1]), Number(m[2]));
        cutAt("episode");
        return true;
      }
      if ((m = RE_BARE_EP.exec(w)) && (ctx.bracket || /^\d/.test(w))) {
        setAbsolute(Number(m[1]));
        cutAt("episode");
        return true;
      }
    }
    if (tech(w)) {
      cutAt("tech");
      return true;
    }
    // x265-FLUX / AAC-PTHweb：技术词带组名后缀
    const tg = RE_TECH_GROUP.exec(w);
    if (tg && tech(tg[1])) {
      result.tags.group ??= tg[2];
      cutAt("tech");
      return true;
    }
    const ag = RE_AT_GROUP.exec(w);
    if (ag) {
      result.tags.group ??= ag[1];
      cutAt("tech");
      return true;
    }
    if (RE_PART_CN.test(w) && titleWords.length > 0 && ctx.nextIsTech) {
      cutAt("part");
      return true;
    }
    return false;
  };

  /** 多词版本名：从当前位置起看能不能凑上 */
  const editionAt = (words: string[], i: number): { label: string; len: number } | null => {
    for (const e of EDITIONS) {
      if (e.words.every((w, k) => lower(words[i + k] ?? "") === w)) return { label: e.label, len: e.words.length };
    }
    return null;
  };

  const isTechWord = (w: string): boolean => {
    const s = lower(stripEdges(w));
    return !!(RESOLUTION[s] || SOURCE[s] || VIDEO[s] || AUDIO[s] || HDR[s] || NOISE.has(s)) || (RE_CJK.test(s) && CJK_RELEASE.test(s)) || GLUED_TECH.test(s) || RE_SIZE.test(s);
  };

  /** 这个词本身就是标题的终点：年份、季集标记、日期 */
  const endsTitle = (w: string): boolean =>
    RE_YEAR.test(w) || RE_SXXEXX.test(w) || RE_NXN.test(w) || RE_SXX.test(w) || RE_SEASON_ATTACHED.test(w) || RE_CN_SEASON.test(w) || RE_CN_EP.test(w) || (RE_EXX.test(w) && w.length >= 3) || w === "DATEMARK";

  /**
   * 标题还没完：后面还有年份 / 季集标记，中间没隔着技术词（`The.Menu.2022`、`Making.a.Murderer.S01E01`、`The Menu (2022)`）。
   * 这时候 menu / making / special 这种普通单词是标题里的词；后面只剩技术词或什么都没有的（`Dune.2024.Trailer.1080p`、
   * `Show.Trailer`）才是标记。字幕组风格里方括号的年份不算，`[Group] Show Special [2015]` 照旧是特别篇
   */
  const titleGoesOn = (words: string[], i: number, ci: number): boolean => {
    for (let k = i + 1; k < words.length; k++) {
      const w = stripEdges(words[k]);
      if (!w) continue;
      if (endsTitle(w) || (RE_SEASON_WORD.test(w) && /^\d{1,2}$/.test(words[k + 1] ?? ""))) return true;
      if (isTechWord(w)) return false;
    }
    const next = chunks[ci + 1];
    return !animeStyle && next?.kind === "bracket" && endsTitle(next.value.trim());
  };

  let bracketIndex = 0;
  let groupFromBracket: string | undefined;
  // 非字幕组风格、开头一个方括号段后面紧跟正文：【高清剧集】【4K】这类站点标签，扔掉
  const leadingTag = !animeStyle && chunks.length >= 2 && chunks[0].kind === "bracket" && chunks[1].kind === "text" && !RE_YEAR.test(chunks[0].value.trim());
  chunks.forEach((c, ci) => {
    if (c.kind === "bracket") {
      const inner = c.value.trim();
      bracketIndex++;
      if (!inner) return;
      if (leadingTag && ci === 0) return;
      // 字幕组风格：第一段是组名
      if (animeStyle && bracketIndex === 1 && !RE_YEAR.test(inner) && !RE_BARE_EP.test(inner)) {
        groupFromBracket = inner;
        return;
      }
      const words = splitWords(inner);
      // 整段是一个标记（[01]、[2024]、[1080p]、[Nekomoe kissaten]）
      if (words.length === 1 || /^\d{1,3}[-~]\d{1,3}$/.test(inner) || /^(19|20)\d{2}$/.test(inner)) {
        if (marker(inner.replace(/\s+/g, ""), { bracket: true, afterDash: false, nextIsTech: false })) return;
        if (words.length === 1 && marker(words[0], { bracket: true, afterDash: false, nextIsTech: false })) return;
      }
      // 多词的段：全是技术词就整段当噪音；否则若还没切断就是标题（字幕组的 [Sousou no Frieren]）。
      // 集号后面的多词段是集标题（`S01E01 (Making Friends)`）、整段是个版本名的（`(Special Edition)`），里面的词都不是特别篇 / 花絮的标记
      const inTitle = episodeTitle || editionAt(words, 0)?.len === words.length;
      const allTech = words.every((w) => isTechWord(w) || marker(w, { bracket: true, afterDash: false, nextIsTech: true, inTitle }));
      if (allTech) {
        cutAt("tech");
        return;
      }
      if (!cut) {
        // 圆括号里的年份：`Name (2024)`
        if (RE_YEAR.test(inner)) {
          yearBeforeCut = inner;
          return;
        }
        if (titleWords.length === 0 || animeStyle) {
          if (titleWords.length === 0) titleWords.push(...words.filter((w) => !isTechWord(w)));
          return;
        }
        // 标题后面括号里的东西（别名、副标题）：先切断，避免把它当技术词
        cutAt("tech");
      }
      return;
    }
    const words = splitWords(c.value);
    let afterDash = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === "-") {
        afterDash = titleWords.length > 0;
        continue;
      }
      const nextIsTech = i + 1 < words.length ? isTechWord(words[i + 1]) : ci + 1 < chunks.length && chunks[ci + 1].kind === "bracket";
      const atEnd = i === words.length - 1 && ci === chunks.length - 1;
      if (!cut) {
        const ed = editionAt(words, i);
        if (ed && (titleWords.length > 0 || yearBeforeCut)) {
          result.edition ??= ed.label;
          cutAt("edition");
          i += ed.len - 1;
          continue;
        }
      } else if (result.edition === undefined) {
        const ed = editionAt(words, i);
        if (ed) {
          result.edition = ed.label;
          i += ed.len - 1;
          continue;
        }
      }
      if (RE_SEASON_WORD.test(w) && i + 1 < words.length && /^\d{1,2}$/.test(words[i + 1])) {
        setSeason(Number(words[i + 1]));
        cutAt("season");
        i++;
        continue;
      }
      const inTitle = episodeTitle || (!cut && RE_WORD_MARKER.test(stripEdges(w)) && titleGoesOn(words, i, ci));
      if (marker(w, { bracket: false, afterDash, nextIsTech, atEnd, inTitle })) {
        afterDash = false;
        continue;
      }
      afterDash = false;
      // 中文包：年份后面跟着的汉字词是演员、卖点（「七宗罪 1995 布拉德皮特」），标题到年份为止
      if (!cut && yearBeforeCut !== undefined && titleWords.length > 0 && RE_CJK.test(w)) {
        cutAt("year");
        continue;
      }
      if (!cut) titleWords.push(w);
      else if (result.tags.group === undefined && i === words.length - 1 && ci === chunks.length - 1 && /^-[A-Za-z0-9@_]{2,}$/.test(w)) {
        result.tags.group = w.slice(1);
      }
    }
  });

  if (groupFromBracket && result.tags.group === undefined) result.tags.group = groupFromBracket;
  result.year = yearBeforeCut ?? yearAfterCut;
  // 没切断、标题最后一个词是年份（《Avatar 2009》）：它就是年份
  if (!cut && result.year === undefined && titleWords.length > 1 && RE_YEAR.test(titleWords[titleWords.length - 1])) {
    result.year = titleWords.pop();
  }

  const title = titleWords
    .map(stripEdges)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:：,，.]+|[\s\-–—:：,，.]+$/g, "")
    .trim();
  result.titles = titleCandidates(title);
  result.title = result.titles[0] ?? "";
  return result;
}

/* ------------------------------- 标题末尾的数字 ------------------------------- */

const RE_TRAILING_CJK_NUMBER = /^(.*[぀-ヿ㐀-䶿一-鿿가-힯])(\d{1,3})$/;
const RE_TRAILING_WORD_NUMBER = /^(.*\S)\s+(\d{1,3})$/;
/** 这些词后面的数字是标题的一部分：Part 2、Vol 3、剧场版 5 */
const RE_NUMBERED_TAIL = /(?:part|pt|vol|volume|chapter|剧场版|劇場版|电影版|大电影)$/i;

export interface TrailingNumber {
  number: number;
  /** 去掉数字之后的标题候选 */
  titles: string[];
}

/**
 * 标题末尾的数字：`我和僵尸有个约会10` → 我和僵尸有个约会 + 10、`Some Show 10` → Some Show + 10。
 * 单看一个名字分不清它是集数还是标题的一部分（《流浪地球2》《速度与激情10》），所以解析时不动它，
 * 由调用方按上下文决定（季目录、同目录的兄弟、TMDB 认成剧集）。英文字母后面直接粘数字的（`Blink182`）不算
 */
export function trailingNumber(p: ParsedName): TrailingNumber | null {
  if (p.episode !== undefined || p.absolute !== undefined) return null;
  // 候选的最后一个是整段标题（中英混排时前面是拆出来的中文 / 英文）
  const full = p.titles[p.titles.length - 1] ?? p.title;
  const m = RE_TRAILING_CJK_NUMBER.exec(full) ?? RE_TRAILING_WORD_NUMBER.exec(full);
  if (!m) return null;
  const base = m[1].trim();
  const number = Number(m[2]);
  if (number === 0 || (!RE_CJK.test(base) && !RE_LATIN.test(base)) || RE_NUMBERED_TAIL.test(base)) return null;
  const titles = titleCandidates(base);
  return titles.length > 0 ? { number, titles } : null;
}

/** 整个标题就是一个 1-3 位数字 */
const RE_NUMERIC_TITLE = /^0*(\d{1,3})$/;

/**
 * 标题整个就是一个数字（`129 4K.mp4` 的 129、`130 4K.mp4` 的 130）：整名就是数字时（`129.mp4`）解析时就当集数，
 * 后面粘着画质 / 来源这些技术词就不敢定了——《1917》《2012》也是这个形状。和 `trailingNumber` 一样交给调用方按上下文决定
 * （在季目录里、或者上级目录就是这部作品）。名字里自带年份的（`129 2023 1080p`）更像电影，不给。
 */
export function numericTitle(p: ParsedName): number | null {
  if (p.episode !== undefined || p.absolute !== undefined || p.isSpecial || p.date || p.year) return null;
  const m = RE_NUMERIC_TITLE.exec(p.title.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * 名字整个就是一个版本词（`导演剪辑版`、`加长版`、`Extended`）：这是版本，不是作品名。
 * 解析时切不断（标题不能为空，第一个词只能留给标题），所以单独给调用方一个问法——
 * 目录叫这个名字时别拿它当片名去搜（`凡人修仙传/导演剪辑版/…` 会搜出一部真叫《导演剪辑版》的电影）
 */
export function isEditionOnlyName(name: string): boolean {
  const words = lower(stripInvisible(name).trim()).split(/[\s._-]+/).filter(Boolean);
  return words.length > 0 && EDITIONS.some((e) => e.words.length === words.length && e.words.every((w, i) => w === words[i]));
}

/* ------------------------------- 目录名 ------------------------------- */

const RE_SEASON_DIR = /^(?:season|s|series)[\s._-]*(\d{1,2})$|^第(\d{1,2}|[一二两三四五六七八九十]+)[季部]$/i;
const RE_SPECIALS_DIR = /^(?:specials?|sp|ova|oad|extras?|特别篇|特別篇|番外|番外篇|season[\s._-]*0+|s0+)$/i;
const RE_EXTRAS_DIR = /^(?:extras?|featurettes?|trailers?|behind[\s._-]*the[\s._-]*scenes|deleted[\s._-]*scenes|interviews?|scenes?|shorts?|samples?|other|花絮|预告|其他|其它|附赠|特典|cd|menu|bonus|bdmv|certificate)$/i;

/** 季目录：Season 1 / S01 / 第一季 → 季号；Specials / SP / 番外 → 0；不是季目录返回 null */
export function seasonDirNumber(name: string): number | null {
  const n = stripInvisible(name).trim();
  if (RE_SPECIALS_DIR.test(n)) return RE_EXTRAS_DIR.test(n) ? null : 0;
  const m = RE_SEASON_DIR.exec(n);
  if (!m) return null;
  if (m[1]) return Number(m[1]);
  return parseCjkNumber(m[2]);
}

/** 花絮目录：里面的东西不是正片 */
export function isExtrasDirName(name: string): boolean {
  return RE_EXTRAS_DIR.test(stripInvisible(name).trim());
}

const RE_ART_DIR = /^(?:extrafanart|extrathumbs|\.actors)$/i;

/** 艺术图目录：extrafanart / extrathumbs / .actors，里面是作品的图片，整理时整个跟进作品目录 */
export function isArtDirName(name: string): boolean {
  return RE_ART_DIR.test(stripInvisible(name).trim());
}

const RE_CANONICAL_MOVIE = /^.+ \((?:19|20)\d{2}\)(?: - .+)?(?:-part\d+)?$/;
const RE_CANONICAL_TV = /^.+ - S\d{2}E\d{2,4}(?:-E\d{2,4})?(?: - .+)?$/;
/** 只有这些来源词才算「发布噪音」：`WEB`、`CAM`、`DVD` 这种也是普通词，放进标题里太常见 */
const STRONG_SOURCE = new Set(["WEB-DL", "WEBRip", "BluRay", "BDRip", "BRRip", "Remux", "HDTV", "HDTVRip", "HDRip", "DVDRip", "UHDRip", "HDCAM", "HDTS", "DVDSCR"]);

/**
 * 文件名像不像原始发布命名：已经是 `标题 (年)[ - 版本]` / `标题 - S01E01[ - 集名]` 这种规范形状的不算；
 * 其余带压制组 / 编码 / 来源词、或字幕组方括号开头的算。集名里的 Web / Opus 这种普通词不算噪音
 */
export function hasReleaseNoise(stem: string): boolean {
  const s = stripInvisible(stem).trim();
  if (RE_CANONICAL_MOVIE.test(s) || RE_CANONICAL_TV.test(s)) return false;
  if (/^\[/.test(s)) return true;
  const t = parseMediaName(s).tags;
  return !!(t.videoCodec || t.group || (t.source && STRONG_SOURCE.has(t.source)));
}

/**
 * 目录名像不像一个发布目录：带年份、季集标记或发布噪音的算，季目录（Season 2 / Specials / 番外）也算；
 * `downloads`、`inbox`、`电影` 这种收件箱式的名字不算。用来决定「范围就是这个目录」时腾空了删不删
 */
export function looksLikeReleaseDir(name: string): boolean {
  const p = parseMediaName(name);
  return !!p.year || p.season !== undefined || p.episode !== undefined || seasonDirNumber(name) !== null || hasReleaseNoise(name);
}

/**
 * 目录名就是这部作品的名字：目录名解析出的片名（去掉年份、画质、季这些）和识别出来的片名比，归一化后完全相同才算。
 * 不按包含比（`uploads` 不是《Up》），也不单凭「像发布目录」就算（`蓝光`、`Remux`、`美剧 2024` 都像）；一个字的片名太容易撞，不认。
 * titles 只给识别出来的片名（TMDB 的中文名、原名、英文名）；别拿单元自己的标题，那里面混着从目录名来的候选，收件箱会自己认自己
 */
export function isNamedAfter(name: string, titles: Array<string | undefined>): boolean {
  const parsed = parseMediaName(name);
  const own = new Set([parsed.title, ...parsed.titles].map((t) => normalizeTitle(t)).filter((t) => t.length >= 2));
  if (own.size === 0) return false;
  return titles.some((t) => !!t && own.has(normalizeTitle(t)));
}
