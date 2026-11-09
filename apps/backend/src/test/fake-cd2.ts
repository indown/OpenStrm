/**
 * 假的 CloudDrive2 gRPC 服务（node:http2 明文）：认 GetSystemInfo / GetToken / GetSubFiles，记下每次调用，能按配置造错。
 * 报文用 lib/protobuf.ts 拼，线上格式和 lib/grpc.ts 一致（5 字节帧头 + trailer 里的 grpc-status；拒绝时 trailers-only）。
 */
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { concatBytes, decodeMessage, encodeBool, encodeBytes, encodeString, encodeUint, readBool, readString, readStrings } from "../lib/protobuf.js";

export interface FakeCd2Call {
  method: string;
  authorization?: string;
  path?: string;
  forceRefresh?: boolean;
}

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
  /** 令牌没有「查看传输任务」权限：GetCopyTasks 回 PERMISSION_DENIED（真机撞到） */
  denyCopyTasks = false;
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
    if (method === "GetSubFiles") {
      const path = readString(req, 1) ?? "";
      call.path = path;
      call.forceRefresh = readBool(req, 2) ?? false;
      const entries = this.tree[path];
      if (!entries) {
        this.reply(stream, [], 5, `object not found: ${path}`);
        return;
      }
      const frames: Uint8Array[] = [];
      for (let i = 0; i < entries.length; i += this.chunk) {
        const files = entries.slice(i, i + this.chunk).map((e) => {
          const isDir = e.endsWith("/");
          const name = isDir ? e.slice(0, -1) : e;
          // 真 CD2 两个都发：fileType=5（文件是 1，目录是 0 不发）和 isDirectory=30（目录 true，文件 false 不发）；老版本只有 fileType
          const kind = this.legacyFileType ? encodeUint(5, isDir ? 0 : 1) : concatBytes(encodeUint(5, isDir ? 0 : 1), encodeBool(30, isDir));
          return encodeBytes(1, concatBytes(encodeString(2, name), encodeString(3, `${path === "/" ? "" : path}/${name}`), isDir ? new Uint8Array(0) : encodeUint(4, this.fileSize), kind));
        });
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
      const entries = this.tree[parent];
      const result = (ok: boolean, msg = "") => encodeBytes(2, concatBytes(encodeBool(1, ok), encodeString(2, msg)));
      if (!entries) {
        // CD2 对不存在的父目录回的是 success=false 的结果，不是 gRPC 错误
        this.reply(stream, [result(false, `parent folder does not exist: ${parent}`)]);
        return;
      }
      if (entries.includes(`${name}/`) || entries.includes(name)) {
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
    this.reply(stream, [], 12, `Unimplemented: ${method}`);
  }
}
