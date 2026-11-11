/**
 * 设置页「网盘挂载」：各网盘账号挂在 OpenList / CloudDrive2 里的哪个位置（挂载映射）。
 * 两家共用一套——路径归一、撞车、拼任务目录、输入框示例，免得一家有的校验另一家没有。
 */
import type { CopyEngine } from "@openstrm/shared";

/** 挂载层的两家，和复制引擎是同一组值 */
export type MountLayerKind = CopyEngine;

/**
 * 两家在界面上的叫法：title 全名、short 简称、field 各网盘那一栏叫什么、anchor 设置页「网盘挂载」里那块面板的锚点。
 * 设置页两节、任务弹框的提示、任务列表的徽标都从这里取，改一个叫法不用到处找
 */
export const LAYER_META: Record<MountLayerKind, { title: string; short: string; field: string; anchor: string }> = {
  openlist: { title: "OpenList", short: "OpenList", field: "挂载根", anchor: "openlist" },
  cd2: { title: "CloudDrive2", short: "CD2", field: "路径", anchor: "cd2" },
};

/** 比较路径用：和后端 normConfigDir 一样去空白、收斜杠、去尾斜杠、补头斜杠（只剩 / 的保留） */
export function mountKey(raw: string): string {
  const t = raw.trim().replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
  return t && !t.startsWith("/") ? `/${t}` : t;
}

/**
 * 同一家里两个网盘账号填了同一个路径：账号名 → 和它撞的其他账号名。
 *
 * 不同的网盘账号挂在不同的位置，填成一样的话复制会到别的账号里找文件——两边路径碰巧一样时就复制成了别人的那份，
 * 开了删源还会删掉这边的原件。「检查」查不出这个：两边目录结构一样时每条路径都打得开。
 * 只算 accounts 里还在的网盘账号（删掉的账号留下的旧行页面上看不到、也改不了）；空的不算。
 */
export function mountClashes(mounts: Record<string, string> | undefined, accounts: readonly string[]): Map<string, string[]> {
  const byMount = new Map<string, string[]>();
  for (const [acc, raw] of Object.entries(mounts ?? {})) {
    const key = mountKey(raw ?? "");
    if (!key || !accounts.includes(acc)) continue;
    byMount.set(key, [...(byMount.get(key) ?? []), acc]);
  }
  const clashes = new Map<string, string[]>();
  for (const names of byMount.values()) {
    if (names.length < 2) continue;
    for (const n of names) clashes.set(n, names.filter((o) => o !== n));
  }
  return clashes;
}

/**
 * 设置里给这一家选的账号还在不在。missing：选了，但账户页里没有这个名字的这类账号（删了，或者选成了别的类型）；
 * usable：选了而且没 missing。账号列表还没读到（null）时先当在，免得按钮闪一下灰、提示闪一下黄。
 * 设置页两节、任务弹框、copyGapInDialog 都按这一条判断
 */
export function layerAccountStatus(
  accounts: ReadonlyArray<{ name: string; accountType: string }> | null,
  kind: MountLayerKind,
  name: string | undefined,
): { missing: boolean; usable: boolean } {
  const n = (name ?? "").trim();
  const missing = n !== "" && accounts !== null && !accounts.some((a) => a.name === n && a.accountType === kind);
  return { missing, usable: n !== "" && !missing };
}

/**
 * 改一个网盘账号的路径：打字时原样留着（每敲一个键就去空白的话，路径中间的空格打不进去），只剩空白就删掉这一行。
 * 两头的空白在失焦和提交时去（tidyMounts）
 */
export function withMount(mounts: Record<string, string> | undefined, account: string, path: string): Record<string, string> {
  const next = { ...(mounts ?? {}) };
  if (path.trim()) next[account] = path;
  else delete next[account];
  return next;
}

/** 提交前收拾：去掉两头空白，空的不要。不收拾的话带空格的路径会原样存进去（后端读的时候会 trim，前端各处就得都记得 trim） */
export function tidyMounts(mounts: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!mounts) return mounts;
  const out: Record<string, string> = {};
  for (const [account, path] of Object.entries(mounts)) {
    const t = (path ?? "").trim();
    if (t) out[account] = t;
  }
  return out;
}

/** 挂载层里的路径拼接：中间只留一个斜杠，根还是 /。不 trim 每一段：网盘上真有「Season 1 」这种带尾空格的目录名 */
export function joinLayerPath(base: string, rel: string): string {
  return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`.replace(/\/+$/, "") || "/";
}

/** 检查结果的一行（和设置页 check-lines 的 CheckLine 同形） */
export type MountCheckLine = { tone: "ok" | "warn" | "bad"; text: string };

function someOf(items: readonly string[]): string {
  return `${items.slice(0, 2).join("、")}${items.length > 2 ? " 等" : ""}`;
}

/**
 * 「检查连接和路径」里一个网盘那一行的结论（这一行的路径本身已经打得开）。
 * - lost：任务目录在挂载层里找不到、网盘上却有（或者网盘那边没查成）——路径多半填错了：填成了别的网盘的根、少了一层；
 * - gone：任务目录在网盘上就不在（改了名、删了、还没建），挂载层里自然也没有——和这里填的路径无关，只提醒；
 * - clashWith：和这一家里别的网盘填了同一个路径（已经换成给人看的名字）。
 * lost、撞车算错；只有 gone 的话路径是对的，这一行是黄的
 */
export function mountRowVerdict(input: {
  /** OpenList / CD2 */
  short: string;
  /** 挂载根 / 路径 */
  field: string;
  /** 这个网盘账号下查了几个任务目录 */
  probed: number;
  /** 挂载层里的路径 */
  lost: readonly string[];
  /** 网盘上的路径 */
  gone: readonly string[];
  clashWith: readonly string[] | null;
}): MountCheckLine {
  const { short, field, probed, lost, gone, clashWith } = input;
  const goneNote = gone.length > 0 ? `；另有 ${gone.length} 个任务的目录在网盘上就不在（${someOf(gone)}）` : "";
  if (lost.length > 0) return { tone: "bad", text: `${lost.length} 个任务目录在 ${short} 里找不到（${someOf(lost)}）：${field}多半填错了${goneNote}` };
  if (clashWith && clashWith.length > 0) return { tone: "bad", text: `能打开，但和 ${clashWith.join("、")} 填的是同一个${field}，分不清是哪个网盘的文件${goneNote}` };
  const fine = probed - gone.length;
  if (gone.length > 0)
    return {
      tone: "warn",
      text: `能打开${fine > 0 ? `，${fine} 个任务目录对得上` : ""}；${gone.length} 个任务的目录在网盘上就不在（${someOf(gone)}），和${field}无关：看看这些任务的目录是不是改了名或删了`,
    };
  return { tone: "ok", text: probed > 0 ? `能打开，${probed} 个任务目录都对得上` : "能打开" };
}

/** 按网盘类型给的示例；CD2 里的根是添加云盘时起的名字，夸克默认叫「夸克网盘」 */
const EXAMPLE: Record<MountLayerKind, Record<string, string>> = {
  openlist: { "115": "/115", quark: "/quark" },
  cd2: { "115": "/115", quark: "/夸克网盘" },
};

/**
 * 输入框的示例：按网盘类型给（夸克那一行写 /115 会让人照抄错），认不出的类型用账号名；
 * 同类型有好几个账号时也用账号名：每一行都写 /115 会让人照抄成同一个
 */
export function mountExample(kind: MountLayerKind, account: { name: string; accountType: string }, sameKindCount: number): string {
  return sameKindCount > 1 ? `/${account.name}` : (EXAMPLE[kind][account.accountType] ?? `/${account.name}`);
}
