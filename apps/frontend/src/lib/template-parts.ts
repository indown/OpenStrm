/**
 * 命名模板按层拆开编辑：电影是「目录 / 文件名」，剧集是「目录 / 季目录 / 文件名」。
 * 后端存的还是一条带斜杠的模板串，这里只负责拆和拼；拆了再拼必须一字不差（设置页的脏状态是比字符串）。
 *
 *   - 只认括号深度 0 的 `/` 作分层点：`[{collection}/]` 里的斜杠是可选段的一部分，不拆。
 *   - 转义 `\[` `\]` `\{` `\}` `\\` 照后端 parseTemplate 的规矩跳过。
 *   - 括号不配对的模板拆不了（返回 null），界面退回整条编辑。
 */

export interface MovieParts {
  dir: string;
  file: string;
}

export interface TvParts {
  dir: string;
  /** 空串 = 不建季目录 */
  season: string;
  file: string;
}

/** 深度 0 的 `/` 的位置；括号不配对返回 null */
export function topLevelSlashes(template: string): number[] | null {
  const out: number[] = [];
  let depth = 0;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === "\\" && i + 1 < template.length && "[]{}\\".includes(template[i + 1])) {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth < 0) return null;
    } else if (ch === "/" && depth === 0) out.push(i);
  }
  return depth === 0 ? out : null;
}

/** 这一格里有没有分层的斜杠（文件名 / 季目录两格不该有） */
export function hasTopLevelSlash(part: string): boolean {
  const s = topLevelSlashes(part);
  return s !== null && s.length > 0;
}

function segmentsOf(template: string): string[] | null {
  const slashes = topLevelSlashes(template);
  if (slashes === null) return null;
  const segs: string[] = [];
  let start = 0;
  for (const i of slashes) {
    segs.push(template.slice(start, i));
    start = i + 1;
  }
  segs.push(template.slice(start));
  return segs;
}

export function splitMovie(template: string): MovieParts | null {
  const segs = segmentsOf(template);
  if (segs === null) return null;
  if (segs.length === 1) return { dir: "", file: segs[0] };
  return { dir: segs.slice(0, -1).join("/"), file: segs[segs.length - 1] };
}

export function joinMovie(parts: MovieParts): string {
  return parts.dir ? `${parts.dir}/${parts.file}` : parts.file;
}

const RE_SEASON_VAR = /\{(season|season00)\}/;
const RE_WORK_VAR = /\{(title|originalTitle|enTitle|idTag|tmdbId)\}/;

/** 倒数第二段含季变量、又不含片名 / id 变量才算季目录（`{title} S{season00}` 是把季写进剧目录，不是季目录） */
export function splitTv(template: string): TvParts | null {
  const segs = segmentsOf(template);
  if (segs === null) return null;
  if (segs.length === 1) return { dir: "", season: "", file: segs[0] };
  const file = segs[segs.length - 1];
  const cand = segs[segs.length - 2];
  if (RE_SEASON_VAR.test(cand) && !RE_WORK_VAR.test(cand)) {
    return { dir: segs.slice(0, -2).join("/"), season: cand, file };
  }
  return { dir: segs.slice(0, -1).join("/"), season: "", file };
}

export function joinTv(parts: TvParts): string {
  return [parts.dir, parts.season, parts.file].filter((s) => s !== "").join("/");
}

/** 渲染出来的路径按最后一个 `/` 分成目录和文件名（示例里分两行显示） */
export function splitRenderedPath(path: string): { dir: string; file: string } {
  const i = path.lastIndexOf("/");
  return i === -1 ? { dir: "", file: path } : { dir: path.slice(0, i), file: path.slice(i + 1) };
}
