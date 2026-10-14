/**
 * 全量同步和网盘监控的协调：同一个任务目录，两边不同时改本地。
 *
 * 全量同步拉到的远端清单可能比监控旧——大库光列目录就要几分钟，之后还要按清单一个个补文件。同步期间监控把网盘上的
 * 新变化落到本地，同步随后会按它手里的旧清单改回去：列完之后删的一集被建回来；监控刚改成新名的被当成多余删掉、旧名又建回来。
 * 所以同步在跑的目录，监控照常发现变化，但先记下（事件状态 deferred）不动本地，同步结束后按原来的先后补上。
 *
 *   - 「忙」的范围：这个账号里正在同步（含启动阶段——拉远端目录树）的任务的 originPath，每次现查：同步可能在一轮中途开始或结束。
 *   - 事件的新路径、旧路径任何一个和忙的范围交叠（相等、在它下面、或者是它的上级），就得等。
 *   - 先后不乱：一轮里已经决定要等的事件（包括补失败、这一轮先停的），后面碰到同一处（交叠）的事件也跟着等。
 *
 * 反过来不用管：同步拿到的远端清单一定不比监控看到的旧，它覆盖掉的只会是更旧的状态，之后的变化监控下一轮照样补。
 * 这里只做判断，不碰库也不碰处理器；记下、补、失败重试在 monitor.ts。
 */
import { normalizePath, type ChangeEvent } from "../drive/types.js";

/** 两个网盘路径交不交叠：相等，或者一个在另一个下面（根和谁都交叠） */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (x === "/" || y === "/") return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** 一条事件动到的网盘路径：新路径，改名 / 移动再加上旧路径 */
export function eventPaths(ev: Pick<ChangeEvent, "path" | "oldPath">): string[] {
  return ev.oldPath && ev.oldPath !== ev.path ? [ev.path, ev.oldPath] : [ev.path];
}

/**
 * 一轮的闸。busyScopes 给出现在正在同步的任务目录（绝对网盘路径），每次判断都现问。
 * 先补之前记下的、再看新来的，同一个闸贯穿一轮：补失败停下的事件挡住后面同一处的新事件。
 */
export class DeferralGate {
  /** 这一轮里已经决定要等的事件动到的路径 */
  private readonly held = new Set<string>();

  constructor(private readonly busyScopes: () => string[]) {}

  /** 要等就返回原因（写进事件说明），并把它的路径挡上；不用等返回 null */
  check(ev: Pick<ChangeEvent, "path" | "oldPath">): string | null {
    const paths = eventPaths(ev);
    const scope = this.busyScopes().find((s) => paths.some((p) => pathsOverlap(p, s)));
    if (scope !== undefined) {
      this.hold(ev);
      return `同步任务在跑（${scope}），等它跑完再处理`;
    }
    if (paths.some((p) => [...this.held].some((h) => pathsOverlap(p, h)))) {
      this.hold(ev);
      return "同一处前面还有没补上的变化，按先后跟着等";
    }
    return null;
  }

  /** 补失败、这一轮先停的事件：挡住后面同一处的 */
  hold(ev: Pick<ChangeEvent, "path" | "oldPath">): void {
    for (const p of eventPaths(ev)) this.held.add(normalizePath(p));
  }
}
