/**
 * 从资源标题里认画质、音轨、字幕、季集、体积这些标签：网页的小标签和筛选、智能体结果里的 tags 都用它。
 *
 * 资源标题是发布者写的宣传语，不是规整的文件名：「沙丘2（2024）4K原盘 全景声+次世代国语 Atmos.7.1」
 * 「繁花(2023)【30集全】【4K.高码率】【杜比视界】」「沙丘2-Dune.Part.Two.2024.1080p.WEBRip.1600MB…[1.6G]」。
 * 整理那边的 parseMediaName 是给文件名认片名和季集的（先按分隔符切词再查技术词表），这类写法它认不全，
 * 所以单写一份，只借它的中文数字。
 *
 * 边界：数字打头的（4K、1080p）只要求前后不挨着数字——「4KHDR」「HD1080P」都常见；
 * 字母缩写（DV、ISO、WEB、BD）要求前后不挨着字母，免得 DVD、HDRip、BDYS 被认错；中文词不要边界，
 * 但要躲开否定（「无中字」「未完结」「非原盘」）。
 */
import { stripInvisible } from "../../lib/text.js";
import { parseCjkNumber } from "../organize/parse-name.js";

type Rule = readonly [tag: string, re: RegExp];

/**
 * 分辨率：一个标题里写了两种（「4K+1080P 双版本」）就两个都标。
 * 「第1080集」「1080话」是集数不是分辨率
 */
const RESOLUTION: Rule[] = [
  ["4K", /(?<![0-9]|第\s*)(?:4k|2160[pi]?)(?![0-9]|\s*[集话話期])/i],
  ["1080p", /(?<![0-9]|第\s*)1080[pi]?(?![0-9]|\s*[集话話期])/i],
  ["720p", /(?<![0-9])720p(?![0-9])/i],
];

/** UHD 在 P2P 命名里常指片源（1080p.UHD.BluRay 是拿 UHD 原盘压的 1080p）：只在没写别的分辨率时才当 4K */
const UHD = /uhd/i;

const PICTURE: Rule[] = [
  // HDR10、HDR10+、「4KHDR」都算；HDRip 是片源，不是 HDR
  ["HDR", /hdr(?!ip)/i],
  ["杜比视界", /杜比视界|dolby\s*vision|dovi|(?<![a-z])dv(?![a-z])/i],
];

/** 片源。蓝光只在没写原盘、REMUX 时标（那两种本来就是蓝光） */
const SOURCE: Rule[] = [
  // 「原盘压制」「原盘转制」是拿原盘压的，不是原盘
  ["原盘", /(?<![非无])原盘(?![压转重])|bdmv|(?<![a-z])iso(?![a-z])/i],
  ["REMUX", /remux/i],
  ["WEB", /web-?dl|web-?rip|(?<![a-z])web(?![a-z])/i],
  ["蓝光", /blu-?ray|bdrip|蓝光|(?<![a-z])bd(?![a-z])/i],
  // 不认光秃秃的 TS / TC：太容易撞上别的缩写
  ["枪版", /枪版|抢先版|(?<![a-z])(?:hd(?:cam|tc|ts)|cam)(?![a-z])/i],
];

const AUDIO_SUBS: Rule[] = [
  ["全景声", /atmos|全景声/i],
  // 「国英」「国粤」要跟着双语 / 多音轨 / 音轨 / 配音才算，不然「中国英雄」也成了国语；「多国语言」「外国语」不是国语
  ["国语", /(?<![多外])国语|国配|普通话|普配|普沪|国(?:英|沪|粤)(?=[双多音配])|mandarin/i],
  ["粤语", /粤语|粤配|国粤(?=[双多音配])|cantonese/i],
  [
    "中字",
    /(?<![无非没])(?:中字|中文字幕|中英字幕|中英双字|简繁|简中|繁中|简体|繁体|双语字幕|特效字幕|内封字幕|外挂字幕|官方字幕)|(?<![a-z])ch[st](?![a-z])/i,
  ],
];

const CJK_NUM = "[0-9]{1,2}|[一二两三四五六七八九十]+";

/** 季：第 2 季、第 1-3 季（S01-S03、1-8季、第一至三季、全5季）。S00 是特别篇，不算 */
function seasonTag(t: string): string | null {
  const range = new RegExp(
    // S01-S03：后一个数字后面不能跟字母（「S01-4K」不是第 1-4 季）
    `(?<![a-z])s(\\d{1,2})\\s*[-~]\\s*s?(\\d{1,2})(?![0-9a-z])` +
      `|(?:第\\s*|(?<![0-9]))(${CJK_NUM})\\s*[-~至到]\\s*(${CJK_NUM})\\s*季`,
    "i",
  ).exec(t);
  if (range) {
    const a = parseCjkNumber(range[1] ?? range[3]);
    const b = parseCjkNumber(range[2] ?? range[4]);
    if (a && b && b > a) return `第 ${a}-${b} 季`;
  }
  const all = new RegExp(`全\\s*(${CJK_NUM})\\s*季`).exec(t);
  const total = all ? parseCjkNumber(all[1]) : null;
  if (total && total > 1) return `第 1-${total} 季`;
  for (const m of t.matchAll(new RegExp(`(?<![a-z])s(\\d{1,2})(?:e\\d{1,4})?(?![0-9])|第\\s*(${CJK_NUM})\\s*季|season\\s*(\\d{1,2})`, "gi"))) {
    const n = parseCjkNumber(m[1] ?? m[2] ?? m[3]);
    if (n && n > 0) return `第 ${n} 季`;
  }
  return total === 1 ? "第 1 季" : null;
}

/**
 * 集数：更新至 12 集 / 全 30 集 / 1-30 集 / 30 集完结 / 30 集，按这个先后认。
 *   - 还在更新的（「更新至12集/共30集」「共30集 更新中」）先认「更新至」，也不标完结；
 *   - 「30集全」的「全」后面要断开，免得吃进「全景声」「全网首发」；
 *   - 「第1-30集 大结局」是范围，不是全 30 集；「第 2 集」是单集，不算；
 *   - 综艺按日期出的期（「更新至20240520期」「更新至1231期」）不是集数。
 * 「全 N 集」「完结」「大结局」「全集」都标完结
 */
function episodeTags(t: string): string[] {
  const out: string[] = [];
  const update = /更新?[至到]\s*(?:第|ep?)?\s*(\d{1,4})(?![0-9])(\s*期)?/i.exec(t);
  const updateIsDate = Boolean(update?.[2]) && (update?.[1].length ?? 0) >= 3;
  const ongoing = Boolean(update) || /更新中|连载|未完结|[周日]更/.test(t);
  const full = /全\s*(\d{1,4})\s*[集话話]|(?<![0-9]|第\s*)(\d{1,4})\s*[集话話]\s*全(?![\p{L}\p{N}])|共\s*(\d{1,4})\s*[集话話]/u.exec(t);
  const range =
    /(?<![a-z])ep?(\d{1,4})\s*[-~]\s*(?:ep?)?(\d{1,4})(?![0-9])|第\s*(\d{1,4})\s*[-~至到]\s*(\d{1,4})\s*[集话話]|(?<![0-9.])(\d{1,4})\s*[-~]\s*(\d{1,4})\s*[集话話]/i.exec(
      t,
    );
  const rangeFrom = range ? Number(range[1] ?? range[3] ?? range[5]) : 0;
  const rangeTo = range ? Number(range[2] ?? range[4] ?? range[6]) : 0;
  const done = /(?<![0-9.])(\d{1,4})\s*[集话話]\s*(?:已?完结|大结局)/.exec(t);
  // 光写「30 集」的（短剧常见，「(59集)」）：「第 2 集」「每周更新2集」不算
  const count = /(?<![0-9.]|第\s*|更新?\s*)(\d{1,4})\s*[集话話](?!数)/.exec(t);
  if (update && !updateIsDate) out.push(`更新至 ${Number(update[1])} 集`);
  else if (full && !ongoing) out.push(`全 ${Number(full[1] ?? full[2] ?? full[3])} 集`);
  else if (range && rangeTo > rangeFrom) out.push(`${rangeFrom}-${rangeTo} 集`);
  else if (done && !ongoing) out.push(`全 ${Number(done[1])} 集`);
  else if (count && Number(count[1]) > 0) out.push(`${Number(count[1])} 集`);
  // 明写了完结的照标（「更至12 已完结」）；「全 N 集」「共 N 集」只是总数，还在更新的不算完结
  const saysDone = /(?<!未)(?:已?完结|大结局)|全集/.test(t);
  if (saysDone || (!ongoing && (full || done))) out.push("完结");
  return out;
}

/** 合集：「沙丘1-2部合集」「哈利波特系列」「三部曲」「全3部」；「速度与激情系列第十部」是其中一部，不算 */
const COLLECTION = /合集|系列(?!\s*第)|[三四五六]部曲|全\s*(?:[0-9]{1,2}|[一二两三四五六七八九十]+)\s*部/;

/** 体积要带单位；只写 M 的要不小于 100（「5M」多半不是体积）。一个标题里出现两次（1600MB … [1.6G]）取第一个 */
const SIZE = /(?<![0-9.a-z])(\d{1,4}(?:\.\d{1,2})?)\s*(tb|t|gb|g|mb|m)(?![a-z])/gi;

function sizeTag(t: string): string | null {
  for (const m of t.matchAll(SIZE)) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (!(n > 0)) continue;
    if (unit === "m" && n < 100) continue;
    const gb = unit.startsWith("t") ? n * 1024 : unit.startsWith("g") ? n : n / 1024;
    return fmtSize(gb);
  }
  return null;
}

function fmtSize(gb: number): string {
  const one = (v: number) => String(Number(v.toFixed(1)));
  if (gb >= 1024) return `${one(gb / 1024)}T`;
  if (gb >= 10) return `${Math.round(gb)}G`;
  if (gb >= 1) return `${one(gb)}G`;
  return `${Math.round(gb * 1024)}M`;
}

/** 标题 → 标签，固定先后：分辨率、HDR / 杜比视界、片源、音轨、字幕、季、集、完结、合集、体积 */
export function titleTags(title: string): string[] {
  const t = title.normalize("NFKC");
  const tags: string[] = [];
  for (const [tag, re] of RESOLUTION) if (re.test(t)) tags.push(tag);
  if (tags.length === 0 && UHD.test(t)) tags.push("4K");
  for (const [tag, re] of PICTURE) if (re.test(t)) tags.push(tag);
  for (const [tag, re] of SOURCE) {
    if (tag === "蓝光" && (tags.includes("原盘") || tags.includes("REMUX"))) continue;
    if (re.test(t)) tags.push(tag);
  }
  for (const [tag, re] of AUDIO_SUBS) if (re.test(t)) tags.push(tag);
  const season = seasonTag(t);
  if (season) tags.push(season);
  tags.push(...episodeTags(t));
  if (COLLECTION.test(t)) tags.push("合集");
  const size = sizeTag(t);
  if (size) tags.push(size);
  return tags;
}

/* ------------------------------- 按词匹配 ------------------------------- */

/**
 * 屏蔽词、智能体的 include / exclude 按词匹配，同一个口径：词过 matchKey、结果过 matchTextOf，拿 includes 对。
 * 全角转半角、不分大小写，看不见的字符（零宽、韩文填充符）去掉；此外按词分两种：
 *   - 带中文等非 ASCII 字符的按子串对，空白不计较：屏蔽词「第1季」对得上标签「第 1 季」，「预告」「枪版」照旧；
 *   - 只有 ASCII 的（TC、CAM、YTS、4K、x265）要整段对上：头尾不能和挨着的同一类字符连成一串（字母挨字母、数字挨数字），
 *     也不能跨过空白——不然「TC」会藏掉 The Witcher、Watchmen、Cat Club，「CAM」会藏掉 James Cameron。
 *     字母和数字挨着算断开：「2160」对得上 2160p，「HDR」对得上 HDR10，「S01」对得上 S01E01。
 * 为了还是一个 includes 就能对，ASCII 的那一份把每串连续的字母、每串连续的数字各用 RUN 包起来（别的字符都丢掉），
 * 词也这么包：包好的词只能对上一串一串完整的
 */
const RUN = "\u0001";

function norm(s: string): string {
  return stripInvisible(s).normalize("NFKC").toLowerCase();
}

/** 子串对的那一份：去掉空白 */
function plainKey(s: string): string {
  return norm(s).replace(/\s+/g, "");
}

/** 整段对的那一份：一串字母、一串数字各包一层 */
function runsKey(s: string): string {
  return (norm(s).match(/[a-z]+|[0-9]+/g) ?? []).map((run) => `${RUN}${run}${RUN}`).join("");
}

/** 一个词拿来匹配的样子。只有 ASCII、又有字母数字的按整段对；「+」这种只有符号的、带中文的按子串对 */
export function matchKey(term: string): string {
  const s = norm(term).replace(/\s+/g, " ").trim();
  return /^[\x20-\x7e]+$/.test(s) && /[a-z0-9]/.test(s) ? runsKey(s) : plainKey(s);
}

/** 一条结果拿来按词匹配的文本：标题和各个标签的两份（见上），用 | 隔开，不让词跨着标题和标签对上 */
export function matchTextOf(hit: { title: string; tags?: readonly string[] }): string {
  const parts = [hit.title, ...(hit.tags ?? [])];
  return [...parts.map(plainKey), ...parts.map(runsKey)].join("|");
}

/**
 * 收藏夹单元的标签：目录名认不出就看样本文件名；「第 N 季」不算（季另外列，样本文件里的只是其中一季）。
 * 作品分组（library-units.ts）和单元视图（library/works.ts）共用，口径才一致
 */
export function unitTags(rawName: string, sampleFile: string): string[] {
  const nameTags = titleTags(rawName);
  return (nameTags.length > 0 || !sampleFile ? nameTags : titleTags(sampleFile)).filter((t) => !/^第 .+ 季$/.test(t));
}
