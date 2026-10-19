/**
 * mediainfo.js（MediaInfoLib 的 WASM 版）：只读文件头就能拿到编码 / 分辨率 / HDR / 音轨。
 * 进程里一个实例、串行用（WASM 模块不是线程安全的，探测本身也就一两秒）；readChunk 由调用方提供，
 * 远程文件用网盘直链 + Range 请求实现，每个文件有读取预算（见 ProbeLimits），超了算失败而不是半途给结果。
 */
import axios from "axios";
import mediaInfoFactory, { type MediaInfo, type MediaInfoResult } from "mediainfo.js";

/**
 * 读取预算。MediaInfoLib 不只读轨道表，还要在第一个簇里找到每条轨的首帧（HDR 元数据、Atmos 这些只在帧里），
 * 最后再跳到文件尾看时长：真机上一个 68 GiB、77 Mbps 的 4K 原盘 remux（4 条音轨）从头顺序读了 33 MB 才凑齐，
 * 再加文件尾一块；码率低的文件读得少得多。WASM 版没有 ParseSpeed 可调，所以预算要放到这个量级，
 * 超了算失败「读取量超过上限」，不半途给结果
 */
export interface ProbeLimits {
  /** 一个文件最多读这么多字节 */
  MAX_BYTES: number;
  /** 一个文件最多发这么多次 Range 请求 */
  MAX_READS: number;
  /** 一个文件从头到尾最多花这么久 */
  TIMEOUT_MS: number;
  /** 每次向网盘要多大一块（mediainfo.js 每次 readChunk 要的就是这么多，到文件尾少给）；块大一点请求就少（每次都有几百毫秒的来回） */
  CHUNK_BYTES: number;
}

const DEFAULT_LIMITS: ProbeLimits = { MAX_BYTES: 64 * 1024 * 1024, MAX_READS: 48, TIMEOUT_MS: 120_000, CHUNK_BYTES: 2 * 1024 * 1024 };
export const PROBE_LIMITS: ProbeLimits = { ...DEFAULT_LIMITS };

/** 仅供测试：改预算，传 null 恢复；改了 CHUNK_BYTES 要再 __test_resetMediaInfo 让实例按新块大小重建 */
export function __test_setProbeLimits(partial: Partial<ProbeLimits> | null): void {
  Object.assign(PROBE_LIMITS, partial ?? DEFAULT_LIMITS);
}

export interface ProbeSource {
  size: number;
  /** 读 [offset, offset + length)，到文件尾就少给；offset 超出返回空 */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export class ProbeBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeBudgetError";
  }
}

/** 超时：分析可能还卡在 WASM 里，实例要丢掉重建 */
export class ProbeTimeoutError extends ProbeBudgetError {
  constructor(message: string) {
    super(message);
    this.name = "ProbeTimeoutError";
  }
}

let instance: Promise<MediaInfo<"object">> | null = null;
let chain: Promise<unknown> = Promise.resolve();

async function getInstance(): Promise<MediaInfo<"object">> {
  instance ??= mediaInfoFactory({ format: "object", coverData: false, full: false, chunkSize: PROBE_LIMITS.CHUNK_BYTES });
  try {
    return await instance;
  } catch (err) {
    instance = null;
    throw err;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError(`探测超过 ${ms / 1000} 秒没有结果`)), ms);
    const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

export interface AnalyzeOutcome {
  result: MediaInfoResult;
  bytesRead: number;
  reads: number;
}

/** 分析一个来源；全局串行。预算超了抛 ProbeBudgetError，超时后丢掉实例下次重建（分析可能卡在半路） */
export function analyzeSource(source: ProbeSource, opts: { signal?: AbortSignal } = {}): Promise<AnalyzeOutcome> {
  const run = async (): Promise<AnalyzeOutcome> => {
    const mi = await getInstance();
    let bytesRead = 0;
    let reads = 0;
    const readChunk = async (length: number, offset: number): Promise<Uint8Array> => {
      opts.signal?.throwIfAborted();
      if (offset >= source.size || length <= 0) return new Uint8Array(0);
      const want = Math.min(length, source.size - offset);
      if (reads >= PROBE_LIMITS.MAX_READS || bytesRead + want > PROBE_LIMITS.MAX_BYTES) {
        throw new ProbeBudgetError(`读取量超过上限（${PROBE_LIMITS.MAX_READS} 次 / ${PROBE_LIMITS.MAX_BYTES >> 20} MB）`);
      }
      const buf = await source.read(offset, want, opts.signal);
      reads++;
      bytesRead += buf.length;
      return buf;
    };
    try {
      const result = await withTimeout(mi.analyzeData(source.size, readChunk), PROBE_LIMITS.TIMEOUT_MS, opts.signal);
      return { result, bytesRead, reads };
    } catch (err) {
      if (err instanceof ProbeTimeoutError) instance = null;
      throw err;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

/** 仅供测试：丢掉实例 */
export function __test_resetMediaInfo(): void {
  instance = null;
}

export interface RangeLink {
  url: string;
  headers?: Record<string, string>;
}

/**
 * 网盘直链上的 Range 读取。大小没给的话先读第一块，从 Content-Range 里拿总大小（第一块留着给 offset 0 用，不白读）。
 * 服务端不理 Range 回 200 整个文件时 maxContentLength 会拦下来，当成「直链不支持 Range」
 */
export async function openRangeSource(link: RangeLink, size: number | undefined, extraHeaders: Record<string, string> = {}): Promise<ProbeSource> {
  const headers = { ...extraHeaders, ...(link.headers ?? {}) };
  const fetchRange = async (offset: number, length: number, signal?: AbortSignal): Promise<{ data: Uint8Array; total?: number }> => {
    const res = await axios.get<ArrayBuffer>(link.url, {
      headers: { ...headers, Range: `bytes=${offset}-${offset + length - 1}` },
      responseType: "arraybuffer",
      timeout: 20_000,
      maxContentLength: length + 64 * 1024,
      maxRedirects: 5,
      validateStatus: (s) => s === 206 || s === 200,
      signal,
    });
    if (res.status === 200 && offset !== 0) throw new Error("直链不支持 Range 读取");
    const data = new Uint8Array(res.data);
    const cr = String(res.headers["content-range"] ?? "");
    const m = /\/(\d+)\s*$/.exec(cr);
    const total = m ? Number(m[1]) : res.status === 200 ? data.byteLength : undefined;
    return { data: data.byteLength > length ? data.subarray(0, length) : data, total };
  };
  let first: Uint8Array | null = null;
  let total = size;
  if (total === undefined || total <= 0) {
    const r = await fetchRange(0, PROBE_LIMITS.CHUNK_BYTES);
    first = r.data;
    total = r.total ?? r.data.byteLength;
  }
  const known = total;
  return {
    size: known,
    async read(offset, length, signal) {
      if (first && offset === 0 && length <= first.byteLength) return first.subarray(0, length);
      const r = await fetchRange(offset, length, signal);
      return r.data;
    },
  };
}
