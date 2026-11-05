/**
 * 命名模板：token 变量 + 可选段。Sonarr / Radarr 风格，不做表达式。
 *
 *   {title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {episodeTitle}].{ext}
 *
 *   - `{var}` 变量；`[ … ]` 可选段：段里的变量全为空就整段丢掉；`\[` `\]` `\{` `\}` 转义。
 *   - 路径段整体为空就去掉这一层（分类关掉时 `{category}/` 自然消失）。
 *   - 变量值先清洗：`/ \` → `-`，冒号按策略，`< > " | ? *` 删掉，首尾空格和点去掉。
 *   - 单段超过 200 字节时截标题不截扩展名。
 *   - `{a|b}` 兜底：a 为空就用 b。`{title:.}` 后缀把值按发布组写法连接（空格换成点；`:_` 下划线、`:-` 横线），
 *     顺手去掉 ' " ! , 这类标点、& 写成 and、冒号策略留下的孤立横线。后缀写在整条兜底链末尾。
 */
import type { OrganizeColonStyle } from "@openstrm/shared";

export const TEMPLATE_VARS = [
  "category", "collection", "title", "originalTitle", "enTitle", "year", "tmdbId", "imdbId", "idTag",
  "season", "season00", "episode", "episode00", "absolute", "absolute000", "episodeTitle",
  "part", "edition", "resolution", "source", "videoCodec", "audio", "hdr", "group", "ext", "originalName",
] as const;

export type TemplateVarName = (typeof TEMPLATE_VARS)[number];
export type TemplateVars = Partial<Record<TemplateVarName, string | number | null | undefined>>;

export interface RenderOptions {
  colon?: OrganizeColonStyle;
  /** 单个路径段的字节上限，默认 200 */
  maxSegmentBytes?: number;
}

type Node = { kind: "text"; text: string } | { kind: "var"; names: string[]; sep?: string } | { kind: "opt"; children: Node[] };

interface Parsed {
  nodes: Node[];
  errors: string[];
}

const MAX_SEGMENT_BYTES = 200;
const SEPARATORS = new Set([".", "_", "-"]);

/** 花括号里的写法：`a|b|c` 是兜底链，末尾可以带 `:.` / `:_` / `:-` 后缀 */
function parseVarSpec(raw: string): { names: string[]; sep?: string; errors: string[] } {
  const errors: string[] = [];
  const colon = raw.indexOf(":");
  const body = colon === -1 ? raw : raw.slice(0, colon);
  const sep = colon === -1 ? undefined : raw.slice(colon + 1).trim();
  if (sep !== undefined && !SEPARATORS.has(sep)) errors.push(`变量 {${raw.trim()}} 的后缀只能是 :. :_ :-`);
  const names = body.split("|").map((n) => n.trim());
  for (const name of names) if (!(TEMPLATE_VARS as readonly string[]).includes(name)) errors.push(`不认识的变量 {${name}}`);
  return { names, sep: sep !== undefined && SEPARATORS.has(sep) ? sep : undefined, errors };
}

/** 发布组写法：去掉引号 / 逗号 / 叹号，& 写成 and，冒号策略留下的孤立横线丢掉，剩下的词用 sep 连起来 */
export function releaseJoin(value: string, sep: string): string {
  return value
    .replace(/[‘’“”'"!,]/g, "")
    .replace(/&/g, " and ")
    .split(/\s+/)
    .filter((w) => w && !/^[-–—:]+$/.test(w))
    .join(sep);
}

export function parseTemplate(template: string): Parsed {
  const errors: string[] = [];
  const root: Node[] = [];
  const stack: Node[][] = [root];
  let text = "";
  let i = 0;
  const flush = () => {
    if (text) stack[stack.length - 1].push({ kind: "text", text });
    text = "";
  };
  while (i < template.length) {
    const ch = template[i];
    if (ch === "\\" && i + 1 < template.length && "[]{}\\".includes(template[i + 1])) {
      text += template[i + 1];
      i += 2;
      continue;
    }
    if (ch === "{") {
      const end = template.indexOf("}", i + 1);
      if (end === -1) {
        errors.push(`第 ${i + 1} 个字符起的 { 没有配对的 }`);
        break;
      }
      const spec = parseVarSpec(template.slice(i + 1, end));
      errors.push(...spec.errors);
      flush();
      stack[stack.length - 1].push({ kind: "var", names: spec.names, sep: spec.sep });
      i = end + 1;
      continue;
    }
    if (ch === "[") {
      flush();
      const children: Node[] = [];
      stack[stack.length - 1].push({ kind: "opt", children });
      stack.push(children);
      i++;
      continue;
    }
    if (ch === "]") {
      flush();
      if (stack.length === 1) errors.push("多了一个 ]");
      else stack.pop();
      i++;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  if (stack.length > 1) errors.push("有 [ 没有配对的 ]");
  return { nodes: root, errors };
}

export function validateTemplate(template: string): string[] {
  const { errors } = parseTemplate(template);
  if (!template.trim()) errors.push("模板不能为空");
  if (!/\{ext\}/.test(template)) errors.push("模板末尾要有 .{ext}");
  return errors;
}

function colonize(v: string, style: OrganizeColonStyle): string {
  switch (style) {
    case "delete":
      return v.replace(/:/g, "");
    case "dash":
      return v.replace(/:/g, "-");
    case "spaceDash":
      return v.replace(/:/g, " -");
    default:
      return v.replace(/:\s+/g, " - ").replace(/:/g, "-");
  }
}

/** 变量值清洗：能进文件名的样子 */
export function cleanValue(raw: string | number | null | undefined, colon: OrganizeColonStyle = "smart"): string {
  if (raw === null || raw === undefined) return "";
  let v = String(raw);
  if (!v) return "";
  v = [...v].filter((ch) => ch.charCodeAt(0) >= 0x20).join("");
  v = v.replace(/[\\/]/g, "-");
  v = colonize(v, colon);
  v = v.replace(/[<>"|?*]/g, "");
  v = v.replace(/\s+/g, " ").trim();
  v = v.replace(/^[.\s]+|[.\s]+$/g, "");
  return v;
}

/** 路径段整理：空段去掉、首尾空白和点去掉、超长截断（保留扩展名） */
function finishSegment(seg: string, ext: string, maxBytes: number): string {
  let s = seg.replace(/\s+/g, " ").trim().replace(/^[.\s]+|[.\s]+$/g, "");
  if (!s) return "";
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const suffix = ext && s.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? s.slice(-(ext.length + 1)) : "";
  let stem = suffix ? s.slice(0, -suffix.length) : s;
  while (stem.length > 1 && Buffer.byteLength(stem, "utf8") + Buffer.byteLength(suffix, "utf8") > maxBytes) stem = stem.slice(0, -1);
  s = `${stem.replace(/[.\s]+$/g, "")}${suffix}`;
  return s;
}

export interface RenderResult {
  /** 相对路径，`/` 分段，不带前导 / */
  path: string;
  errors: string[];
}

export function renderTemplate(template: string, vars: TemplateVars, opts: RenderOptions = {}): RenderResult {
  const { nodes, errors } = parseTemplate(template);
  const colon = opts.colon ?? "smart";
  /** 兜底链里第一个非空的值；带后缀就按发布组写法连接 */
  const value = (names: string[], sep?: string): string => {
    let v = "";
    for (const name of names) {
      v = cleanValue(vars[name as TemplateVarName], colon);
      if (v) break;
    }
    return sep && v ? releaseJoin(v, sep) : v;
  };
  const render = (list: Node[]): { text: string; hadValue: boolean; hadVar: boolean } => {
    let text = "";
    let hadValue = false;
    let hadVar = false;
    for (const n of list) {
      if (n.kind === "text") text += n.text;
      else if (n.kind === "var") {
        hadVar = true;
        const v = value(n.names, n.sep);
        if (v) hadValue = true;
        text += v;
      } else {
        const inner = render(n.children);
        if (!inner.hadVar || inner.hadValue) {
          text += inner.text;
          if (inner.hadValue) hadValue = true;
        }
      }
    }
    return { text, hadValue, hadVar };
  };
  const ext = value(["ext"]);
  const raw = render(nodes).text;
  const segments = raw
    .split("/")
    .map((seg) => finishSegment(seg, ext, opts.maxSegmentBytes ?? MAX_SEGMENT_BYTES))
    .filter(Boolean);
  return { path: segments.join("/"), errors };
}

/** id 标签：Emby `[tmdbid=1]`、Jellyfin `[tmdbid-1]`、Plex `{tmdb-1}` */
export function idTagFor(style: "emby" | "jellyfin" | "plex" | "none" | undefined, tmdbId: number | undefined): string {
  if (!tmdbId || style === "none") return "";
  switch (style) {
    case "jellyfin":
      return `[tmdbid-${tmdbId}]`;
    case "plex":
      return `{tmdb-${tmdbId}}`;
    default:
      return `[tmdbid=${tmdbId}]`;
  }
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");
export const pad3 = (n: number): string => String(n).padStart(3, "0");

/** 多集：`01-E02`，接在模板的 `E` 后面就是 `S01E01-E02` */
export function episodeToken(start: number, end: number | undefined, width: 2 | 0): string {
  const one = (n: number) => (width === 2 ? pad2(n) : String(n));
  return end !== undefined && end > start ? `${one(start)}-E${one(end)}` : one(start);
}
