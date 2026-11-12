/**
 * strm 管理页条目的纯函数：一行是谁（任务 + 路径）、哪些任务算同一个本地目录、目录和文件的名字在网格里怎么写。
 * 只有纯函数，不引接口和组件，方便单测（lib/strm-entries.test.ts）。
 */

/* ------------------------------- 行的身份 ------------------------------- */

/** 一行条目是哪个任务下的哪条路径。看「全部任务」时不同任务的路径会撞，页面上一律按 (taskId, path) 认 */
export interface StrmRef {
  taskId: string;
  /** 相对任务本地目录的 POSIX 路径 */
  path: string;
}

/** (taskId, path) → 一个字符串键（勾选集合、媒体信息表、React key）。用 JSON 拼：路径里什么字符都可能有，挑不出一个安全的分隔符 */
export const refKey = (taskId: string, path: string): string => JSON.stringify([taskId, path]);

/** refKey 的反过来：键 → (taskId, path) */
export function refOfKey(key: string): StrmRef {
  const [taskId, path] = JSON.parse(key) as [string, string];
  return { taskId, path };
}

/** 任务的本地目录归一成比较用的样子：`/a//b/`、`./a/b` 都是 `a/b`；数据目录根是空串 */
export const rootKey = (targetPath: string): string =>
  targetPath
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");

/** 共用同一个本地目录的几个任务只留第一个：「全部任务」里同一个目录不列两遍（后端的体检 / 校验本来就按内容跳过兄弟任务的文件） */
export function distinctRoots<T extends { targetPath: string }>(tasks: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of tasks) {
    const key = rootKey(t.targetPath);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/* ------------------------------- 作品目录 ------------------------------- */

/** 和后端 organize/identify.ts 的 RE_ID_TAG 同一条规则：Emby `[tmdbid=1]`、Jellyfin `[tmdbid-1]`、Plex `{tmdb-1}` */
const ID_TAG = /[[{]\s*(?:tmdbid|tmdb)\s*[=-]\s*\d+\s*[\]}]/i;

/** 当前路径里最靠后的那个带 id 标签的段——进到作品里了就返回作品目录，不在作品里是 null */
export function workRootOf(path: string): string | null {
  const segs = path.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (ID_TAG.test(segs[i])) return segs.slice(0, i + 1).join("/");
  }
  return null;
}

/** 三家刮削器往目录名里写的 id 标签：tmdb / imdb / tvdb，方括号或花括号，等号或连字符 */
const ANY_ID_TAG = /[[{]\s*(?:tmdbid|tmdb|imdbid|imdb|tvdbid|tvdb)\s*[=-]\s*[A-Za-z0-9]+\s*[\]}]/gi;
const TRAILING_YEAR = /^(.*?)[\s._-]*[(（]((?:19|20)\d{2})[)）]$/;

/**
 * 作品目录名拆成片名和年份，给海报下面那两行字用：`辐射 (2024) [tmdbid=106379]` → 辐射 / 2024。
 * id 标签去掉；年份只认末尾括号里的那个（`2024 (2021)` 的片名是 2024）。拆完没剩下名字的原样用
 */
export function splitWorkName(name: string): { title: string; year?: string } {
  const bare = name.replace(ANY_ID_TAG, " ").replace(/\s+/g, " ").trim();
  const m = TRAILING_YEAR.exec(bare);
  if (m && m[1].trim()) return { title: m[1].trim(), year: m[2] };
  return { title: bare || name };
}

/* ------------------------------- 印章 ------------------------------- */

const SEASON_WORD = /^(?:season|series)[\s._-]*(\d{1,3})(?![0-9A-Za-z])/i;
/** 光一个 S 加数字的要整个名字就是它：`S4 League` 这种片名不是季目录 */
const SEASON_SHORT = /^s[\s._-]*(\d{1,2})$/i;
const SEASON_CJK = /^第\s*(\d{1,3}|[一二两三四五六七八九十]+)\s*[季部]/;
const SPECIALS = /^(?:specials?|sp|ova|oad|特别篇|特別篇|番外篇?)$/i;

const CJK_DIGIT: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 一到九十九的中文数字（三 / 十 / 十二 / 二十 / 二十三）；别的写法回 null */
function cjkNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^([一二两三四五六七八九])?(十)?([一二两三四五六七八九])?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[2]) return m[3] ? null : CJK_DIGIT[m[1]];
  return (m[1] ? CJK_DIGIT[m[1]] : 1) * 10 + (m[3] ? CJK_DIGIT[m[3]] : 0);
}

/**
 * 季目录的季号印章：`Season 1` / `Season.01` / `Series 2` / `S01` / `第二季` → `S01` 这种写法；特别篇（Specials / SP / 番外 / 第 0 季）是 `SP`。
 * 不是季目录回 null。只用来在没有海报的格子上写个号，认的范围比后端 seasonDirNumber 窄一点没关系
 */
export function seasonStamp(name: string): string | null {
  const n = name.trim();
  if (SPECIALS.test(n)) return "SP";
  const m = SEASON_WORD.exec(n) ?? SEASON_SHORT.exec(n);
  let num: number | null = m ? Number(m[1]) : null;
  if (num === null) {
    const c = SEASON_CJK.exec(n);
    num = c ? cjkNumber(c[1]) : null;
  }
  if (num === null) return null;
  return num === 0 ? "SP" : `S${String(num).padStart(2, "0")}`;
}

export interface EpisodeStamp {
  /** `S02`；文件名里只写了集号的没有 */
  season?: string;
  /** `E05`；连着两集的是 `E05-06` */
  episode: string;
}

const SXXEYY = /S(\d{1,3})E(\d{1,4})(?:-?E(\d{1,4}))?/i;
/** 只写集号的：`E12` / `EP12` / `第12集`，前后不能粘着别的字母数字（`DDP5.1`、`H.264` 不算） */
const EP_ONLY = /(?:^|[^A-Za-z0-9])(?:EP?|第)\s?(\d{1,4})(?:[集话話])?(?![0-9A-Za-z])/i;

/** strm 文件名里的集号印章；认不出（电影、没按集命名的）回 null */
export function episodeStamp(name: string): EpisodeStamp | null {
  const pad = (v: string) => v.padStart(2, "0");
  const m = SXXEYY.exec(name);
  if (m) return { season: `S${pad(m[1])}`, episode: m[3] ? `E${pad(m[2])}-${pad(m[3])}` : `E${pad(m[2])}` };
  const e = EP_ONLY.exec(name);
  return e ? { episode: `E${pad(e[1])}` } : null;
}

/** 附件印章上写的扩展名：大写、不带点；超过四个字符的印不下，和没有扩展名的一样回 null（画文件图标） */
export function extStamp(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  return /^[A-Za-z0-9]{1,4}$/.test(ext) ? ext.toUpperCase() : null;
}
