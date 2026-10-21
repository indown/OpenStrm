/**
 * 网盘请求限流：每个账号一个节奏（接口请求一个一个匀速发），账号的每条通道一个并发上限。
 *
 *   normal    普通接口请求（列目录、取直链、转存、整理……）
 *   life      网盘监控的轮询
 *   offline   云下载的列表 / 添加：界面上刷列表不该和取直链抢同一个槽位
 *   download  文件下载：只有并发上限，不占接口的节奏
 *
 * 调用方只说账号和通道，每秒几个、并发多少都在这里按设置定——以前四个调用点各读一遍设置、各带一个兜底值。
 * 设置改了，已经建好的限流器原地换成新值，不用重启、不用等在跑的任务结束。
 * 限流器在进程里：API 进程和 Emby 代理进程各有各的一套，同一个账号两边各按各的节奏发，互相不排队。
 * 这个文件不 import 网盘那一侧的任何东西：三家的客户端都要用它，反过来 import 就成环。
 */
import Bottleneck from "bottleneck";
import { Observable, type Subscription } from "rxjs";
import type { ThrottleSettings } from "@openstrm/shared";
import { THROTTLE_DEFAULTS, THROTTLE_LIMITS } from "../db/defaults.js";
import { readAppSetting } from "../db/repositories/settings.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("throttle");

export type ThrottleChannel = "normal" | "life" | "offline" | "download";

/**
 * 排队的先后：Bottleneck 的优先级 0～9，数字小的先发，默认 5；链在节奏上的通道会把它一起带给节奏。
 * 投机的后台请求（PlaybackInfo 之后的预解析）排在普通请求后面：真正的 302 解析、同步、界面上的操作都不该等它
 */
export const PRIORITY_BACKGROUND = 7;

/** 补齐、夹过上下限之后实际用的三个值 */
export type ThrottleValues = Required<ThrottleSettings>;

function within(value: unknown, fallback: number, { min, max }: { min: number; max: number }): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * 设置里存的 → 实际用的：没填的补默认，越界的夹回上下限，并发取整（每秒请求数可以是小数，0.5 = 两秒一个）。
 * 库里的值不一定经过校验（老数据、直接调接口写的）：并发 0.5 原样交给限流器的话，这个账号的请求会全部永远排队。
 */
export function normalizeThrottle(raw: ThrottleSettings | undefined): ThrottleValues {
  return {
    requestsPerSecond: within(raw?.requestsPerSecond, THROTTLE_DEFAULTS.requestsPerSecond, THROTTLE_LIMITS.requestsPerSecond),
    requestConcurrency: Math.floor(within(raw?.requestConcurrency, THROTTLE_DEFAULTS.requestConcurrency, THROTTLE_LIMITS.requestConcurrency)),
    downloadConcurrency: Math.floor(within(raw?.downloadConcurrency, THROTTLE_DEFAULTS.downloadConcurrency, THROTTLE_LIMITS.downloadConcurrency)),
  };
}

export function throttleSettings(): ThrottleValues {
  return normalizeThrottle(readAppSetting("throttle"));
}

/** 每秒几个 → 相邻两个请求最少隔多少毫秒 */
export function paceIntervalMs(requestsPerSecond: number): number {
  return Math.round(1000 / requestsPerSecond);
}

const concurrencyOf = (channel: ThrottleChannel, values: ThrottleValues): number =>
  channel === "download" ? values.downloadConcurrency : values.requestConcurrency;

interface AccountLimiters {
  /** 接口请求的节奏：这个账号除 download 以外的通道共用 */
  pace: Bottleneck;
  channels: Map<ThrottleChannel, Bottleneck>;
}

/** 按账号名分。以前的键是「账号名:通道」再按冒号切回账号名，名字里带冒号的两个账号会共用一个配额 */
const accounts = new Map<string, AccountLimiters>();

/** 手上这批限流器是按哪组值建的 / 调的 */
let applied: ThrottleValues | null = null;

const sameValues = (a: ThrottleValues, b: ThrottleValues): boolean =>
  a.requestsPerSecond === b.requestsPerSecond && a.requestConcurrency === b.requestConcurrency && a.downloadConcurrency === b.downloadConcurrency;

/**
 * 把已经建好的限流器原地调成这组值，排着的、在跑的任务都不受影响。
 * 已经排好发出时刻的那几个请求还按旧间隔走完，之后才是新间隔：每秒 2、接口并发 2 时大约一秒多。
 */
function retune(values: ThrottleValues): Promise<unknown> {
  applied = values;
  const minTime = paceIntervalMs(values.requestsPerSecond);
  // updateSettings 的类型声明写的是同步返回，实际回的是 Promise
  const updates: unknown[] = [];
  for (const { pace, channels } of accounts.values()) {
    updates.push(pace.updateSettings({ minTime }));
    for (const [channel, limiter] of channels) updates.push(limiter.updateSettings({ maxConcurrent: concurrencyOf(channel, values) }));
  }
  return Promise.all(updates);
}

/**
 * 每次排队前看一眼设置（按主键读一行）：和手上这批限流器用的不一样，就原地调过来。
 * 不能只靠保存设置时调一下 applyThrottleSettings——Emby 代理是另一个进程，设置是 API 进程写的，那一下到不了它。
 * 库读不了（代理进程在库没就绪时会降级启动）就沿用手上的。
 */
function currentValues(): ThrottleValues {
  let values: ThrottleValues;
  try {
    values = throttleSettings();
  } catch {
    return applied ?? normalizeThrottle(undefined);
  }
  if (!applied) applied = values;
  else if (!sameValues(values, applied)) void retune(values).catch((err) => log.warn({ err }, "限流设置没能原地生效"));
  return values;
}

/**
 * 节奏用「相邻两个请求的最小间隔」，不用「每秒补满一次的配额」。后者是一秒发一批：额度一补满，排着的请求同时出去，
 * 上一秒末没用完的还能和下一秒的连成两批。而且带那种配额的限流器一调 updateSettings，补额度的定时器就被停掉，
 * 发完手里那一批就永远不再发——设置也就没法原地生效。别换回去。
 */
function channelLimiter(account: string, channel: ThrottleChannel): Bottleneck {
  const values = currentValues();
  let entry = accounts.get(account);
  if (!entry) {
    entry = { pace: new Bottleneck({ minTime: paceIntervalMs(values.requestsPerSecond) }), channels: new Map() };
    accounts.set(account, entry);
  }
  let limiter = entry.channels.get(channel);
  if (!limiter) {
    limiter = new Bottleneck({ maxConcurrent: concurrencyOf(channel, values) });
    // 下载打的是 CDN，不是网盘接口：每个下载之前都要先取到直链，取链是按节奏来的，下载开始得再密也密不过它
    if (channel !== "download") limiter.chain(entry.pace);
    entry.channels.set(channel, limiter);
  }
  return limiter;
}

/**
 * 保存设置的那个进程调：马上把新值用上，等它落定再回话。
 * 不调也会生效——下一个请求排队时 currentValues 会发现值变了；调一下是为了不等那个请求，排着的活立刻按新并发放行。
 */
export async function applyThrottleSettings(): Promise<void> {
  await retune(throttleSettings());
}

/**
 * 丢掉现有限流器，之后的请求按当前设置新建。测试之间用；设置变了是原地调，不用丢。
 *
 * 旧的让它排空：stop() 默认会把排队中的任务全部拒绝掉，正在跑的全量任务就此卡成永远 processing。
 * 顺序也有讲究：通道限流器链在节奏上，任务（包括 stop 自己放进去的收尾哨兵）
 * 是异步提交给父级的——父级先停，子级的收尾就会被父级拒掉。所以先等子级全部收完，再停父级。
 */
export function resetThrottle(): void {
  const old = [...accounts.values()];
  accounts.clear();
  applied = null;
  const children = old.flatMap((a) => [...a.channels.values()]);
  void Promise.allSettled(children.map((l) => l.stop({ dropWaitingJobs: false }))).then(() =>
    Promise.allSettled(old.map((a) => a.pace.stop({ dropWaitingJobs: false }))),
  );
}

/**
 * 这个账号的接口上有没有别人在排队 / 在跑：后台慢活（影库抄目录）发请求前看一眼，忙就先让，
 * 同步、界面上的操作这些有人在等的请求不用排在它后面。文件下载不算——它不占接口的节奏
 */
export function accountBusy(account: string): boolean {
  const pace = accounts.get(account)?.pace;
  if (!pace) return false;
  const c = pace.counts();
  return c.QUEUED + c.RUNNING + c.EXECUTING > 0;
}

/**
 * 单次请求排进账号的限流通道（取直链、网盘接口）。Bottleneck 本来就是 Promise 接口：
 * 槽位随 Promise 落定归还，没有订阅 / 退订那一层。signal 已中止的任务轮到时直接拒绝，不再发请求。
 * priority 不给就是默认的 5；给了就夹到 0～9 里
 */
export function scheduleForAccount<T>(
  account: string,
  channel: ThrottleChannel,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  priority?: number,
): Promise<T> {
  const options = priority === undefined ? {} : { priority: Math.min(9, Math.max(0, Math.round(priority))) };
  return channelLimiter(account, channel).schedule(options, async () => {
    signal?.throwIfAborted();
    return fn();
  });
}

/**
 * 会发进度的流排进账号的限流通道（下载用；单次请求用 scheduleForAccount）。
 * 限流器在订阅时才取：resetThrottle 之后再订阅的拿到新建的，而不是已经 stop 的旧限流器。
 */
export function enqueueForAccount<T>(account: string, channel: ThrottleChannel, fn: () => Observable<T>): Observable<T> {
  return new Observable<T>((observer) => {
    const limiter = channelLimiter(account, channel);
    let cancelled = false;
    let inner: Subscription | null = null;
    /** 任务已开始时，调它就是把限流器的槽位还回去 */
    let release: (() => void) | null = null;
    limiter
      .schedule(
        () =>
          new Promise<void>((resolve) => {
            // 排到队头时订阅方早已退订（任务取消）：直接放过，别再发请求、写盘
            if (cancelled) return resolve();
            release = resolve;
            inner = fn().subscribe({
              next: (v) => observer.next(v),
              // 错误只走 observer；这里 resolve 是为了让限流器释放槽位
              error: (err) => { observer.error(err); resolve(); },
              complete: () => { observer.complete(); resolve(); },
            });
          }),
      )
      // 限流器被 stop、fn 同步抛出之类的失败以前被丢掉，订阅方永远等不到结果
      .catch((err) => observer.error(err));
    return () => {
      cancelled = true;
      inner?.unsubscribe();
      // 订阅方退订了也要还槽位——不只是任务取消：firstValueFrom 这类"拿到第一个值就退订"的消费者
      // 退订之后，内层随后的 complete 送不到这里。只靠 complete 来 resolve 的话，一个账号的两个槽位
      // 两次请求就全部漏光，第三次起所有调用永远排队（rc.9 的 request115 就是这样挂死的）
      release?.();
    };
  });
}
