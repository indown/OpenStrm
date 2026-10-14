/**
 * 自定义识别词。每行一条，`#` 开头是注释：
 *
 *   屏蔽词                                   从名字里删掉
 *   被替换词 => 替换词                        替换；被替换词写成 /正则/i 就按正则
 *   前定位词 <> 后定位词 >> EP+12             集数偏移：定位词之间的数字按表达式换算（EP+1 / 2*EP-1）
 *   被替换词 => 替换词 && 前 <> 后 >> EP-1    两者都做
 *   被替换词 => {[tmdbid=95396;type=tv;s=2]}  直接指定 TMDB（type 可省，s / e 可省；命中目录名时 s 管整个目录，命中文件名时 s / e 只管那个文件）
 *
 * 顺序：屏蔽 → 替换 → 偏移，每条都是纯字符串操作，先过 rules.test.ts。
 */
import type { OrganizeMediaType } from "@openstrm/shared";
import { parseCjkNumber } from "./parse-name.js";

export interface DirectSpec {
  tmdbId: number;
  mediaType?: OrganizeMediaType;
  season?: number;
  episode?: number;
}

export interface ParsedRule {
  raw: string;
  block?: string;
  replace?: { from: RegExp; to: string };
  offset?: { pre: string; post: string; expr: string };
  direct?: DirectSpec;
}

export interface RuleParseResult {
  rules: ParsedRule[];
  /** 语法不对的行：`第 3 行：…` */
  errors: string[];
}

export interface RuleApplyResult {
  name: string;
  /** 命中了直指 tmdbid 的规则 */
  direct?: DirectSpec;
  /** 命中的规则原文 */
  hits: string[];
}

const RE_DIRECT = /^\{\[(.+)\]\}$/;
const RE_REGEX = /^\/(.+)\/([gimsuy]*)$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalRegex(text: string): RegExp {
  return new RegExp(escapeRegex(text), "gi");
}

function parseDirect(text: string): DirectSpec | null {
  const m = RE_DIRECT.exec(text.trim());
  if (!m) return null;
  const spec: Partial<DirectSpec> = {};
  for (const kv of m[1].split(";")) {
    const [k, v] = kv.split("=").map((x) => x.trim());
    if (!k || v === undefined) continue;
    if (k === "tmdbid") spec.tmdbId = Number(v);
    else if (k === "type") spec.mediaType = v === "movie" ? "movie" : v === "tv" ? "tv" : undefined;
    else if (k === "s") spec.season = Number(v);
    else if (k === "e") spec.episode = Number(v);
  }
  if (!spec.tmdbId || !Number.isInteger(spec.tmdbId) || spec.tmdbId <= 0) return null;
  return spec as DirectSpec;
}

/** 偏移表达式只允许 EP、整数和 + - * / ( ) */
export function validateOffsetExpr(expr: string): boolean {
  return /^[\sEP0-9+\-*/()]+$/.test(expr) && /EP/.test(expr);
}

/** 不用 eval：小递归下降，只认四则和括号 */
export function evalOffsetExpr(expr: string, ep: number): number {
  const src = expr.replace(/EP/g, String(ep)).replace(/\s+/g, "");
  let i = 0;
  const peek = () => src[i];
  const number = (): number => {
    const start = i;
    if (peek() === "-") i++;
    while (i < src.length && /[0-9.]/.test(src[i])) i++;
    if (start === i || (src[start] === "-" && start + 1 === i)) throw new Error(`表达式不合法：${expr}`);
    return Number(src.slice(start, i));
  };
  const factor = (): number => {
    if (peek() === "(") {
      i++;
      const v = expr_();
      if (peek() !== ")") throw new Error(`表达式括号不匹配：${expr}`);
      i++;
      return v;
    }
    return number();
  };
  const term = (): number => {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = src[i++];
      const r = factor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const expr_ = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = src[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = expr_();
  if (i !== src.length) throw new Error(`表达式不合法：${expr}`);
  return Math.round(v);
}

function parseOffsetPart(text: string): { pre: string; post: string; expr: string } | null {
  const gt = text.indexOf(" >> ");
  if (gt === -1) return null;
  const locators = text.slice(0, gt);
  const expr = text.slice(gt + 4).trim();
  const sep = locators.indexOf(" <> ");
  if (sep === -1) return null;
  const pre = locators.slice(0, sep).trim();
  const post = locators.slice(sep + 4).trim();
  if (!validateOffsetExpr(expr)) return null;
  return { pre, post, expr };
}

export function parseRuleLine(raw: string): ParsedRule | null {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  const rule: ParsedRule = { raw: line };
  let head = line;
  const andAt = line.indexOf(" && ");
  if (andAt !== -1) {
    head = line.slice(0, andAt).trim();
    const offset = parseOffsetPart(line.slice(andAt + 4).trim());
    if (!offset) throw new Error("`&&` 后面要写「前定位词 <> 后定位词 >> 表达式」");
    rule.offset = offset;
  } else if (line.includes(" <> ") && line.includes(" >> ")) {
    const offset = parseOffsetPart(line);
    if (!offset) throw new Error("集数偏移要写成「前定位词 <> 后定位词 >> EP+1」");
    rule.offset = offset;
    return rule;
  }
  const arrow = /^(.*?)\s*=>\s*(.*)$/.exec(head);
  if (arrow) {
    const from = arrow[1].trim();
    const to = arrow[2].trim();
    if (!from) throw new Error("被替换词不能为空");
    const direct = parseDirect(to);
    if (direct) rule.direct = direct;
    const rx = RE_REGEX.exec(from);
    let fromRe: RegExp;
    try {
      fromRe = rx ? new RegExp(rx[1], rx[2].includes("g") ? rx[2] : `${rx[2]}g`) : literalRegex(from);
    } catch (err) {
      throw new Error(`正则写错了：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    rule.replace = { from: fromRe, to: direct ? "" : to };
    return rule;
  }
  if (!rule.offset) rule.block = head;
  return rule;
}

export function parseRules(lines: string[] | undefined): RuleParseResult {
  const rules: ParsedRule[] = [];
  const errors: string[] = [];
  (lines ?? []).forEach((raw, i) => {
    try {
      const r = parseRuleLine(raw);
      if (r) rules.push(r);
    } catch (err) {
      errors.push(`第 ${i + 1} 行：${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { rules, errors };
}

const RE_NUMBER = /\d{1,4}|[零〇一二两三四五六七八九十百]+/g;

/** 定位词之间的数字换算：`前 <> 后 >> EP+12`。宽度保留（01 → 13，001 → 013） */
function applyOffset(name: string, o: { pre: string; post: string; expr: string }): { name: string; hit: boolean } {
  const pre = o.pre ? escapeRegex(o.pre) : "";
  const post = o.post ? escapeRegex(o.post) : "";
  const re = new RegExp(`${pre}([\\s\\S]*?)${post}`, o.pre || o.post ? "i" : "");
  const m = re.exec(name);
  if (!m) return { name, hit: false };
  const inner = m[1];
  let hit = false;
  const replaced = inner.replace(RE_NUMBER, (numText) => {
    const n = parseCjkNumber(numText);
    if (n === null) return numText;
    hit = true;
    const v = evalOffsetExpr(o.expr, n);
    return /^\d+$/.test(numText) ? String(Math.max(0, v)).padStart(numText.length, "0") : String(Math.max(0, v));
  });
  if (!hit) return { name, hit: false };
  const rebuilt = name.slice(0, m.index) + m[0].replace(inner, replaced) + name.slice(m.index + m[0].length);
  return { name: rebuilt, hit: true };
}

/** 按顺序把规则套到一个名字上（文件名和目录名各套一次） */
export function applyRules(name: string, rules: ParsedRule[]): RuleApplyResult {
  let out = name;
  let direct: DirectSpec | undefined;
  const hits: string[] = [];
  for (const r of rules) {
    if (r.block) {
      const re = literalRegex(r.block);
      if (re.test(out)) {
        out = out.replace(re, " ");
        hits.push(r.raw);
      }
    }
  }
  for (const r of rules) {
    if (!r.replace) continue;
    r.replace.from.lastIndex = 0;
    if (!r.replace.from.test(out)) continue;
    r.replace.from.lastIndex = 0;
    out = out.replace(r.replace.from, r.replace.to);
    if (r.direct && !direct) direct = r.direct;
    hits.push(r.raw);
    if (r.offset) {
      const res = applyOffset(out, r.offset);
      out = res.name;
    }
  }
  for (const r of rules) {
    if (!r.offset || r.replace) continue;
    const res = applyOffset(out, r.offset);
    if (res.hit) {
      out = res.name;
      hits.push(r.raw);
    }
  }
  return { name: out.replace(/\s{2,}/g, " ").trim(), direct, hits };
}
