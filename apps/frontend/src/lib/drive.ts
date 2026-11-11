/**
 * 网盘类型的文案，和「这条记录是哪个账号哪个网盘的」这种一句话标签。
 * 同一个人可以在 115 和夸克上各建一个叫 tv 的任务，光看目录名分不出是哪个。
 */
import type { DriveKind, TaskRow } from "@/lib/api";

export const DRIVE_LABEL: Record<DriveKind, string> = { "115": "115", quark: "夸克", openlist: "OpenList", cd2: "CD2" };
export const DRIVE_FULL_LABEL: Record<DriveKind, string> = { "115": "115 网盘", quark: "夸克网盘", openlist: "OpenList", cd2: "CloudDrive2" };

/**
 * 挂载层账号（OpenList / CloudDrive2）：把别的网盘挂在自己下面，不是网盘本身。转存、追更、云下载、监控都不会往它的任务里落新文件，
 * 设置页的挂载映射里也没有它自己的一行。后端 services/drive/types.ts 有一份同样的判断，加类型时两边一起动
 */
export const isMountLayerKind = (kind: string | undefined): boolean => kind === "openlist" || kind === "cd2";

const labelOf = (kind?: string): string => DRIVE_LABEL[(kind ?? "") as DriveKind] ?? "";

/** 账号 + 网盘类型：`kuake（夸克）`；账号名字本身已经说明了是哪家就不重复（`115`） */
export function accountLabel(account: string, accountType?: string): string {
  const kind = labelOf(accountType);
  if (!kind) return account;
  return account.toLowerCase().includes(kind.toLowerCase()) ? account : `${account}（${kind}）`;
}

/** 一个任务在列表里怎么称呼：`kuake（夸克）· tv` */
export function taskLabel(task: Pick<TaskRow, "account" | "accountType" | "originPath">): string {
  return `${accountLabel(task.account, task.accountType)} · ${task.originPath}`;
}
