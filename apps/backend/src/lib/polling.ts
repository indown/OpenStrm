/**
 * 后台循环的公共实现：云下载回执、追更、Emby 入库通知、复制队列、收藏夹巡检、网盘监控（每账号一条）、
 * Telegram 长轮询都跑在它上面。
 *
 * 这些地方以前各写了一份「running + timer + ticking + schedule + runTick」，除了间隔之外一模一样，
 * 而且都有同一个毛病：这一轮失败了，下一轮照原间隔再来——cookie 失效、被封控的时候
 * 会一直以同样的频率去撞。这里把同一件事交给 rxjs 表达：
 *
 *   跑一轮 → 成不成都问一句还继不继续 → 等一会（成功等 intervalMs，失败按次数退避）→ 再来
 *
 * 几个刻意的选择：
 *   - **等待从上一轮结束算起**，不是固定节拍。追更一轮可能跑过 60 秒，按节拍的话下一轮会紧贴着
 *     上一轮开跑，分享接口被打得比原来密一倍——这些循环的间隔本来就是为了护着上游。
 *   - **成败都问 shouldContinue**：待办清空、订阅全关就收工，不能因为正卡在退避里就一直醒着打接口。
 *   - **加急能打断等待**（race）：Emby 刷新之后的加急不该被一个十分钟的退避吞掉。
 *   - **shouldContinue 自己抛了不算数**：它背后是 better-sqlite3 的同步读，SQLITE_BUSY 不该把
 *     整个后端带崩（rxjs 的未处理错误会走 uncaughtException），更不该留下一个 running=true 的空壳。
 *   - **stop 会掐断交给 tick 的 signal**：长轮询、拉网盘这种长活儿挂上它，停机不用等它自己跑完；
 *     被掐断的那一轮不算失败、不记日志（订阅已经退了）。
 *
 * 一轮里能自己消化的失败（某个账号的列表拿不到，其余照跑）不该抛出来，在 tick 里 noteError()
 * 记一句就行：跑完一轮如果没人记过，状态里的错就清掉；这一轮失败了，原因会一直留到下一轮跑完。
 */
import { concat, defer, merge, race, Subject, type Subscription, catchError, exhaustMap, ignoreElements, map, repeat, take, takeUntil, tap } from "rxjs";
import { messageOf } from "./errors.js";
import { unrefTimer } from "./rx.js";
import type { moduleLogger } from "./logger.js";

/** 连续失败的退避上限：够躲开一阵风控，又不至于久到让人以为循环死了 */
const DEFAULT_MAX_BACKOFF_MS = 10 * 60_000;

type Logger = ReturnType<typeof moduleLogger>;

export interface PollingLoopOptions {
  /** 日志里的称呼，比如「云下载回执循环」 */
  name: string;
  log: Logger;
  /** 一轮结束到下一轮开始之间等多久 */
  intervalMs: number;
  /** 第一轮的延迟，默认立刻 */
  firstDelayMs?: number;
  /** 跑一轮。抛出来的错由这里退避重试。signal 在 stop() 时中止：长活儿挂上它，停机不用等它自己跑完 */
  tick: (signal: AbortSignal) => Promise<void>;
  /** 每轮跑完（成败都问）还要不要继续；false = 收工。自己抛了当没问过 */
  shouldContinue?: () => boolean;
  /** 收工时记的那行日志 */
  doneMessage?: string;
  /** 连续失败的退避上限，默认 10 分钟 */
  maxBackoffMs?: number;
  /** 失败退避的基数：第一次失败等这么久、之后翻倍。默认就是 intervalMs；长轮询这种间隔为 0 的循环要单独给 */
  backoffBaseMs?: number;
  /** 循环退出时叫一次：自己收工的、异常退出的、被 stop 的都走到。状态收尾（写游标、置 running）放这里 */
  onExit?: () => void;
}

export interface PollingLoop {
  readonly running: boolean;
  /** 最近一轮的失败原因；跑成了且没人 noteError 就是 null */
  readonly lastError: string | null;
  start(): void;
  /** 停循环：掐断 tick 的 signal，并等正在跑的那一轮收尾 */
  stop(): Promise<void>;
  /** delayMs 之后插一轮加急；这段窗口里重复调只算一次，有一轮正在跑就跳过 */
  nudge(delayMs: number): void;
  /** 让 tick 把自己消化掉的失败记进状态；给 null 是清掉 */
  noteError(message: string | null): void;
}

export function createPollingLoop(opts: PollingLoopOptions): PollingLoop {
  const { name, log, intervalMs, tick } = opts;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const backoffBaseMs = opts.backoffBaseMs ?? intervalMs;
  const stop$ = new Subject<void>();
  /** shouldContinue 说收工 */
  const retire$ = new Subject<void>();
  /** 外面调 nudge 投进来的延迟 */
  const nudge$ = new Subject<number>();
  /** 延迟到点、真该插一轮了 */
  const urgent$ = new Subject<void>();

  let sub: Subscription | null = null;
  let nudgeSub: Subscription | null = null;
  let running = false;
  let lastError: string | null = null;
  /** 这一轮里 tick 自己记下的原因；跑完一轮就把它定成 lastError */
  let roundError: string | null = null;
  let failStreak = 0;
  /** 正在跑的那一轮：停机要等它收尾，不然 stop 返回之后还有写操作落下来 */
  let ticking: Promise<void> | null = null;
  /** 这次 start 交给 tick 的信号：stop 掐它 */
  let controller: AbortController | null = null;
  /** 这次 start 的退出收尾：自己退和被 stop 只走一次 */
  let exitOnce: (() => void) | null = null;
  /** 加急到点时正有一轮在跑：记下来，这一轮一结束就插一轮，不丢 */
  let urgentPending = false;

  const runOnce = async (): Promise<void> => {
    roundError = null;
    const started = tick(controller?.signal ?? new AbortController().signal);
    // 等的那份要吞掉错误：stop() 里 await 它，不能把失败重新抛给停机流程
    const settled = started.then(
      () => {},
      () => {},
    );
    ticking = settled;
    try {
      await started;
    } finally {
      if (ticking === settled) ticking = null;
    }
  };

  /** 判断不了就继续跑：宁可多打一轮接口，也别留下一个 running=true 却不动的空壳 */
  const keepGoing = (): boolean => {
    if (!opts.shouldContinue) return true;
    try {
      return opts.shouldContinue() !== false;
    } catch (err) {
      log.warn({ err }, `${name}判断要不要继续时出错，先接着跑`);
      return true;
    }
  };

  /** 连续失败 failStreak 次之后等多久 */
  const backoffMs = (): number => Math.min(maxBackoffMs, backoffBaseMs * 2 ** (failStreak - 1));
  const waitMs = (): number => (failStreak === 0 ? intervalMs : backoffMs());

  /** 等一会儿；加急到点能把这次等待打断；上一轮跑的时候就到点了的加急不等了，马上来 */
  const waiting$ = (ms: number) => {
    if (urgentPending) {
      urgentPending = false;
      return unrefTimer(0);
    }
    return ms > 0 ? race(unrefTimer(ms), urgent$).pipe(take(1)) : unrefTimer(0);
  };

  return {
    get running() {
      return running;
    },
    get lastError() {
      return lastError;
    },
    noteError(message: string | null) {
      roundError = message;
      lastError = message;
    },
    nudge(delayMs: number) {
      // 没在跑就没有订阅者，这一下自然是空操作
      nudge$.next(delayMs);
    },
    start() {
      if (running) return;
      running = true;
      let retired = false;
      failStreak = 0;
      controller = new AbortController();
      let exited = false;
      const exit = () => {
        if (exited) return;
        exited = true;
        if (exitOnce === exit) exitOnce = null;
        opts.onExit?.();
      };
      exitOnce = exit;

      // 加急：第一条起一个延时，这段窗口里再来的丢掉（exhaustMap）；到点了投给 urgent$。
      // 那一刻要是正好有一轮在跑，urgent$ 没人听：记下来，这一轮一结束就紧接着来一轮
      // （以前是直接丢掉；Emby 入库那条循环的一轮能跑上一分钟，刷新之后的加急丢了就要再等两分钟）
      urgentPending = false;
      nudgeSub = nudge$
        .pipe(
          exhaustMap((ms) => unrefTimer(ms)),
          takeUntil(merge(stop$, retire$)),
        )
        .subscribe(() => {
          if (ticking) urgentPending = true;
          else urgent$.next();
        });

      const round$ = defer(runOnce).pipe(
        map(() => {
          // 跑成了：这一轮的结论就是 tick 自己记的（没记就是没事）
          failStreak = 0;
          lastError = roundError;
          return true;
        }),
        catchError((err: unknown) => {
          failStreak += 1;
          lastError = messageOf(err);
          log.warn({ err }, `${name}这一轮失败（连续 ${failStreak} 次），${Math.round(backoffMs() / 1000)}s 后重试`);
          // 失败也算跑完一轮：下面照样要问 shouldContinue，不能一直醒着打接口
          return [false];
        }),
        tap(() => {
          if (!keepGoing()) {
            retired = true;
            retire$.next();
          }
        }),
      );

      // repeat 挂在 round$ 上，不能套在首延迟外面——那样每一轮都会把首延迟再等一遍。
      // 首延迟就算是 0 也要走一趟计时器：start() 必须先返回，第一轮才开跑
      // （调用方常常是「加完任务顺手起循环」，不能让它替第一轮把同步那段跑了）
      const loop$ = round$.pipe(repeat({ delay: () => waiting$(waitMs()) }));
      const chain$ = concat(waiting$(opts.firstDelayMs ?? 0).pipe(ignoreElements()), loop$);

      sub = chain$
        .pipe(takeUntil(merge(stop$, retire$)))
        .subscribe({
          error: (err: unknown) => {
            // 链路本身炸了（不该发生）：把状态收回来，别留一个「在跑」的空壳
            running = false;
            sub = null;
            lastError = messageOf(err);
            log.error({ err }, `${name}异常退出`);
            exit();
          },
          complete: () => {
            running = false;
            sub = null;
            if (retired && opts.doneMessage) log.info(opts.doneMessage);
            exit();
          },
        });
    },
    async stop() {
      running = false;
      urgentPending = false;
      stop$.next();
      sub?.unsubscribe();
      sub = null;
      nudgeSub?.unsubscribe();
      nudgeSub = null;
      // 先退订再掐信号：被掐断的那一轮抛出来的错没人听，不算失败、不记日志
      controller?.abort();
      controller = null;
      await ticking;
      exitOnce?.();
    },
  };
}
