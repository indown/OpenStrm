/**
 * 整理工具给模型看的样子：编号、一次整理的概括、清单（要拿主意的在前）、文件、给人看的确认摘要。
 * 全是纯函数，只读库里的 run / 单元 / 项，不碰网盘。
 *
 * 编号：单元按 listUnits 的顺序（rootPath、key）编成 u1…uN——单元在预览时就定了，重规划不增不减，整次整理都有效，
 * 进程重启也不变。文件是「单元编号.路径哈希」（u3.9f86d081）：冲突选「覆盖」会在单元里多出一个删除项，按顺序编号的话
 * 后面的都会挪位，按路径哈希不受影响。路径里可能有零宽空格、首尾空格，让模型原样抄回来靠不住，所以对模型一律用编号。
 * 编号认的是「单元 + 文件」：同一个字幕可能按名字前缀跟到两部片子下（Alien / Aliens），两边各是各的一项。
 * 「覆盖」带出来的那个删除项（删的是目标位置原来那份）不编号：它不是这个单元的文件，改它什么也改变不了，要撤回就改冲突那一项的办法
 */
import { createHash } from "node:crypto";
import { isLocalUnitKey } from "../../organize/local-naming.js";
import type {
  OrganizeConflictResolution,
  OrganizeFailureGroup,
  OrganizeFailureGroupKey,
  OrganizeItem,
  OrganizeRun,
  OrganizeRunStage,
  OrganizeTrigger,
  OrganizeUnit,
  OrganizeUnitCounts,
  TaskDefinition,
} from "@openstrm/shared";
import { handPicked, relOf } from "../../organize/run.js";
import { fmtTime } from "../format.js";

/** 整理页上打开这一次（「在 OpenStrm 里打开」的路径） */
export const organizeUiPath = (runId: string): string => `/organize?${new URLSearchParams({ run: runId })}`;

/* ------------------------------- 编号 ------------------------------- */

export interface RunRefs {
  unitRef(key: string): string | undefined;
  unitKey(ref: string): string | undefined;
  /** 某个单元下的某个文件的编号；「覆盖」带出来的删除项、建目录 / 删空目录没有 */
  fileRef(unitKey: string, srcPath: string): string | undefined;
  file(ref: string): { unitKey: string; srcPath: string } | undefined;
}

/** 文件编号里路径哈希的长度：单元里几千个文件也几乎撞不上，撞上了整个单元加长 */
const FILE_TAG_LEN = 8;
const hashOf = (p: string): string => createHash("sha1").update(p).digest("hex");

/**
 * 这个单元里「覆盖」带出来的删除项（网盘路径）：选了覆盖的那一项要挪去的位置上原来那份。
 * 用户自己选「删掉」的项删的是单元自己的文件，不在这里面
 */
export function replaceDeletesOf(u: Pick<OrganizeUnit, "resolutions">, unitItems: OrganizeItem[]): Set<string> {
  const targets = new Set(unitItems.filter((it) => it.action !== "delete" && u.resolutions?.[it.srcPath]?.how === "replace").map((it) => it.dstPath));
  return new Set(unitItems.filter((it) => it.action === "delete" && targets.has(it.srcPath)).map((it) => it.srcPath));
}

export function buildRefs(units: OrganizeUnit[], items: OrganizeItem[]): RunRefs {
  const unitRefs = new Map<string, string>();
  const unitKeys = new Map<string, string>();
  units.forEach((u, i) => {
    unitRefs.set(u.key, `u${i + 1}`);
    unitKeys.set(`u${i + 1}`, u.key);
  });
  const itemsByUnitKey = new Map<string, OrganizeItem[]>();
  for (const it of items) {
    if (it.unitKey === "" || it.kind === "dir") continue;
    const list = itemsByUnitKey.get(it.unitKey);
    if (list) list.push(it);
    else itemsByUnitKey.set(it.unitKey, [it]);
  }
  const fileRefs = new Map<string, Map<string, string>>();
  const files = new Map<string, { unitKey: string; srcPath: string }>();
  for (const u of units) {
    const uref = unitRefs.get(u.key)!;
    const unitItems = itemsByUnitKey.get(u.key) ?? [];
    const byReplace = replaceDeletesOf(u, unitItems);
    const paths = new Set(unitItems.filter((it) => !(it.action === "delete" && byReplace.has(it.srcPath))).map((it) => it.srcPath));
    const hashes = [...paths].map((p) => [p, hashOf(p)] as const);
    let len = FILE_TAG_LEN;
    while (len < 40 && new Set(hashes.map(([, h]) => h.slice(0, len))).size < hashes.length) len += 4;
    const refs = new Map<string, string>();
    for (const [p, h] of hashes) {
      const ref = `${uref}.${h.slice(0, len)}`;
      refs.set(p, ref);
      files.set(ref, { unitKey: u.key, srcPath: p });
    }
    fileRefs.set(u.key, refs);
  }
  const norm = (ref: string) => ref.trim().toLowerCase();
  return {
    unitRef: (key) => unitRefs.get(key),
    unitKey: (ref) => unitKeys.get(norm(ref)),
    fileRef: (unitKey, p) => fileRefs.get(unitKey)?.get(p),
    file: (ref) => files.get(norm(ref)),
  };
}

/* ------------------------------- 一次整理的概括 ------------------------------- */

const TRIGGER_TEXT: Record<OrganizeTrigger, string> = {
  manual: "手动",
  agent: "智能体",
  share: "转存",
  follow: "追更",
  offline: "云下载",
  monitor: "网盘监控",
  copy: "复制到 OpenList",
};

export const taskText = (task: TaskDefinition | undefined): string => (task ? `${task.account} · ${task.originPath}` : "（已删除的任务）");

/** 范围一句话：手动 / 智能体选的多个目录说「N 个目录」，自动触发的说「N 个新增路径」，单一范围说路径，都没有是整个任务 */
export function scopeText(run: Pick<OrganizeRun, "scopePath" | "scopePaths" | "trigger">): string {
  const n = run.scopePaths.length;
  if (n > 0) return handPicked(run.trigger) ? `${n} 个目录` : `${n} 个新增路径`;
  return run.scopePath || "整个任务";
}

/** 给人看的范围说法（确认摘要、确认框）：不带目录名——那是网盘里的名字，常常来自别人的分享 */
function scopeSummary(run: Pick<OrganizeRun, "scopePath" | "scopePaths" | "trigger">): string {
  const n = run.scopePaths.length;
  if (n > 0) return handPicked(run.trigger) ? `${n} 个目录` : `${n} 个新增路径`;
  return run.scopePath ? "任务里的一个子目录" : "整个任务";
}

/** 要动的文件数：planned 里去掉建目录、删空目录、删文件 */
export const movingFiles = (run: OrganizeRun): number => Math.max(0, run.stats.planned - run.stats.plannedMkdir - run.stats.plannedRmdir - run.stats.plannedDelete);

/** 一次整理一句话：状态 + 关键数字 */
export function runLine(run: OrganizeRun): string {
  const s = run.stats;
  switch (run.status) {
    case "planning":
      return `预览中${run.progress?.message ? `：${run.progress.message}` : ""}`;
    case "ready":
      if (s.planned === 0) return `${s.units} 部作品，都已经是整理好的样子，没有要动的`;
      return [
        `${s.units} 部作品`,
        `改名 / 移动 ${movingFiles(run)} 个文件`,
        s.plannedMkdir ? `新建 ${s.plannedMkdir} 个目录` : "",
        s.conflicts ? `冲突 ${s.conflicts}` : "",
        s.plannedDelete ? `删除 ${s.plannedDelete}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "applying":
      return `执行中 ${run.progress ? `${run.progress.done}/${run.progress.total}` : ""}`.trim();
    case "reverting":
      return `撤销中 ${run.progress ? `${run.progress.done}/${run.progress.total}` : ""}`.trim();
    case "reverted":
      return `已撤销：${s.reverted} 项已退回${s.notReverted ? `，${s.notReverted} 项没退回` : ""}`;
    case "done":
    case "failed":
    case "cancelled": {
      if (run.stage === "revert") return `撤销停在一半：${s.reverted} 项已退回，${s.notReverted} 项没退回`;
      const executed = s.done > 0 || s.failed > 0;
      if (!executed) return run.status === "failed" ? `预览失败：${run.error || "原因不明"}` : `已取消${run.error ? `：${run.error}` : ""}`;
      const label = run.status === "done" ? "已完成" : run.status === "failed" ? "中途停下" : "执行被取消";
      return `${label}：做完 ${s.done} 项${s.failed ? `，失败 ${s.failed}` : ""}${s.pending ? `，没做完 ${s.pending}` : ""}`;
    }
  }
}

/** 列表、总览里的一条 */
export function runBrief(run: OrganizeRun, task: TaskDefinition | undefined, extra: Record<string, unknown> = {}) {
  return {
    runId: run.id,
    task: taskText(task),
    taskId: run.taskId,
    status: run.status,
    ...(run.stage === "revert" ? { stage: "revert" } : {}),
    ...extra,
    trigger: TRIGGER_TEXT[run.trigger],
    ...(run.naming === "local" ? { naming: "local" } : {}),
    scope: scopeText(run),
    createdAt: fmtTime(run.createdAt * 1000),
    line: runLine(run),
  };
}

/* ------------------------------- 给人看的确认摘要 ------------------------------- */

/**
 * 执行前给人看的那段话。只有数字、任务名（用户自己起的）和固定措辞，不放文件名、TMDB 标题这类第三方文本：
 * 模型要原样转给用户，当面确认的确认框里也是它
 */
export function confirmTextOf(run: OrganizeRun, units: OrganizeUnit[], task: TaskDefinition | undefined, outdated?: { kind: "changed" | "old"; at: number }): string {
  const s = run.stats;
  const local = run.naming === "local";
  const picked = units.filter((u) => u.selected && (u.match || local));
  const conf = { high: 0, medium: 0, low: 0 };
  let manual = 0;
  for (const u of picked) {
    const c = u.match?.confidence;
    if (c === "high" || c === "medium" || c === "low") conf[c]++;
    if (u.match?.reason === "手动指定") manual++;
  }
  const unmatched = local ? 0 : units.filter((u) => !u.match).length;
  const skippedByChoice = units.filter((u) => (u.match || local) && !u.selected).length;
  const referenced = picked.reduce((n, u) => n + u.referencedBy, 0);
  const retitled = picked.filter((u) => u.titleOverride || u.yearOverride).length;
  const pinned = picked.reduce((n, u) => n + Object.keys(u.pins ?? {}).length, 0);
  const renamed = picked.reduce((n, u) => n + Object.keys(u.renames ?? {}).length, 0);
  const parts: string[] = [];
  const head = [`改名 / 移动 ${movingFiles(run)} 个文件`, s.plannedMkdir ? `新建 ${s.plannedMkdir} 个目录` : "", s.plannedRmdir ? `删掉 ${s.plannedRmdir} 个腾空的目录` : ""]
    .filter(Boolean)
    .join("，");
  parts.push(`在「${taskText(task)}」上执行整理（${scopeSummary(run)}）：${picked.length} 部作品，${head}。`);
  const confText = [conf.high ? `把握大 ${conf.high}` : "", conf.medium ? `一般 ${conf.medium}` : "", conf.low ? `把握小 ${conf.low}` : ""].filter(Boolean).join("、");
  parts.push(
    local
      ? `名字和位置照本地 strm 的目录结构来，不经过 TMDB 识别${skippedByChoice ? `；${skippedByChoice} 部没勾，这次不动` : ""}。`
      : `识别：${confText}${manual ? `（其中手动指定 ${manual}）` : ""}${unmatched ? `；${unmatched} 部认不出来，这次不动` : ""}${skippedByChoice ? `；${skippedByChoice} 部没勾，这次不动` : ""}。`,
  );
  const manualEdits = [retitled ? `改了标题 / 年份 ${retitled} 部` : "", pinned ? `钉了季 / 集 ${pinned} 个文件` : "", renamed ? `手动改名 ${renamed} 个文件` : ""].filter(Boolean);
  if (manualEdits.length) parts.push(`其中${manualEdits.join("、")}。`);
  if (s.conflicts) parts.push(`还有 ${s.conflicts} 个冲突没处理，这些文件留在原处。`);
  if (s.plannedDelete) parts.push(`会删掉 ${s.plannedDelete} 个文件（进网盘回收站，撤销退不回来）。`);
  if (referenced) parts.push(`执行后会自动改写 ${referenced} 条追更 / 云下载记着的目录。`);
  if (outdated) parts.push(`这份清单是 ${fmtTime(outdated.at * 1000)} ${outdated.kind === "changed" ? "之前做的，之后同一个任务又整理过" : "做的，已经超过一天"}，网盘可能变了，执行时对不上的项会跳过。`);
  parts.push(`执行后能撤销${s.plannedDelete ? "（删掉的除外）" : ""}。`);
  return parts.join("");
}

/* ------------------------------- 清单 ------------------------------- */

/** 为什么要拿主意；排序也按这个顺序（越靠前越要紧） */
export type UnitWhy = "unmatched" | "failed" | "conflict" | "delete" | "low" | "medium" | "skipped" | "notes";
const WHY_ORDER: UnitWhy[] = ["unmatched", "failed", "conflict", "delete", "low", "medium", "skipped", "notes"];

/**
 * 这个单元要不要人（或 agent）拿主意、为什么。和整理页「要处理」同一个口径（前端 UnitList.tsx 的 rowOf：没识别、
 * 待执行时把握不是 high、有冲突、有失败、跳过里有要看一眼的），再加两条：有删除项、待执行时有单元说明（绝对集数折算这类要核对的）
 */
export function whyOf(u: OrganizeUnit, c: OrganizeUnitCounts | undefined, ready: boolean, unitItems: OrganizeItem[]): UnitWhy[] {
  const why: UnitWhy[] = [];
  if (!u.match && !isLocalUnitKey(u.key)) why.push("unmatched");
  if (c?.failed) why.push("failed");
  if (c?.conflicts) why.push("conflict");
  if (unitItems.some((it) => it.action === "delete")) why.push("delete");
  if (u.match && ready && u.match.confidence === "low") why.push("low");
  if (u.match && ready && u.match.confidence === "medium") why.push("medium");
  if (c?.skipped) why.push("skipped");
  if (ready && u.notes.length > 0) why.push("notes");
  return why;
}

export const whyRank = (why: UnitWhy[]): number => Math.min(...why.map((w) => WHY_ORDER.indexOf(w)), WHY_ORDER.length);

const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
/** p 在 root 下面时给相对 root 的路径，不在就是 null（root 为空是任务根） */
const under = (p: string, root: string): string | null => (root === "" ? p : p === root ? "" : p.startsWith(`${root}/`) ? p.slice(root.length + 1) : null);

const SE = /S(\d{1,3})E(\d{1,4})(?:-E(\d{1,4}))?/i;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 一串集数压成区间：1,2,3,5 → E01–E03, E05 */
function episodeRanges(eps: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < eps.length; ) {
    let j = i;
    while (j + 1 < eps.length && eps[j + 1] === eps[j] + 1) j++;
    out.push(i === j ? `E${pad2(eps[i])}` : `E${pad2(eps[i])}–E${pad2(eps[j])}`);
    i = j + 1;
  }
  return out.join(", ");
}

/**
 * 剧集单元：整理后文件名里的集数（按季压成区间），对照 TMDB 那几季的集数——偏移、绝对集数折算对不对一眼看得出。
 * 冲突项也算：它的目标名同样是按识别结果算出来的，只是位置被占了
 */
export function episodesOf(u: OrganizeUnit, unitItems: OrganizeItem[]): { files: string; tmdb?: string } | undefined {
  if (u.match?.mediaType !== "tv") return undefined;
  const bySeason = new Map<number, Set<number>>();
  for (const it of unitItems) {
    if (it.kind !== "video" || !(it.action === "rename" || it.action === "move" || it.action === "keep" || it.action === "conflict")) continue;
    const m = SE.exec(baseOf(it.dstPath));
    if (!m) continue;
    const season = Number(m[1]);
    const from = Number(m[2]);
    const to = m[3] ? Math.min(Number(m[3]), from + 50) : from;
    const set = bySeason.get(season) ?? new Set<number>();
    for (let e = from; e <= to; e++) set.add(e);
    bySeason.set(season, set);
  }
  if (bySeason.size === 0) return undefined;
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  let files = seasons.map((s) => `S${pad2(s)}: ${episodeRanges([...bySeason.get(s)!].sort((a, b) => a - b))}`).join("；");
  if (files.length > 300) files = `${files.slice(0, 299)}…`;
  const tmdb = (u.match.seasons ?? []).filter((x) => bySeason.has(x.season)).map((x) => `S${pad2(x.season)} 共 ${x.episodeCount} 集`);
  return { files, ...(tmdb.length ? { tmdb: tmdb.join("；") } : {}) };
}

/** 单元说明最多给几条、每条最长多少字 */
const NOTES_SHOWN = 3;
const NOTE_MAX = 200;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const compactCounts = (c: OrganizeUnitCounts | undefined): Record<string, number> =>
  c ? Object.fromEntries(Object.entries(c).filter(([k, v]) => k !== "total" && v > 0)) : {};

export interface UnitViewOptions {
  ready: boolean;
  /** 给不给前两项的「从哪到哪」 */
  sample: boolean;
}

/** 一个单元的完整样子（要拿主意的、或者点名看的） */
export function unitView(
  u: OrganizeUnit,
  refs: RunRefs,
  c: OrganizeUnitCounts | undefined,
  unitItems: OrganizeItem[],
  task: TaskDefinition,
  opts: UnitViewOptions,
): Record<string, unknown> {
  const why = whyOf(u, c, opts.ready, unitItems);
  const unsure = why.includes("unmatched") || why.includes("low") || why.includes("medium");
  const candidates = unsure ? (u.match?.candidates ?? []).filter((x) => !(u.match && x.tmdbId === u.match.tmdbId && x.mediaType === u.match.mediaType)).slice(0, 3) : [];
  const episodes = episodesOf(u, unitItems);
  const counts = compactCounts(c);
  const sample = opts.sample
    ? unitItems
        .filter((it) => it.action === "rename" || it.action === "move")
        .slice(0, 2)
        .map((it) => {
          const from = relOf(task, it.srcPath);
          const to = relOf(task, it.dstPath);
          return { from: under(from, u.rootPath) ?? from, to: (u.dstRoot && under(to, u.dstRoot)) || to };
        })
    : [];
  return {
    ref: refs.unitRef(u.key),
    ...(why.length ? { why } : {}),
    source: u.rawName,
    path: u.rootPath || "（范围根）",
    ...(u.parsedTitle ? { parsed: { title: u.parsedTitle, ...(u.parsedYear ? { year: u.parsedYear } : {}) } } : {}),
    match: u.match
      ? { type: u.match.mediaType, tmdbId: u.match.tmdbId, title: u.match.title, year: u.match.year, confidence: u.match.confidence, reason: u.match.reason }
      : null,
    ...(isLocalUnitKey(u.key) ? { naming: "local", target: u.dstRoot || "（任务根）" } : {}),
    ...(candidates.length ? { candidates: candidates.map((x) => ({ type: x.mediaType, tmdbId: x.tmdbId, title: x.title, year: x.year })) } : {}),
    selected: u.selected,
    ...(u.seasonOverride !== null ? { season: u.seasonOverride } : {}),
    ...(u.episodeOffset ? { episodeOffset: u.episodeOffset } : {}),
    ...(u.titleOverride ? { title: u.titleOverride } : {}),
    ...(u.yearOverride ? { year: u.yearOverride } : {}),
    ...(u.dstRoot ? { dst: u.dstRoot } : {}),
    ...(episodes ? { episodes } : {}),
    ...(Object.keys(counts).length ? { files: counts } : {}),
    ...(u.referencedBy ? { referencedBy: u.referencedBy } : {}),
    // 绝对集数折算这类说明一个文件一条，几百集的番能有几百条：只给前几条，其余给个数
    ...(u.notes.length ? { notes: u.notes.slice(0, NOTES_SHOWN).map((n) => clip(n, NOTE_MAX)) } : {}),
    ...(u.notes.length > NOTES_SHOWN ? { notesMore: u.notes.length - NOTES_SHOWN } : {}),
    ...(u.remember ? { remember: true } : {}),
    ...(sample.length ? { sample } : {}),
  };
}

/** 把握大、没问题的单元折成一行 */
export function unitLine(u: OrganizeUnit, refs: RunRefs, c: OrganizeUnitCounts | undefined): Record<string, unknown> {
  return {
    ref: refs.unitRef(u.key),
    ...(u.match ? { title: u.match.title, year: u.match.year, type: u.match.mediaType } : { source: u.rawName }),
    ...(u.selected ? {} : { selected: false }),
    ...(c?.changing ? { changing: c.changing } : {}),
    ...(c?.done ? { done: c.done } : {}),
  };
}

/**
 * 一个文件：从哪（相对单元根）到哪（相对作品目录）、动作、原因、选的办法；执行过的带状态和失败原因。
 * 「覆盖」带出来的删除项没有编号，说一句怎么撤回
 */
export function fileView(
  it: OrganizeItem,
  u: OrganizeUnit,
  refs: RunRefs,
  task: TaskDefinition,
  extra: { resolution?: OrganizeConflictResolution; excluded?: boolean; byReplace?: boolean },
): Record<string, unknown> {
  const from = relOf(task, it.srcPath);
  const to = relOf(task, it.dstPath);
  const moves = it.dstPath !== it.srcPath;
  return {
    ...(extra.byReplace
      ? { note: "覆盖带出来的：删掉目标位置原来那份。要撤回就把选了覆盖的那一项的 resolve 改掉" }
      : { ref: refs.fileRef(it.unitKey, it.srcPath) }),
    kind: it.kind,
    action: it.action,
    from: under(from, u.rootPath) ?? from,
    ...(moves ? { to: (u.dstRoot && under(to, u.dstRoot)) || to } : {}),
    ...(it.reason ? { reason: it.reason } : {}),
    ...(extra.resolution ? { resolve: extra.resolution } : {}),
    ...(extra.excluded ? { excluded: true } : {}),
    ...(u.pins?.[it.srcPath] ? { pin: u.pins[it.srcPath] } : {}),
    ...(u.renames?.[it.srcPath] ? { newName: u.renames[it.srcPath] } : {}),
    ...(it.status !== "pending" ? { status: it.status } : {}),
    ...(it.error ? { error: it.error } : {}),
    ...(it.errorKind ? { errorKind: it.errorKind } : {}),
    ...(it.givenUp ? { givenUp: true } : {}),
  };
}

/* ------------------------------- 失败分组 ------------------------------- */

/**
 * 每组一句「为什么、下一步做什么」：和整理页失败面板同一套说法（前端 lib/organize.ts 的 failureGroupMeta）。
 * why 是原因，how 是用工具怎么处理（要「改网盘」档）；令牌没有这一档时 how 换成请用户在整理页处理，别指向它调不了的工具
 */
function groupText(key: OrganizeFailureGroupKey, stage: OrganizeRunStage): { label: string; why: string; how: string } {
  if (stage === "revert") {
    switch (key) {
      case "blocked":
        return { label: "网盘拒绝", why: "退回时被风控或登录失效拦住", how: "账号处理好之后继续撤销（organize_revert）" };
      case "transient":
        return { label: "临时失败", why: "退回时网络或网盘抖动", how: "继续撤销再试一次（organize_revert）" };
      case "rejected":
        return { label: "改回原名被拒", why: "原来的名字网盘不再接受（多半是原位置又有了同名文件）", how: "继续撤销再试（organize_revert），或放弃（organize_skip）让文件留在整理后的位置" };
      case "stale":
        return { label: "退回时找不到位置", why: "原目录或文件的位置和记录对不上", how: "继续撤销再试（organize_revert），或放弃（organize_skip）让文件留在整理后的位置" };
      case "lost":
        return { label: "已找不到", why: "文件已不在整理后的位置，或位置上是另一个文件", how: "没法退回，只能放弃（organize_skip）" };
      case "mirror":
        return { label: "已退回，本地未同步", why: "网盘已经退回原处，本地 strm 没跟上", how: "继续撤销只补本地（organize_revert）" };
      default:
        return { label: key, why: "", how: "" };
    }
  }
  switch (key) {
    case "blocked":
      return { label: "网盘拒绝", why: "风控或登录失效，整理已停下", how: "只能由用户在「账户」页处理好，之后用 organize_apply 重试" };
    case "transient":
      return { label: "临时失败", why: "网络、超时或网盘抖动，执行时已自动重试过一次", how: "用 organize_apply 再试一次多半就好" };
    case "stale":
      return {
        label: "预览后变了",
        why: "文件已不在预览时的位置、目录没了或目标位置被占",
        how: "用 organize_preview(again) 按现在的网盘重新预览，或 organize_skip 放弃；重试只会再失败",
      };
    case "rejected":
      return { label: "名字不被接受", why: "网盘不接受这个名字或目标已存在", how: "请用户改模板 / 识别词后重新预览，或 organize_skip 放弃" };
    case "mirror":
      return { label: "本地未同步", why: "网盘已经改好，本地 strm 没跟上", how: "organize_apply 重试只补本地，不碰网盘" };
    case "pending":
      return { label: "没做完", why: "整理中途停下了（风控、取消或进程重启），这些项还没轮到", how: "organize_apply 接着做" };
    case "lost":
      return { label: "已找不到", why: "", how: "" };
  }
}

/** canAct：令牌有没有「改网盘」档（重试、放弃、撤销、重新预览都要它，重新预览另要「运行」档） */
export function failureViews(
  groups: OrganizeFailureGroup[],
  stage: OrganizeRunStage,
  items: OrganizeItem[],
  refs: RunRefs,
  task: TaskDefinition | undefined,
  canAct = true,
) {
  const byId = new Map(items.map((it) => [it.id, it]));
  return groups.map((g) => {
    const t = groupText(g.key, stage);
    const how = canAct ? t.how : "这个令牌处理不了（没有「改网盘」档），请用户在 OpenStrm 的整理页里处理（openInUi 是链接）";
    const hint = [t.why, how].filter(Boolean).join("：");
    const shown = g.itemIds
      .slice(0, 10)
      .map((id) => byId.get(id))
      .filter((it): it is OrganizeItem => !!it)
      .map((it) => refs.fileRef(it.unitKey, it.srcPath) ?? `${it.kind === "dir" ? "目录" : "文件"} ${task ? relOf(task, it.srcPath) : it.srcPath}`);
    return {
      group: g.key,
      label: t.label,
      count: g.itemIds.length,
      can: [g.retry ? "retry" : "", g.skip ? "skip" : "", g.repreview ? "repreview" : ""].filter(Boolean),
      ...(g.held ? { held: g.held } : {}),
      ...(g.deletes ? { deletes: g.deletes } : {}),
      hint,
      files: shown,
    };
  });
}
