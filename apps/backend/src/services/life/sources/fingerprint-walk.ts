/**
 * 按目录指纹拼出任务目录的整棵树，给快照式变更源（夸克）用：每轮不用整棵列，只列变了的目录。
 *
 * 依据（2026-10-14 夸克真机实测）：目录的 updated_at 在直接子项新增 / 移入 / 改名时刷新，删除 / 移出不刷新，
 * 孙辈的变化不往上冒；子项数（include_items）随增删实时变。所以 (updated_at, 子项数) 和上次一样，这个目录的直接子项就没变——
 * 只有一个例外：刷新之后约 5.5 秒内的变化不再刷新它（节流），这段时间里的改名条数不变、时间也不变。
 *
 * 增量一轮：
 *   1. 快照里的根和所有目录按路径批量取指纹（夸克 path_list，50 个一批）；
 *   2. 要列的：指纹变了的；按原路径找不到或换了 id 的（改名、移走、被同名顶替）——列它的父目录；
 *      上一轮因为刚变过才列的（recheck）——那次可能正处在节流窗口里，隔了一轮再列一次就一定看全了；
 *      子目录超过 100 个的大平铺目录每轮直接列（一页 100 条，比 path_list 一批 50 个便宜），子目录的指纹从列表里拿；
 *   3. 列这些目录，列出来的子目录再比一次指纹：新的、变了的、带 recheck 的接着列；
 *   4. 从根往下拼新树：列过的目录用新列表，没列的沿用快照里它的子项（搬过的改前缀）。
 * 存进快照的目录指纹是「列它之前」看到的那份：列完之后才发生的变化，下一轮指纹对不上还会再列。
 *
 * 整棵列（首轮、旧格式快照、定期兜底）也走这里给出的 recheck 规则，并顺带自检：
 * 指纹没变（增量不会去列）、也没挂 recheck 的目录，子项却变了，就是增量漏了。
 */
import { mapLimit } from "../../../lib/async.js";
import type { DirFingerprint, DriveEntry, DriveProvider, ReadOptions, SubtreeEntry } from "../../drive/types.js";

/** 快照里的一条；目录带指纹（modifiedAt = updated_at、items = 子项数） */
export interface SnapEntry extends SubtreeEntry {
  /** 这一轮是因为刚变过才列的：列的时候可能正处在节流窗口里，下一轮无条件再列一次 */
  recheck?: boolean;
}

/** 快照的 meta：根目录自己的指纹（根不在 entries 里）和上次整棵对比的时间 */
export interface SnapMeta {
  rootId: string;
  modifiedAt: number;
  items: number;
  recheck?: boolean;
  /** 毫秒 */
  fullAt: number;
}

export interface WalkResult {
  entries: SnapEntry[];
  meta: SnapMeta;
  /** 这一轮列了几个目录 */
  listed: number;
  /** 问了几个目录的指纹 */
  asked: number;
  /** 按原路径没找到的目录（相对根），给日志看 */
  missing: string[];
}

/** 子目录比这个多的目录每轮直接列，不逐个问子目录的指纹 */
export const BIG_DIR_SUBDIRS = 100;
/** 首轮没有上一份可比：updated_at 离现在这么近的目录当作刚变过，下一轮再列一次 */
const FRESH_MS = 10 * 60_000;

const parentRel = (rel: string): string => {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
};
const baseName = (rel: string): string => rel.slice(rel.lastIndexOf("/") + 1);
const joinRel = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);
/** 根（绝对路径，带前导 /）+ 相对路径 → 绝对路径 */
export const absPath = (root: string, rel: string): string => (rel === "" ? root : root === "/" ? `/${rel}` : `${root}/${rel}`);

const fpOf = (e: { id: string; modifiedAt?: number; items?: number }): DirFingerprint => ({ id: e.id, modifiedAt: e.modifiedAt ?? 0, items: e.items ?? 0 });
const sameFp = (a: DirFingerprint, b: { modifiedAt?: number; items?: number }): boolean => a.modifiedAt === (b.modifiedAt ?? 0) && a.items === (b.items ?? 0);

/** 快照是不是带指纹的新格式：有 meta、每个目录都记了子项数 */
export function hasFingerprints(snap: { entries: SnapEntry[]; meta: SnapMeta | null }): snap is { entries: SnapEntry[]; meta: SnapMeta } {
  return !!snap.meta?.rootId && snap.entries.every((e) => !e.isDir || typeof e.items === "number");
}

type Why = "changed" | "new" | "recheck" | "parent" | "big";

/**
 * 增量拼树。根自己按路径找不到、或者换了一个（删了重建）返回 null，调用方改整棵列。
 * onSkip：名字里带 / 的条目按路径找不回来，跳过（和 walkSubtree 一样）。
 */
export async function incrementalWalk(
  provider: Required<Pick<DriveProvider, "dirFingerprints" | "listDir">>,
  root: string,
  prev: { entries: SnapEntry[]; meta: SnapMeta },
  opts: { signal: AbortSignal; onSkip?: (dir: string, name: string) => void },
): Promise<WalkResult | null> {
  const { signal } = opts;
  const io: ReadOptions = { signal, background: true };

  // 旧快照的索引；根不在 entries 里，补一条相对路径为空的
  const rootEntry: SnapEntry = {
    path: "",
    id: prev.meta.rootId,
    isDir: true,
    modifiedAt: prev.meta.modifiedAt,
    items: prev.meta.items,
    ...(prev.meta.recheck ? { recheck: true } : {}),
  };
  const dirByRel = new Map<string, SnapEntry>([["", rootEntry]]);
  const dirById = new Map<string, SnapEntry>([[rootEntry.id, rootEntry]]);
  const kidsOf = new Map<string, SnapEntry[]>();
  for (const e of prev.entries) {
    if (e.isDir) {
      dirByRel.set(e.path, e);
      dirById.set(e.id, e);
    }
    const p = parentRel(e.path);
    const list = kidsOf.get(p);
    if (list) list.push(e);
    else kidsOf.set(p, [e]);
  }
  const big = new Set([...dirByRel.keys()].filter((rel) => (kidsOf.get(rel) ?? []).filter((e) => e.isDir).length > BIG_DIR_SUBDIRS));

  // 1. 取指纹：大平铺目录的子目录不问，列它的时候顺带拿到
  const ask = [...dirByRel.keys()].filter((rel) => rel === "" || !big.has(parentRel(rel)));
  const fps = await provider.dirFingerprints(
    ask.map((rel) => absPath(root, rel)),
    io,
  );
  const rootFp = fps.get(root);
  if (!rootFp || rootFp.id !== prev.meta.rootId) return null;

  /** 每个目录「列它之前」最后看到的指纹 */
  const seen = new Map<string, DirFingerprint>();
  const why = new Map<string, Why>();
  const want = (id: string, reason: Why): void => {
    const cur = why.get(id);
    if (cur === "changed" || cur === "new") return;
    if (!cur || reason === "changed" || reason === "new") why.set(id, reason);
  };
  const missing: string[] = [];
  const found = new Set<string>();
  for (const rel of ask) {
    const d = dirByRel.get(rel)!;
    const fp = fps.get(absPath(root, rel));
    if (!fp || fp.id !== d.id) {
      missing.push(rel);
      continue;
    }
    found.add(rel);
    seen.set(d.id, fp);
    if (!sameFp(fp, d)) want(d.id, "changed");
    else if (d.recheck) want(d.id, "recheck");
  }
  // 按原路径找不到（改名、移走、被同名的顶替、path_list 认不出这个名字）：列离它最近的、还找得到的上级就知道了。
  // 上级自己也找不到（整个剧目录改了名）就接着往上：改名的那个目录会从更上一级的列表里被发现，指纹是列它之前看到的。
  // 本来就没问的上级（大平铺目录的子目录，指纹从列表里拿）停在它那儿
  const asked = new Set(ask);
  for (const rel of missing) {
    let up = parentRel(rel);
    while (up !== "" && asked.has(up) && !found.has(up)) up = parentRel(up);
    want((dirByRel.get(up) ?? rootEntry).id, "parent");
  }
  for (const rel of big) want(dirByRel.get(rel)!.id, "big");

  // 2. 列：列出来的子目录再比一次指纹，新的 / 变了的 / 带 recheck 的接着列
  const listed = new Map<string, DriveEntry[]>();
  let queue = [...why.keys()];
  while (queue.length > 0) {
    signal.throwIfAborted();
    const wave = [...new Set(queue)].filter((id) => !listed.has(id));
    queue = [];
    // 先占位：同一波里另一个目录列出来的它，是在列它之后看到的，不能当它的指纹存
    for (const id of wave) listed.set(id, []);
    const results = await mapLimit(wave, 4, (id) => provider.listDir(id, signal, { fresh: true, background: true }));
    wave.forEach((id, i) => {
      const kids = results[i]!;
      listed.set(id, kids);
      for (const k of kids) {
        if (!k.isDir || listed.has(k.id)) continue;
        const fp = fpOf(k);
        seen.set(k.id, fp);
        const known = dirById.get(k.id);
        if (!known) want(k.id, "new");
        else if (!sameFp(fp, known)) want(k.id, "changed");
        else if (known.recheck) want(k.id, "recheck");
        else continue;
        queue.push(k.id);
      }
    });
  }

  // 3. 拼树。列过的目录里出现的每个条目 → 它现在的父目录：没列的目录沿用旧子项时，已经在别处列出来的别再算它的
  const freshParent = new Map<string, string>();
  for (const [pid, kids] of listed) for (const k of kids) freshParent.set(k.id, pid);
  const entries: SnapEntry[] = [];
  const placed = new Set<string>([rootFp.id]);
  /** 拼的时候发现对不上（旧子项已经在别处出现）的目录：下一轮再列 */
  const diverged = new Set<string>();
  const recheckAfterListing = (id: string): boolean => {
    const reason = why.get(id);
    return reason === "changed" || reason === "new";
  };

  const place = (dirId: string, rel: string, oldRel: string | null): void => {
    const fresh = listed.get(dirId);
    const children: SnapEntry[] = [];
    if (fresh) {
      for (const k of fresh) {
        if (k.name.includes("/")) {
          opts.onSkip?.(rel, k.name);
          continue;
        }
        children.push({ path: joinRel(rel, k.name), id: k.id, isDir: k.isDir, size: k.size, modifiedAt: k.modifiedAt });
      }
    } else if (oldRel !== null) {
      for (const k of kidsOf.get(oldRel) ?? []) {
        const now = freshParent.get(k.id);
        if (now !== undefined && now !== dirId) {
          diverged.add(dirId);
          continue;
        }
        children.push({ ...k, path: joinRel(rel, baseName(k.path)) });
      }
    }
    for (const c of children) {
      if (placed.has(c.id)) {
        diverged.add(dirId);
        continue;
      }
      placed.add(c.id);
      if (!c.isDir) {
        entries.push(c);
        continue;
      }
      const known = dirById.get(c.id);
      const fp = seen.get(c.id) ?? (known ? fpOf(known) : fpOf(c));
      const entry: SnapEntry = { path: c.path, id: c.id, isDir: true, size: c.size, modifiedAt: fp.modifiedAt, items: fp.items };
      if (listed.has(c.id) ? recheckAfterListing(c.id) : known?.recheck) entry.recheck = true;
      entries.push(entry);
      place(c.id, c.path, known ? known.path : null);
    }
  };
  place(rootFp.id, "", "");

  if (diverged.size > 0) {
    for (const e of entries) if (e.isDir && diverged.has(e.id)) e.recheck = true;
  }
  const rootRecheck = (listed.has(rootFp.id) ? recheckAfterListing(rootFp.id) : !!prev.meta.recheck) || diverged.has(rootFp.id);
  return {
    entries,
    meta: { rootId: rootFp.id, modifiedAt: rootFp.modifiedAt, items: rootFp.items, fullAt: prev.meta.fullAt, ...(rootRecheck ? { recheck: true } : {}) },
    listed: listed.size,
    asked: ask.length,
    missing,
  };
}

/** 按父目录（相对路径，根是 ""）分组的子项签名：`[id, 名字]` 排序后拼起来，比两份快照的同一个目录子项一样不一样 */
function childSignatures(list: SnapEntry[]): Map<string, string> {
  const m = new Map<string, string[]>();
  for (const e of list) {
    const p = parentRel(e.path);
    const key = JSON.stringify([e.id, baseName(e.path)]);
    const arr = m.get(p);
    if (arr) arr.push(key);
    else m.set(p, [key]);
  }
  return new Map([...m].map(([p, arr]) => [p, arr.sort().join(",")]));
}

/**
 * 要存的快照和这一轮实际看到的对不上的目录挂 recheck：被压下的大比例删除（消失的条目先留在快照里）、处理失败剔掉 / 放回去的变更。
 * 不挂的话下一轮它的指纹和存的一样、不会去列，留在快照里的东西就永远不会再对比一次
 */
export function markDiverged(stored: SnapEntry[], observed: SnapEntry[], meta: SnapMeta): { entries: SnapEntry[]; meta: SnapMeta } {
  if (stored === observed) return { entries: stored, meta };
  const a = childSignatures(stored);
  const b = childSignatures(observed);
  const diverged = new Set<string>();
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) diverged.add(k);
  if (diverged.size === 0) return { entries: stored, meta };
  return {
    entries: stored.map((e) => (e.isDir && diverged.has(e.path) && !e.recheck ? { ...e, recheck: true } : e)),
    meta: diverged.has("") && !meta.recheck ? { ...meta, recheck: true } : meta,
  };
}

/**
 * 整棵列。有 dirFingerprints 的先拿根自己的指纹（列之前看到的那份），没有的（测试里不开指纹的假网盘）meta 里的根指纹是空的，
 * 下一轮照样整棵列。
 *
 * recheck：和上一份带指纹的快照比，指纹变了的、新出现的目录挂上；没有可比的（首轮、旧格式）按 updated_at 离现在近不近估。
 * misses：上一份是带指纹的快照时自检——指纹没变、也没挂 recheck 的目录，子项却和快照里不一样，就是增量漏掉的（相对根的路径，根是 ""）。
 */
export async function fullScan(
  provider: DriveProvider,
  root: string,
  prev: { entries: SnapEntry[]; meta: SnapMeta | null } | null,
  opts: { signal: AbortSignal; now?: number },
): Promise<WalkResult & { misses: string[] }> {
  const io: ReadOptions = { signal: opts.signal, background: true };
  const rootFp = provider.dirFingerprints ? (await provider.dirFingerprints([root], io)).get(root) : undefined;
  const walked = await provider.walkSubtree!(root, { id: rootFp?.id, ...io });
  const now = opts.now ?? Date.now();
  const base = prev && hasFingerprints(prev) ? prev : null;
  const prevDirs = new Map<string, SnapEntry>(base ? base.entries.filter((e) => e.isDir).map((e) => [e.id, e]) : []);
  const isRecent = (fp: { modifiedAt?: number }): boolean => now - (fp.modifiedAt ?? 0) < FRESH_MS;
  const changed = (e: SnapEntry, old: { modifiedAt?: number; items?: number } | undefined): boolean =>
    base ? !old || !sameFp(fpOf(e), old) : isRecent(e);

  const entries: SnapEntry[] = walked.map((e) => (e.isDir && changed(e, prevDirs.get(e.id)) ? { ...e, recheck: true } : e));
  const rootChanged = rootFp
    ? base
      ? base.meta.rootId !== rootFp.id || !sameFp(rootFp, base.meta)
      : isRecent(rootFp)
    : false;
  const meta: SnapMeta = {
    rootId: rootFp?.id ?? "",
    modifiedAt: rootFp?.modifiedAt ?? 0,
    items: rootFp?.items ?? 0,
    fullAt: now,
    ...(rootChanged ? { recheck: true } : {}),
  };

  const misses: string[] = [];
  if (base && rootFp) {
    const before = childSignatures(base.entries);
    const after = childSignatures(walked);
    const prevPathOf = new Map<string, string>([[base.meta.rootId, ""], ...base.entries.filter((e) => e.isDir).map((e): [string, string] => [e.id, e.path])]);
    // 根和每个目录：增量会跳过它（指纹没变、没挂 recheck），子项却变了
    const quiet: Array<{ rel: string; id: string }> = [];
    if (base.meta.rootId === rootFp.id && sameFp(rootFp, base.meta) && !base.meta.recheck) quiet.push({ rel: "", id: rootFp.id });
    for (const e of walked) {
      if (!e.isDir) continue;
      const old = prevDirs.get(e.id);
      if (old && !old.recheck && sameFp(fpOf(e), old)) quiet.push({ rel: e.path, id: e.id });
    }
    for (const q of quiet) {
      const oldRel = prevPathOf.get(q.id);
      if (oldRel === undefined) continue;
      if ((before.get(oldRel) ?? "") !== (after.get(q.rel) ?? "")) misses.push(q.rel);
    }
  }
  return { entries, meta, listed: walked.filter((e) => e.isDir).length + 1, asked: rootFp ? 1 : 0, missing: [], misses };
}
