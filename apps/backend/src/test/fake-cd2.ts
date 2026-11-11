/**
 * 假的 CloudDrive2 gRPC 服务（node:http2 明文）：认 GetSystemInfo / GetToken / GetSubFiles，记下每次调用，能按配置造错。
 * 复制引擎的 CreateFolder / CopyFile / GetCopyTasks，和 CD2 账号当网盘用的 FindFileByPath / RenameFile / MoveFile / DeleteFile /
 * GetDownloadUrlPath / GetApiTokenInfo 也在这里；目录树是活的，改名 / 移动 / 删除会真的改它。
 * 找不到 / 撞名时的状态码和说法、下载地址的形状、目录不给下载、令牌权限表默认不给读、MoveFile 带 Skip 时不报错也不回结果路径，
 * 都照 2026-11-10 对 lab 里真 CD2 的探测写的。
 * 报文用 lib/protobuf.ts 拼，线上格式和 lib/grpc.ts 一致（5 字节帧头 + trailer 里的 grpc-status；拒绝时 trailers-only）。
 */
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { concatBytes, decodeMessage, encodeBool, encodeBytes, encodeString, encodeUint, readBool, readString, readStrings, readUint } from "../lib/protobuf.js";

export interface FakeCd2Call {
  method: string;
  authorization?: string;
  path?: string;
  forceRefresh?: boolean;
}

/** TokenPermissions 里我们用得上的字段号：列出文件 1、创建文件夹 4、读取文件 7、重命名 8、移动 9、复制 10、删除 11、获取传输任务 27 */
export const FAKE_CD2_ALL_PERMISSIONS = [1, 4, 7, 8, 9, 10, 11, 27];

export interface FakeCd2CopyTask {
  sourcePath: string;
  destPath: string;
  /** CopyTask.TaskStatus：0 Pending 1 Scanning 2 Scanned 3 Completed 4 Failed */
  status: number;
  totalFiles: number;
  uploadedFiles: number;
  failedFiles: number;
  errors: string[];
  /** 秒 */
  endedAt: number | null;
}

export class FakeCd2 {
  readonly calls: FakeCd2Call[] = [];
  /** 目录 → 子项名，以 / 结尾的算目录 */
  tree: Record<string, string[]> = { "/": ["115/"], "/115": ["movie/", "tv/"] };
  users: Record<string, string> = { admin: "pw" };
  /** 有效的令牌（API 令牌 + 发出去的 JWT）；从这里删掉就等于失效 */
  tokens = new Set<string>(["api-token"]);
  /** JWT 过期时间（秒，绝对）；0 = 不带 expiration */
  jwtExpiresAt = Math.floor(Date.now() / 1000) + 7200;
  loggedIn = true;
  userName = "u***@example.com";
  /** 流里一帧塞几个条目 */
  chunk = 2;
  /** 文件条目报的大小 */
  fileSize = 1234;
  /** CopyFile 收到的请求 */
  copyRequests: Array<{ sources: string[]; dest: string }> = [];
  /** CD2 里的复制任务（GetCopyTasks 回的就是它）；advanceCopies() 把没结束的推到完成并把条目搬进目标目录 */
  copyTasks: FakeCd2CopyTask[] = [];
  /** 下一次 CopyFile 直接回 success=false 的原因 */
  failNextCopy: string | null = null;
  /** 推进时让这些源路径失败（带这条错误） */
  failSources = new Map<string, string>();
  /** 推进完成后把任务从列表里拿掉（模拟 CD2 清掉已完成的任务） */
  dropCompleted = false;
  /** GetSystemInfo 只回首部就把流关掉（RST_STREAM NO_ERROR），没有正文也没有 trailer */
  closeWithoutEnd = false;
  /** 老版本 CD2：条目没有 isDirectory=30，只有 fileType=5（目录是 0，proto3 不发） */
  legacyFileType = false;
  /** 令牌没有「获取传输任务」权限：GetCopyTasks 回 PERMISSION_DENIED（真机撞到） */
  denyCopyTasks = false;
  /** 令牌缺某项权限：这些方法一律回 PERMISSION_DENIED */
  deny = new Set<string>();
  /**
   * CreateFolder 按真机的表现来（本地文件夹存储和 115 都探测过）：目录已经在也回成功，父目录不在就连父目录一起建。
   * 默认 false 是更严的那种：已存在、父目录不在都回失败——代码两种都得接得住
   */
  lenientCreateFolder = false;
  /** 条目的最后修改时间（秒），键是完整路径；没有的不发 writeTime */
  mtimes: Record<string, number> = {};
  /** MoveFile 收到的请求（policy 是 conflictPolicy，没带是 undefined） */
  moveRequests: Array<{ sources: string[]; dest: string; policy: number | undefined }> = [];
  /** GetApiTokenInfo 回的内容；permissions 是 TokenPermissions 里为 true 的字段号 */
  tokenInfo = { rootDir: "", friendlyName: "openstrm", expiresIn: 0, permissions: [...FAKE_CD2_ALL_PERMISSIONS] };
  /**
   * 令牌有没有「令牌管理」权限。真 CD2 只有带这项权限的令牌才给读权限表，普通令牌问 GetApiTokenInfo 回 PERMISSION_DENIED
   *（`token management permission required`），所以默认 false
   */
  tokenManagement = false;
  /** GetDownloadUrlPath 回的有效期（秒）；0 = 不带 */
  downloadExpiresIn = 0;
  url = "";
  private issued = 0;
  private readonly server = http2.createServer();

  async start(): Promise<string> {
    this.server.on("stream", (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        try {
          this.handle(stream, headers, Buffer.concat(chunks));
        } catch (err) {
          this.reply(stream, [], 13, err instanceof Error ? err.message : String(err));
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  /** 用例之间清干净：调用记录、令牌（只剩 API 令牌）、JWT 计数、复制任务 */
  reset(): void {
    this.calls.length = 0;
    this.tokens = new Set(["api-token"]);
    this.issued = 0;
    this.copyRequests.length = 0;
    this.copyTasks = [];
    this.failNextCopy = null;
    this.failSources.clear();
    this.dropCompleted = false;
    this.closeWithoutEnd = false;
    this.legacyFileType = false;
    this.denyCopyTasks = false;
    this.deny.clear();
    this.lenientCreateFolder = false;
    this.mtimes = {};
    this.moveRequests.length = 0;
    this.tokenInfo = { rootDir: "", friendlyName: "openstrm", expiresIn: 0, permissions: [...FAKE_CD2_ALL_PERMISSIONS] };
    this.tokenManagement = false;
    this.downloadExpiresIn = 0;
  }

  /** 真 CD2 找不到路径时的说法（gRPC NOT_FOUND）：`find by path: "/a/b" not found under "/a"` */
  private notFound(path: string): string {
    return `find by path: "${path}" not found under "${this.parentOf(path)}"`;
  }

  private join(dir: string, name: string): string {
    return `${dir === "/" ? "" : dir}/${name}`;
  }

  private parentOf(path: string): string {
    return path.slice(0, path.lastIndexOf("/")) || "/";
  }

  private nameOf(path: string): string {
    return path.split("/").pop() ?? "";
  }

  /** 这个路径在父目录里登记的那一项（目录带尾斜杠）；没有回 null */
  private entryOf(path: string): { parent: string; entry: string; isDir: boolean } | null {
    const parent = this.parentOf(path);
    const name = this.nameOf(path);
    const list = this.tree[parent];
    if (!list || !name) return null;
    if (list.includes(`${name}/`)) return { parent, entry: `${name}/`, isDir: true };
    if (list.includes(name)) return { parent, entry: name, isDir: false };
    return null;
  }

  /** 把 from 这条路径（目录连子树）下挂的键搬到 to 下面；to 为 null 就是删掉 */
  private rekey(map: Record<string, unknown>, from: string, to: string | null): void {
    for (const key of Object.keys(map)) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      if (to !== null) map[`${to}${key.slice(from.length)}`] = map[key];
      delete map[key];
    }
  }

  /** 从目录树里拿掉一个条目（目录连子树） */
  private drop(path: string): void {
    const hit = this.entryOf(path);
    if (!hit) return;
    this.tree[hit.parent] = this.tree[hit.parent].filter((e) => e !== hit.entry);
    this.rekey(this.tree, path, null);
    this.rekey(this.mtimes, path, null);
  }

  /** 把一个条目（目录连子树）从 from 挪到 to（都是完整路径；to 的父目录得在） */
  private relocate(from: string, to: string): void {
    const hit = this.entryOf(from);
    if (!hit) return;
    this.tree[hit.parent] = this.tree[hit.parent].filter((e) => e !== hit.entry);
    (this.tree[this.parentOf(to)] ??= []).push(hit.isDir ? `${this.nameOf(to)}/` : this.nameOf(to));
    this.rekey(this.tree, from, to);
    this.rekey(this.mtimes, from, to);
  }

  /** 一个条目的 CloudDriveFile 报文：name=2、fullPathName=3、size=4、fileType=5、writeTime=7、isDirectory=30 */
  private fileMessage(dir: string, entry: string): Uint8Array {
    const isDir = entry.endsWith("/");
    const name = isDir ? entry.slice(0, -1) : entry;
    const full = this.join(dir, name);
    // 真 CD2 两个都发：fileType=5（文件是 1，目录是 0 不发）和 isDirectory=30（目录 true，文件 false 不发）；老版本只有 fileType
    const kind = this.legacyFileType ? encodeUint(5, isDir ? 0 : 1) : concatBytes(encodeUint(5, isDir ? 0 : 1), encodeBool(30, isDir));
    const mtime = this.mtimes[full];
    return concatBytes(
      encodeString(2, name),
      encodeString(3, full),
      isDir ? new Uint8Array(0) : encodeUint(4, this.fileSize),
      kind,
      mtime ? encodeBytes(7, encodeUint(1, mtime)) : new Uint8Array(0),
    );
  }

  /** 把没结束的复制任务推到结束：失败名单里的记 Failed，其余 Completed 并把条目搬进目标目录 */
  advanceCopies(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const t of this.copyTasks) {
      if (t.status >= 3) continue;
      const fail = this.failSources.get(t.sourcePath);
      if (fail) {
        t.status = 4;
        t.failedFiles = t.totalFiles;
        t.errors = [fail];
      } else {
        t.status = 3;
        t.uploadedFiles = t.totalFiles;
        const name = t.sourcePath.split("/").pop() ?? "";
        const isDir = this.tree[t.sourcePath] !== undefined;
        const entry = isDir ? `${name}/` : name;
        const dest = (this.tree[t.destPath] ??= []);
        if (!dest.includes(entry)) dest.push(entry);
        if (isDir) this.tree[`${t.destPath}/${name}`] = [...(this.tree[t.sourcePath] ?? [])];
      }
      t.endedAt = now;
    }
    if (this.dropCompleted) this.copyTasks = this.copyTasks.filter((t) => t.status < 3);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private reply(stream: http2.ServerHttp2Stream, frames: Uint8Array[], status = 0, message = ""): void {
    if (stream.destroyed) return;
    if (status !== 0) {
      stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": String(status), "grpc-message": encodeURIComponent(message) }, { endStream: true });
      return;
    }
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    for (const f of frames) {
      const out = Buffer.alloc(5 + f.length);
      out.writeUInt32BE(f.length, 1);
      out.set(f, 5);
      stream.write(out);
    }
    stream.end();
  }

  private handle(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, body: Buffer): void {
    const method = String(headers[":path"] ?? "").split("/").pop() ?? "";
    const auth = typeof headers.authorization === "string" ? headers.authorization : undefined;
    const req = body.length >= 5 ? decodeMessage(body.subarray(5, 5 + body.readUInt32BE(1))) : new Map();
    const call: FakeCd2Call = { method, authorization: auth };
    this.calls.push(call);
    if (method === "GetSystemInfo") {
      if (this.closeWithoutEnd) {
        stream.respond({ ":status": 200, "content-type": "application/grpc" });
        stream.close(http2.constants.NGHTTP2_NO_ERROR);
        return;
      }
      this.reply(stream, [concatBytes(encodeBool(1, this.loggedIn), encodeString(2, this.userName), encodeBool(3, true))]);
      return;
    }
    if (method === "GetToken") {
      const user = readString(req, 1) ?? "";
      if (this.users[user] !== undefined && this.users[user] === (readString(req, 2) ?? "")) {
        const token = `jwt-${++this.issued}`;
        this.tokens.add(token);
        const exp = this.jwtExpiresAt > 0 ? encodeBytes(4, encodeUint(1, this.jwtExpiresAt)) : new Uint8Array(0);
        this.reply(stream, [concatBytes(encodeBool(1, true), encodeString(3, token), exp)]);
      } else {
        this.reply(stream, [concatBytes(encodeBool(1, false), encodeString(2, "用户名或密码不对"))]);
      }
      return;
    }
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !this.tokens.has(token)) {
      this.reply(stream, [], 16, "Unauthenticated");
      return;
    }
    if (this.deny.has(method)) {
      this.reply(stream, [], 7, `${method} permission required`);
      return;
    }
    /** FileOperationResult{success=1, errorMessage=2, resultFilePaths=3} */
    const operation = (ok: boolean, msg = "", results: string[] = []) => concatBytes(encodeBool(1, ok), encodeString(2, msg), ...results.map((r) => encodeString(3, r)));
    if (method === "GetSubFiles") {
      const path = readString(req, 1) ?? "";
      call.path = path;
      call.forceRefresh = readBool(req, 2) ?? false;
      const entries = this.tree[path];
      if (!entries) {
        this.reply(stream, [], 5, this.notFound(path));
        return;
      }
      const frames: Uint8Array[] = [];
      for (let i = 0; i < entries.length; i += this.chunk) {
        const files = entries.slice(i, i + this.chunk).map((e) => encodeBytes(1, this.fileMessage(path, e)));
        frames.push(concatBytes(...files));
      }
      if (frames.length === 0) frames.push(new Uint8Array(0));
      this.reply(stream, frames);
      return;
    }
    if (method === "CreateFolder") {
      const parent = readString(req, 1) ?? "";
      const name = readString(req, 2) ?? "";
      call.path = `${parent}/${name}`;
      const result = (ok: boolean, msg = "") => encodeBytes(2, concatBytes(encodeBool(1, ok), encodeString(2, msg)));
      if (this.lenientCreateFolder && !this.tree[parent]) {
        // 本地文件夹存储：父目录不在就一路建下来
        const segs = parent.split("/").filter(Boolean);
        for (let i = 1; i <= segs.length; i++) {
          const dir = `/${segs.slice(0, i).join("/")}`;
          const up = this.parentOf(dir);
          if (this.tree[dir] || !this.tree[up]) continue;
          this.tree[up].push(`${segs[i - 1]}/`);
          this.tree[dir] = [];
        }
      }
      const entries = this.tree[parent];
      if (!entries) {
        // CD2 对不存在的父目录回的是 success=false 的结果，不是 gRPC 错误
        this.reply(stream, [result(false, `parent folder does not exist: ${parent}`)]);
        return;
      }
      if (entries.includes(`${name}/`) || entries.includes(name)) {
        if (this.lenientCreateFolder && entries.includes(`${name}/`)) {
          this.reply(stream, [concatBytes(encodeBytes(1, concatBytes(encodeString(2, name), encodeBool(30, true))), result(true))]);
          return;
        }
        this.reply(stream, [result(false, "folder already exists")]);
        return;
      }
      entries.push(`${name}/`);
      this.tree[`${parent === "/" ? "" : parent}/${name}`] = [];
      this.reply(stream, [concatBytes(encodeBytes(1, concatBytes(encodeString(2, name), encodeBool(30, true))), result(true))]);
      return;
    }
    if (method === "CopyFile") {
      const sources = readStrings(req, 1);
      const dest = readString(req, 2) ?? "";
      this.copyRequests.push({ sources, dest });
      const fail = (msg: string) => this.reply(stream, [concatBytes(encodeBool(1, false), encodeString(2, msg))]);
      if (this.failNextCopy) {
        const msg = this.failNextCopy;
        this.failNextCopy = null;
        fail(msg);
        return;
      }
      if (!this.tree[dest]) {
        fail(`destination not found: ${dest}`);
        return;
      }
      for (const src of sources) {
        const parent = src.slice(0, src.lastIndexOf("/")) || "/";
        const name = src.split("/").pop() ?? "";
        const entries = this.tree[parent] ?? [];
        if (!entries.includes(name) && !entries.includes(`${name}/`)) {
          fail(`source not found: ${src}`);
          return;
        }
        this.copyTasks.push({ sourcePath: src, destPath: dest, status: 0, totalFiles: 1, uploadedFiles: 0, failedFiles: 0, errors: [], endedAt: null });
      }
      this.reply(stream, [concatBytes(encodeBool(1, true), ...sources.map((s) => encodeString(3, `${dest}/${s.split("/").pop()}`)))]);
      return;
    }
    if (method === "GetCopyTasks") {
      if (this.denyCopyTasks) {
        this.reply(stream, [], 7, "get transfer tasks permission required");
        return;
      }
      const tasks = this.copyTasks.map((t) =>
        encodeBytes(
          1,
          concatBytes(
            encodeString(3, t.sourcePath),
            encodeString(4, t.destPath),
            encodeUint(5, t.status),
            encodeUint(7, t.totalFiles),
            encodeUint(9, t.failedFiles),
            encodeUint(10, t.uploadedFiles),
            ...t.errors.map((e) => encodeBytes(15, encodeString(2, e))),
            t.endedAt ? encodeBytes(18, encodeUint(1, t.endedAt)) : new Uint8Array(0),
          ),
        ),
      );
      this.reply(stream, [concatBytes(...tasks)]);
      return;
    }
    if (method === "FindFileByPath") {
      const parent = readString(req, 1) ?? "/";
      const name = readString(req, 2) ?? "";
      const full = name.startsWith("/") ? name : this.join(parent, name);
      call.path = full;
      const hit = this.entryOf(full);
      if (!hit) {
        this.reply(stream, [], 5, this.notFound(full));
        return;
      }
      this.reply(stream, [this.fileMessage(hit.parent, hit.entry)]);
      return;
    }
    if (method === "RenameFile") {
      const path = readString(req, 1) ?? "";
      const newName = readString(req, 2) ?? "";
      call.path = path;
      const hit = this.entryOf(path);
      if (!hit) {
        this.reply(stream, [], 5, this.notFound(path));
        return;
      }
      const target = this.join(hit.parent, newName);
      if (this.entryOf(target)) {
        // 真 CD2：撞名是 gRPC ALREADY_EXISTS，不是 success=false
        this.reply(stream, [], 6, `rename error: "${newName}" already exists in "${hit.parent}"`);
        return;
      }
      this.relocate(path, target);
      this.reply(stream, [operation(true)]);
      return;
    }
    if (method === "MoveFile") {
      const sources = readStrings(req, 1);
      const dest = readString(req, 2) ?? "";
      const raw = readUint(req, 3);
      const policy = raw === undefined ? undefined : Number(raw);
      this.moveRequests.push({ sources, dest, policy });
      if (!this.tree[dest]) {
        // 真 CD2：目标目录不在是 gRPC NOT_FOUND，说法和别处一样
        this.reply(stream, [], 5, this.notFound(dest));
        return;
      }
      const missing = sources.find((src) => !this.entryOf(src));
      if (missing) {
        this.reply(stream, [], 5, this.notFound(missing));
        return;
      }
      for (const src of sources) {
        const target = this.join(dest, this.nameOf(src));
        if (this.entryOf(target)) {
          // Skip（2）：目标里已有同名的原地不动，别的照挪，整个调用照样回成功；Rename（1）加后缀；其余覆盖
          if (policy === 2) continue;
          if (policy === 1) {
            this.relocate(src, `${target} (1)`);
            continue;
          }
          this.drop(target);
        }
        this.relocate(src, target);
      }
      // 真 CD2 回的 resultFilePaths 是空的（挪成了的也不在里面）：哪些挪成了只能看目录
      this.reply(stream, [operation(true)]);
      return;
    }
    if (method === "DeleteFile") {
      const path = readString(req, 1) ?? "";
      call.path = path;
      if (!this.entryOf(path)) {
        this.reply(stream, [], 5, this.notFound(path));
        return;
      }
      this.drop(path);
      this.reply(stream, [operation(true)]);
      return;
    }
    if (method === "GetDownloadUrlPath") {
      const path = readString(req, 1) ?? "";
      call.path = path;
      const hit = this.entryOf(path);
      if (!hit) {
        this.reply(stream, [], 5, this.notFound(path));
        return;
      }
      if (hit.isDir) {
        this.reply(stream, [], 3, "Cannot download directory");
        return;
      }
      // DownloadUrlPathInfo{downloadUrlPath=1, expiresIn=2}：占位符留给客户端换；路径整个编码（斜杠也编成 %2F）、不带头斜杠，后面跟着访问用的查询参数
      const urlPath = `/static/{SCHEME}/{HOST}/{PREVIEW}/${encodeURIComponent(path.slice(1))}?token=dl-1&cloudname=fake&membership=1`;
      this.reply(stream, [concatBytes(encodeString(1, urlPath), encodeUint(2, this.downloadExpiresIn))]);
      return;
    }
    if (method === "GetApiTokenInfo") {
      if (!this.tokenManagement) {
        this.reply(stream, [], 7, "token management permission required");
        return;
      }
      const asked = readString(req, 1) ?? "";
      if (!asked.startsWith("api-") || !this.tokens.has(asked)) {
        this.reply(stream, [], 5, "token not found");
        return;
      }
      // TokenInfo{token=1, rootDir=2, permissions=3, expires_in=4, friendly_name=5}
      const permissions = concatBytes(...this.tokenInfo.permissions.map((field) => encodeBool(field, true)));
      this.reply(stream, [
        concatBytes(encodeString(1, asked), encodeString(2, this.tokenInfo.rootDir), encodeBytes(3, permissions), encodeUint(4, this.tokenInfo.expiresIn), encodeString(5, this.tokenInfo.friendlyName)),
      ]);
      return;
    }
    this.reply(stream, [], 12, `Unimplemented: ${method}`);
  }
}
