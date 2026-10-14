/**
 * 内存假网盘：功能测试（分享转存 / 追更 / 监控 / strm 校验 / 路由）共用的 Provider 桩。
 * 通过 drive/registry.ts 的 setDriveProviderFactory 注入，替代以前各服务自己的 deps 桩。
 *
 * 路径一律 `/a/b` 形式；节点 id 自动分配（n1, n2…），根是 "0"。
 * 分享：shares 里每个分享码一棵树，receive 把节点复制进网盘树并回顶层 id。
 * 变更：测试往 changes.queue 推事件，pull 一次全吐出来。
 */
import type { AccountInfo, LifePullMode, TaskDefinition } from "@openstrm/shared";
import { syncViewFromPaths } from "../services/drive/subtree.js";
import {
  normalizePath,
  RemoteDirNotFoundError,
  ShareGoneError,
  splitPath,
  type AccountIssue,
  resolvedChange,
  type ChangeCursor,
  type ChangeEvent,
  type ChangeSource,
  type PullResult,
  type DriveEntry,
  type DriveKind,
  type DriveLink,
  type DriveNode,
  type DriveProvider,
  type DriveWriteOps,
  type ReceiveItem,
  type ReceiveResult,
  type ShareEntry,
  type ShareInfo,
  type ShareListPage,
  type ShareProvider,
  type ShareRef,
  type ShareSession,
  type SubtreeEntry,
  type ShareUpdateSignal,
  type ShareUpdates,
  type WriteNode,
  type DirFingerprint,
  type ReadOptions,
} from "../services/drive/types.js";

export interface FakeNode {
  id: string;
  isDir: boolean;
  size?: number;
  hash?: string;
  modifiedAt?: number;
}

/**
 * 假网盘自己的路径归一：只收拢斜杠，不削每段首尾的空格——网盘上真有 `Season 1 ` 这种名字（夸克按名字找时是 trim 过再比的），
 * 树里得摆得出来。`normalizePath` 会把空格削掉，只用在「应用传进来的路径」上（见 find）
 */
const norm = (p: string): string => {
  const segs = p.split("/").filter(Boolean);
  return segs.length === 0 ? "/" : `/${segs.join("/")}`;
};
const parentOf = (p: string): string => norm(p.split("/").filter(Boolean).slice(0, -1).join("/"));
const baseOf = (p: string): string => splitPath(p).pop() ?? "";
const isUnder = (p: string, dir: string): boolean => dir === "/" ? p !== "/" : p.startsWith(`${dir}/`);

/**
 * 夸克式目录指纹（测试开了才模拟，见 FakeDriveOptions.fingerprints）：真机实测的规则——
 * 新建 / 移入 / 改名刷新父目录的 modifiedAt，删除 / 移出不刷新，孙辈不冒泡；被改名 / 移动的条目自己的时间也刷新。
 * 子项数不存，列的时候现数。
 */
export interface FakeFingerprintOptions {
  /** 父目录刷新后这么多毫秒内的变化不再刷新它（真机约 5500）；默认 0 = 每次都刷新 */
  throttleMs?: number;
  /** 时钟（毫秒）；默认从 2026-01-01 起每读一次加一秒，每次变化的时间都不一样 */
  clock?: () => number;
}

/** 一棵以路径为键的树 */
export class FakeTree {
  readonly nodes = new Map<string, FakeNode>();
  private seq = 0;
  /** 开了就按夸克的规则维护目录的 modifiedAt */
  fingerprints: { throttleMs: number; clock: () => number } | null = null;

  constructor(private readonly prefix: string) {}

  private nextId(): string {
    return `${this.prefix}${++this.seq}`;
  }

  /** 父目录的时间刷新（受节流窗口限制）；根没有节点，不管 */
  private touchParent(path: string, at: number): void {
    const parent = this.nodes.get(parentOf(path));
    if (!parent || !this.fingerprints) return;
    if (parent.modifiedAt !== undefined && at - parent.modifiedAt < this.fingerprints.throttleMs) return;
    parent.modifiedAt = at;
  }

  /** 新加一个节点：开了指纹的话它自己带上当前时间（显式给了 modifiedAt 的照用），父目录刷新 */
  private stamp(p: string, node: FakeNode, explicit: number | undefined): void {
    if (!this.fingerprints) return;
    const at = this.fingerprints.clock();
    node.modifiedAt = explicit ?? at;
    this.touchParent(p, at);
  }

  addDir(path: string, extra: Partial<FakeNode> = {}): FakeNode {
    const p = norm(path);
    if (p === "/") return { id: "0", isDir: true };
    const existing = this.nodes.get(p);
    if (existing) return existing;
    this.addDir(parentOf(p));
    const node: FakeNode = { id: this.nextId(), isDir: true, ...extra };
    this.nodes.set(p, node);
    this.stamp(p, node, extra.modifiedAt);
    return node;
  }

  addFile(path: string, extra: Partial<FakeNode> = {}): FakeNode {
    const p = norm(path);
    this.addDir(parentOf(p));
    const node: FakeNode = { id: this.nextId(), isDir: false, size: 1, ...extra };
    this.nodes.set(p, node);
    this.stamp(p, node, extra.modifiedAt);
    return node;
  }

  /** 删除：夸克上删除不刷新父目录的时间（子项数自然少了） */
  remove(path: string): void {
    const p = norm(path);
    for (const key of [...this.nodes.keys()]) if (key === p || isUnder(key, p)) this.nodes.delete(key);
  }

  /** 改名 / 移动：整棵子树跟着走，id 不变；开了指纹的话目标父目录刷新、源父目录不刷新、被挪的这一项自己刷新 */
  move(from: string, to: string): void {
    const a = norm(from);
    const b = norm(to);
    const moved: Array<[string, FakeNode]> = [];
    for (const [key, node] of this.nodes) {
      if (key === a || isUnder(key, a)) moved.push([`${b}${key.slice(a.length)}`, node]);
    }
    this.remove(a);
    this.addDir(parentOf(b));
    for (const [key, node] of moved) this.nodes.set(key, node);
    const top = this.nodes.get(b);
    if (top && this.fingerprints) {
      const at = this.fingerprints.clock();
      top.modifiedAt = at;
      this.touchParent(b, at);
    }
  }

  /** 目录的直接子项数（夸克 include_items） */
  itemCount(dir: string): number {
    return this.children(dir).length;
  }

  pathOf(id: string): string | null {
    if (id === "0" || id === "/") return "/";
    for (const [p, n] of this.nodes) if (n.id === id) return p;
    return null;
  }

  /**
   * 应用传进来的路径可能已经被 normalizePath 削掉了段首尾的空格：先精确找，再按「每段 trim 过再比」找一次，
   * 找出树里真正的那个路径。真网盘按名字找时也是 trim 过再比的（见夸克 quarkResolvePath）
   */
  realPath(path: string): string {
    const p = norm(path);
    if (p === "/" || this.nodes.has(p)) return p;
    const trimmed = (x: string) => x.split("/").map((seg) => seg.trim()).join("/");
    const want = trimmed(p);
    for (const key of this.nodes.keys()) if (trimmed(key) === want) return key;
    return p;
  }

  get(path: string): FakeNode | undefined {
    const p = this.realPath(path);
    return p === "/" ? { id: "0", isDir: true } : this.nodes.get(p);
  }

  children(dir: string): Array<{ path: string; node: FakeNode }> {
    const d = this.realPath(dir);
    return [...this.nodes]
      .filter(([p]) => parentOf(p) === d && p !== "/")
      .map(([path, node]) => ({ path, node }))
      .sort((x, y) => x.path.localeCompare(y.path));
  }

  descendants(dir: string): Array<{ path: string; node: FakeNode }> {
    const d = this.realPath(dir);
    return [...this.nodes]
      .filter(([p]) => isUnder(p, d))
      .map(([path, node]) => ({ path, node }))
      .sort((x, y) => x.path.localeCompare(y.path));
  }
}

export interface FakeShareDef {
  title: string;
  password?: string;
  tree: FakeTree;
  /** 设为 true 模拟分享失效 */
  gone?: boolean;
}

export class FakeShare implements ShareProvider {
  readonly shares = new Map<string, FakeShareDef>();
  readonly calls = { info: 0, list: 0, receive: 0, resolvePath: 0, updates: 0 };
  /** 每次分享调用记一行 `<方法> <参数>` */
  readonly log: string[] = [];
  /** 每页条数，测翻页用 */
  pageSize = 100;
  /** 服务端「相对上次转存有没有新增」的信号；默认 unknown = 认不出，追更照常列目录 */
  updateSignal: ShareUpdateSignal = "unknown";
  /** 列目录结果先过它一手：测试用来塞进树里表示不了的条目（比如名字带 /） */
  listHook: ((dirId: string, entries: ShareEntry[]) => ShareEntry[]) | null = null;
  /** 列根目录第一页时顺带给标题（真的两家都给）；关掉测「列表里没有标题、再调 info」那条路 */
  titleInList = true;
  readonly updates: ShareUpdates = {
    check: async (s: ShareSession) => {
      this.calls.updates++;
      this.def(s.ref);
      return this.updateSignal;
    },
  };

  constructor(
    private readonly kind: DriveKind,
    private readonly drive: FakeDrive,
  ) {}

  /** 建一个分享：`fake://<kind>/<code>` */
  define(code: string, def: Omit<FakeShareDef, "tree"> & { tree?: FakeTree }): FakeTree {
    const tree = def.tree ?? new FakeTree(`s-${code}-`);
    this.shares.set(code, { ...def, tree });
    return tree;
  }

  linkFor(code: string): string {
    const def = this.shares.get(code);
    return `https://fake.share/${this.kind}/${code}${def?.password ? `?pwd=${def.password}` : ""}`;
  }

  parseLink(text: string): ShareRef | null {
    const m = new RegExp(`^https://fake\\.share/${this.kind}/([a-z0-9]+)(?:\\?pwd=([a-z0-9]+))?$`, "i").exec(text.trim());
    if (!m) return null;
    return { kind: this.kind, code: m[1], password: m[2] ?? "", url: text.trim() };
  }

  private def(ref: ShareRef): FakeShareDef {
    // 网盘那边设了 failWith（cookie 失效 / 风控），分享接口一样打不通
    if (this.drive.failWith) throw this.drive.failWith;
    const def = this.shares.get(ref.code);
    if (!def || def.gone) throw new ShareGoneError(`share not exist: ${ref.code}`, 4100);
    if (def.password && def.password !== ref.password) throw new ShareGoneError("wrong password", 4101);
    return def;
  }

  async open(ref: ShareRef): Promise<ShareSession> {
    this.def(ref);
    return { ref, token: `stoken-${ref.code}` };
  }

  async info(s: ShareSession): Promise<ShareInfo> {
    this.calls.info++;
    const def = this.def(s.ref);
    return { title: def.title, fileCount: def.tree.children("/").length };
  }

  private toEntry(path: string, node: FakeNode): ShareEntry {
    return {
      id: node.id,
      name: baseOf(path),
      isDir: node.isDir,
      size: node.size,
      hash: this.drive.withHash ? node.hash : undefined,
      token: `tok-${node.id}`,
      modifiedAt: node.modifiedAt,
    };
  }

  async list(s: ShareSession, dirId: string, cursor?: string, _opts?: { limit?: number }): Promise<ShareListPage> {
    this.calls.list++;
    this.log.push(`list ${dirId || "0"}${cursor ? `@${cursor}` : ""}`);
    const def = this.def(s.ref);
    const dir = def.tree.pathOf(dirId || "0");
    if (dir === null) return { entries: [], total: 0 };
    let all = def.tree.children(dir).map(({ path, node }) => this.toEntry(path, node));
    if (this.listHook) all = this.listHook(dirId || "0", all);
    const page = Number(cursor ?? 0) || 0;
    const start = page * this.pageSize;
    const entries = all.slice(start, start + this.pageSize);
    const hasMore = start + entries.length < all.length;
    const title = this.titleInList && (dirId || "0") === "0" && !cursor ? { title: def.title } : {};
    return { entries, next: hasMore ? String(page + 1) : undefined, total: all.length, ...title };
  }

  async resolvePath(s: ShareSession, path: string): Promise<ShareEntry | null> {
    this.calls.resolvePath++;
    const def = this.def(s.ref);
    const p = normalizePath(path);
    if (p === "/") return null;
    const node = def.tree.get(p);
    return node ? this.toEntry(p, node) : null;
  }

  async receive(s: ShareSession, items: ReceiveItem[], toDirId: string): Promise<ReceiveResult> {
    this.calls.receive++;
    this.log.push(`receive ${items.map((i) => i.id).join(",")} -> ${toDirId}`);
    const def = this.def(s.ref);
    const target = this.drive.tree.pathOf(toDirId);
    if (target === null) throw new Error(`fake receive: unknown target dir ${toDirId}`);
    const topIds: string[] = [];
    for (const item of items) {
      const src = def.tree.pathOf(item.id);
      if (src === null) throw new Error(`fake receive: unknown share item ${item.id}`);
      const node = def.tree.get(src)!;
      const dest = `${target === "/" ? "" : target}/${baseOf(src)}`;
      const copied = node.isDir ? this.drive.tree.addDir(dest) : this.drive.tree.addFile(dest, { size: node.size, hash: node.hash });
      topIds.push(copied.id);
      if (node.isDir) {
        for (const { path, node: child } of def.tree.descendants(src)) {
          const rel = path.slice(src.length);
          if (child.isDir) this.drive.tree.addDir(`${dest}${rel}`);
          else this.drive.tree.addFile(`${dest}${rel}`, { size: child.size, hash: child.hash });
        }
      }
    }
    return { topIds };
  }
}

export class FakeChanges implements ChangeSource {
  readonly label = "fake";
  minIntervalSeconds = 1;
  readonly queue: ChangeEvent[] = [];
  prepareResult: { ok: boolean; message: string } = { ok: true, message: "ok" };
  pulls = 0;
  /** 下一次 pull 一起带出去的告警（模拟某个根列不了） */
  warnings: string[] = [];
  /** 监控在事件处理完之后调用了几次 commit，以及最近一次带来的失败事件 id */
  commits = 0;
  committedFailed: string[] = [];

  async prepare(): Promise<{ ok: boolean; message: string }> {
    return this.prepareResult;
  }

  initialCursor(mode: LifePullMode, saved: ChangeCursor | null): ChangeCursor {
    if (mode === "last" && saved) return saved;
    return { time: mode === "all" ? 0 : Math.floor(Date.now() / 1000), id: "0" };
  }

  async pull(cursor: ChangeCursor, _opts: { tasks: TaskDefinition[]; signal: AbortSignal }): Promise<PullResult> {
    this.pulls++;
    const events = this.queue.splice(0, this.queue.length);
    const last = events[events.length - 1];
    return {
      changes: events.map(resolvedChange),
      cursor: last ? { time: last.at, id: last.id } : cursor,
      warnings: this.warnings.length > 0 ? [...this.warnings] : undefined,
      commit: (failedIds) => {
        this.commits++;
        this.committedFailed = [...failedIds];
      },
    };
  }
}

export interface FakeDriveOptions {
  share?: boolean;
  changes?: boolean;
  /** 改名 / 移动 / 建目录；默认开 */
  write?: boolean;
  /** 分享 / 目录条目带不带内容哈希（115 有、夸克没有） */
  withHash?: boolean;
  /** 直链的前缀：`${linkBase}/dl<path>` */
  linkBase?: string;
  notes?: { verify?: string };
  /** 模拟夸克的目录指纹：目录的 modifiedAt 按真机规则刷新、列表带子项数、实现 dirFingerprints（快照源因此按指纹增量） */
  fingerprints?: boolean | FakeFingerprintOptions;
}

/** 默认时钟：从 2026-01-01 起每读一次加一秒 */
function steppingClock(): () => number {
  let t = Date.UTC(2026, 0, 1);
  return () => (t += 1000);
}

/**
 * 注意：读操作的签名要和 DriveProvider 一样带上 signal 并当场 throwIfAborted。
 * 少写一个参数 tsc 也不会响（结构化类型允许更窄的签名），但「取消传不下去」这类问题就永远测不出来——
 * 115 的 listSubtree 就这么把 signal 漏在了导出目录树那一步。
 */
export class FakeDrive implements DriveProvider {
  readonly tree: FakeTree;
  readonly rootId = "0";
  readonly capabilities: { share: boolean; changes: boolean; write: boolean };
  readonly share?: FakeShare;
  readonly changes?: FakeChanges;
  readonly write?: FakeWrite;
  readonly notes?: { verify?: string };
  readonly withHash: boolean;
  readonly linkBase: string;
  readonly calls = {
    resolvePath: 0,
    listDir: 0,
    listSubtree: 0,
    walkSubtree: 0,
    downloadLink: 0,
    mkdir: 0,
    rename: 0,
    move: 0,
    rmdir: 0,
    remove: 0,
    /** dirFingerprints 发的「请求」数：50 个路径算一个，和夸克 path_list 一样 */
    fingerprints: 0,
  };
  /** 每次网盘调用记一行 `<方法> <参数>`，测试断言调用顺序 / 次数用 */
  readonly log: string[] = [];
  /** 设了就让所有网盘调用抛这个错（模拟 cookie 失效 / 风控） */
  failWith: Error | null = null;
  /** 每次网盘调用前先等它（模拟慢接口 / 卡住） */
  beforeCall: (() => Promise<void>) | null = null;
  /** 写操作前先问它：返回错误就让这次写失败（模拟某个文件改不了名） */
  failWriteOn: ((op: "mkdir" | "rename" | "move" | "rmdir" | "remove", path: string) => Error | null) | null = null;
  /** dirFingerprints 对它返回 true 的路径不回（模拟 path_list 认不出某些名字） */
  fingerprintMiss: ((path: string) => boolean) | null = null;
  /** 开了 fingerprints 才有：按路径批量取目录指纹（精确匹配，不 trim，和 path_list 一样） */
  readonly dirFingerprints?: (paths: string[], opts?: ReadOptions) => Promise<Map<string, DirFingerprint>>;

  constructor(
    readonly kind: DriveKind,
    readonly account: AccountInfo,
    opts: FakeDriveOptions = {},
  ) {
    this.tree = new FakeTree(`${kind}-${account.name}-`);
    this.withHash = opts.withHash ?? kind === "115";
    this.linkBase = opts.linkBase ?? "http://127.0.0.1:1";
    const write = opts.write ?? true;
    this.capabilities = { share: !!opts.share, changes: !!opts.changes, write };
    if (opts.share) this.share = new FakeShare(kind, this);
    if (opts.changes) this.changes = new FakeChanges();
    if (write) this.write = new FakeWrite(this);
    this.notes = opts.notes;
    if (opts.fingerprints) {
      const fp = opts.fingerprints === true ? {} : opts.fingerprints;
      this.tree.fingerprints = { throttleMs: fp.throttleMs ?? 0, clock: fp.clock ?? steppingClock() };
      this.dirFingerprints = (paths, o) => this.fingerprintsOf(paths, o);
    }
  }

  private async fingerprintsOf(paths: string[], opts?: ReadOptions): Promise<Map<string, DirFingerprint>> {
    opts?.signal?.throwIfAborted();
    for (let i = 0; i < paths.length; i += 50) {
      this.calls.fingerprints++;
      await this.guard("fingerprints", `${Math.min(50, paths.length - i)}`);
    }
    const out = new Map<string, DirFingerprint>();
    for (const p of paths) {
      if (this.fingerprintMiss?.(p)) continue;
      const key = norm(p);
      const node = key === "/" ? undefined : this.tree.nodes.get(key);
      if (node?.isDir) out.set(p, { id: node.id, modifiedAt: node.modifiedAt ?? 0, items: this.tree.itemCount(key) });
    }
    return out;
  }

  /** 开了指纹时目录条目带子项数 */
  private itemsOf(path: string, node: FakeNode): { items?: number } {
    return node.isDir && this.tree.fingerprints ? { items: this.tree.itemCount(path) } : {};
  }

  async guard(method: string, arg: string): Promise<void> {
    this.log.push(`${method} ${arg}`);
    if (this.beforeCall) await this.beforeCall();
    if (this.failWith) throw this.failWith;
  }

  async resolvePath(path: string, signal?: AbortSignal): Promise<DriveNode | null> {
    this.calls.resolvePath++;
    signal?.throwIfAborted();
    await this.guard("resolvePath", path);
    const node = this.tree.get(path);
    return node ? { id: node.id, isDir: node.isDir } : null;
  }

  async listDir(id: string, signal?: AbortSignal, _opts?: { fresh?: boolean; background?: boolean }): Promise<DriveEntry[]> {
    this.calls.listDir++;
    signal?.throwIfAborted();
    await this.guard("listDir", id);
    const dir = this.tree.pathOf(id);
    if (dir === null) return [];
    return this.tree.children(dir).map(({ path, node }) => ({
      id: node.id,
      name: baseOf(path),
      isDir: node.isDir,
      size: node.size,
      hash: this.withHash ? node.hash : undefined,
      token: node.id,
      modifiedAt: node.modifiedAt,
      ...this.itemsOf(path, node),
    }));
  }

  private rootPath(path: string, id?: string): string {
    // 应用给的路径可能被 normalizePath 削过空格：按树里真正的那个路径来，子树条目才拼得回原名
    const root = id ? this.tree.pathOf(id) : this.tree.realPath(path);
    if (root === null) throw new RemoteDirNotFoundError(path);
    const node = this.tree.get(root);
    if (!node || !node.isDir) throw new RemoteDirNotFoundError(path);
    return root;
  }

  async listSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<string[]> {
    this.calls.listSubtree++;
    opts?.signal?.throwIfAborted();
    await this.guard("listSubtree", opts?.id ?? path);
    const root = this.rootPath(path, opts?.id);
    // 段里的空格照原样带出来（真网盘列目录给的就是原名），别用会 trim 的 splitPath
    return syncViewFromPaths(this.tree.descendants(root).map(({ path: p }) => p.slice(root === "/" ? 0 : root.length).split("/").filter(Boolean)));
  }

  async walkSubtree(path: string, opts?: { id?: string } & ReadOptions): Promise<SubtreeEntry[]> {
    this.calls.walkSubtree++;
    opts?.signal?.throwIfAborted();
    await this.guard("walkSubtree", opts?.id ?? path);
    const root = this.rootPath(path, opts?.id);
    return this.tree.descendants(root).map(({ path: p, node }) => ({
      path: p.slice(root === "/" ? 0 : root.length).split("/").filter(Boolean).join("/"),
      id: node.id,
      isDir: node.isDir,
      size: node.size,
      modifiedAt: node.modifiedAt,
      ...this.itemsOf(p, node),
    }));
  }

  async downloadLink(path: string): Promise<DriveLink> {
    this.calls.downloadLink++;
    await this.guard("downloadLink", path);
    const p = normalizePath(path);
    const node = this.tree.get(p);
    if (!node || node.isDir) throw new RemoteDirNotFoundError(p);
    return { url: `${this.linkBase}/dl${p}` };
  }

  classifyError(err: unknown): AccountIssue | null {
    if (err instanceof ShareGoneError) return "gone";
    const msg = err instanceof Error ? err.message : String(err);
    if (/cookie|login|登录/i.test(msg)) return "auth";
    if (/blocked|405|阻断|封控/i.test(msg)) return "blocked";
    return null;
  }
}

/** 假网盘的写操作：直接改 FakeTree，id 不变；每一步记进 drive.log */
export class FakeWrite implements DriveWriteOps {
  constructor(private readonly drive: FakeDrive) {}

  private async check(op: "mkdir" | "rename" | "move" | "rmdir" | "remove", path: string): Promise<void> {
    await this.drive.guard(op, path);
    const err = this.drive.failWriteOn?.(op, path);
    if (err) throw err;
  }

  async mkdir(parent: { id: string; path: string }, name: string): Promise<DriveNode> {
    const p = `${normalizePath(parent.path) === "/" ? "" : normalizePath(parent.path)}/${name}`;
    this.drive.calls.mkdir++;
    await this.check("mkdir", p);
    const parentNode = this.drive.tree.get(parent.path);
    if (!parentNode || !parentNode.isDir) throw new Error(`fake mkdir: parent missing ${parent.path}`);
    const node = this.drive.tree.addDir(p);
    return { id: node.id, isDir: true };
  }

  async rename(node: WriteNode, newName: string): Promise<{ id: string }> {
    const from = normalizePath(node.path);
    const to = `${parentOf(from) === "/" ? "" : parentOf(from)}/${newName}`;
    this.drive.calls.rename++;
    await this.check("rename", from);
    this.drive.log.push(`rename ${from} -> ${newName}`);
    if (!this.drive.tree.get(from)) throw new Error(`fake rename: no such path ${from}`);
    if (this.drive.tree.get(to)) throw new Error(`fake rename: target exists ${to}`);
    this.drive.tree.move(from, to);
    return { id: node.id };
  }

  /** 一批要么全挪要么全不挪（像真网盘的批量接口那样），先把每一项都检查完再动树 */
  async move(nodes: WriteNode[], to: { id: string; path: string }): Promise<Array<{ id: string }>> {
    const dst = normalizePath(to.path);
    this.drive.calls.move++;
    const dstNode = this.drive.tree.get(dst);
    if (!dstNode || !dstNode.isDir) throw new Error(`fake move: target dir missing ${dst}`);
    const planned: Array<{ from: string; target: string }> = [];
    for (const node of nodes) {
      const from = normalizePath(node.path);
      const target = `${dst === "/" ? "" : dst}/${baseOf(from)}`;
      await this.check("move", from);
      if (!this.drive.tree.get(from)) throw new Error(`fake move: no such path ${from}`);
      if (this.drive.tree.get(target)) throw new Error(`fake move: target exists ${target}`);
      planned.push({ from, target });
    }
    for (const { from, target } of planned) {
      this.drive.log.push(`move ${from} -> ${dst}`);
      this.drive.tree.move(from, target);
    }
    return nodes.map((n) => ({ id: n.id }));
  }

  async rmdirIfEmpty(node: WriteNode): Promise<boolean> {
    const p = normalizePath(node.path);
    this.drive.calls.rmdir++;
    await this.check("rmdir", p);
    if (this.drive.tree.children(p).length > 0) return false;
    this.drive.log.push(`rmdir ${p}`);
    this.drive.tree.remove(p);
    return true;
  }

  async remove(node: WriteNode): Promise<void> {
    const p = normalizePath(node.path);
    this.drive.calls.remove++;
    await this.check("remove", p);
    if (!this.drive.tree.get(p)) throw new Error(`fake remove: no such path ${p}`);
    this.drive.log.push(`remove ${p}`);
    this.drive.tree.remove(p);
  }
}

/** 115 式的网盘：没有 walkSubtree，整棵列只有路径、没有 id。给要验「只有路径也能办」的测试用 */
export function withoutWalk(inner: FakeDrive): DriveProvider {
  return {
    kind: inner.kind,
    account: inner.account,
    capabilities: inner.capabilities,
    rootId: inner.rootId,
    write: inner.write,
    resolvePath: (p, s) => inner.resolvePath(p, s),
    listDir: (id, s) => inner.listDir(id, s),
    listSubtree: (p, o) => inner.listSubtree(p, o),
    downloadLink: (p) => inner.downloadLink(p),
    classifyError: (e) => inner.classifyError(e),
  };
}
