/**
 * 假的 115 扫码登录服务：给 cloud-115/qrcode.itest.ts、routes/account/qrcode.itest.ts 和浏览器冒烟的预加载用。
 * 路径和真 115 一样（token / qrcode 图 / get/status / login/qrcode）。查状态默认每问 advanceEvery 次往前推一档
 * （0 等扫 → 1 已扫 → 2 已确认），不用手机也能把整条路走完；用例要别的结局就往 statusQueue 里塞。
 *
 * 回的 cookie 按选的端给 UID 中段（alipaymini → R2 …），用例能验「拿到的就是那个端的」。
 * 夹具里的 UID 故意短：scripts/check-hygiene.sh 把 `UID=<3 位以上>_X1_<6 位以上>` 当真凭据。
 */
import http from "node:http";
import { deflateSync } from "node:zlib";

const SSOENT: Record<string, string> = { web: "A1", ios: "D1", android: "F1", tv: "I1", wechatmini: "R1", alipaymini: "R2" };

export interface Fake115QrcodeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
  /** 路径里的 {app}；get/status 没有 */
  app: string | null;
}

export interface Fake115Qrcode {
  base: string;
  /** 下几次查状态回什么：数字当 data.status；对象原样当整个响应体 */
  statusQueue: Array<number | Record<string, unknown>>;
  /** 换 cookie 接口回什么；null 用默认的完整 cookie */
  loginResponse: Record<string, unknown> | null;
  /** 二维码接口回什么；null 用默认 */
  tokenResponse: Record<string, unknown> | null;
  /** 这个路径回 HTTP 500 */
  failPath: string | null;
  /** 查状态先挂这么久再回（模拟 115 的长轮询） */
  hangStatusMs: number;
  calls: Fake115QrcodeCall[];
  statusHits: number;
  reset(): void;
  close(): Promise<void>;
}

/** 24×24 的棋盘格 PNG：冒烟时 img 里要能看见个东西；用例只看是不是 data:image/png */
export function checkerPng(): Buffer {
  const size = 24;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size + 1);
    for (let x = 0; x < size; x++) row[x + 1] = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 0xff : 0x00;
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 0; // 灰度
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export async function startFake115Qrcode(opts: { advanceEvery?: number } = {}): Promise<Fake115Qrcode> {
  const advanceEvery = opts.advanceEvery ?? 3;
  let seq = 0;
  const fake: Fake115Qrcode = {
    base: "",
    statusQueue: [],
    loginResponse: null,
    tokenResponse: null,
    failPath: null,
    hangStatusMs: 0,
    calls: [],
    statusHits: 0,
    reset() {
      seq = 0;
      fake.statusQueue = [];
      fake.loginResponse = null;
      fake.tokenResponse = null;
      fake.failPath = null;
      fake.hangStatusMs = 0;
      fake.calls = [];
      fake.statusHits = 0;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown, delayMs = 0) => {
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json;charset=UTF-8" });
        res.end(JSON.stringify(body));
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const appMatch = /^\/(?:api|app)\/1\.0\/([^/]+)\/1\.0\//.exec(url.pathname);
      fake.calls.push({
        method: req.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw,
        app: appMatch ? appMatch[1] : null,
      });
      if (fake.failPath && url.pathname === fake.failPath) {
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("boom");
      }
      if (/^\/api\/1\.0\/[^/]+\/1\.0\/token\/?$/.test(url.pathname)) {
        seq += 1;
        return json(
          fake.tokenResponse ?? {
            state: 1,
            code: 0,
            message: "",
            data: { uid: `fake-uid-${seq}`, time: 1_700_000_000 + seq, sign: `sign-${seq}`, qrcode: `https://115.com/scan/dg-fake-${seq}` },
          },
        );
      }
      if (/^\/api\/1\.0\/[^/]+\/1\.0\/qrcode$/.test(url.pathname)) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(checkerPng());
      }
      if (url.pathname === "/get/status/") {
        fake.statusHits += 1;
        const queued = fake.statusQueue.shift();
        if (queued !== undefined && typeof queued === "object") return json(queued, fake.hangStatusMs);
        const status =
          typeof queued === "number"
            ? queued
            : advanceEvery > 0
              ? Math.min(2, Math.floor((fake.statusHits - 1) / advanceEvery))
              : 0;
        return json({ state: 1, code: 0, message: "", data: { msg: "", status, version: "0.0.1" } }, fake.hangStatusMs);
      }
      if (/^\/app\/1\.0\/[^/]+\/1\.0\/login\/qrcode\/?$/.test(url.pathname)) {
        const app = appMatch ? appMatch[1] : "web";
        return json(
          fake.loginResponse ?? {
            state: 1,
            code: 0,
            message: "",
            data: {
              cookie: { UID: `12_${SSOENT[app] ?? "Z9"}_123`, CID: `cid-${app}`, SEID: `seid-${app}`, KID: `kid-${app}` },
              user_id: 12,
              user_name: "fake user",
            },
          },
        );
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  fake.base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return fake;
}
