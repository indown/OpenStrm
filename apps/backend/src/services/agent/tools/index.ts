/**
 * 全部智能体工具，以及「这个令牌能看到哪些」。
 * 工具名和参数就是对外 API：自建工作流会把它们写死，只加不改（tools.snapshot.test.ts 钉着）。
 */
import type { AgentToken, AgentToolInfo } from "@openstrm/shared";
import { hasToolset } from "../access.js";
import type { ToolDef } from "../define.js";
import { jobStatusTool, overviewTool, tasksListTool } from "./core.js";
import { syncCancelTool, syncHistoryTool, syncStartTool, syncStatusTool } from "./sync.js";
import { driveArchiveTool, driveBrowseTool, offlineAddTool, offlineListTool, shareInspectTool, shareSaveTool } from "./transfer.js";
import {
  organizeAdjustTool,
  organizeApplyTool,
  organizeCancelTool,
  organizeDetailTool,
  organizeListTool,
  organizePreviewTool,
  organizeRevertTool,
  organizeSkipTool,
  organizeStatusTool,
  tmdbSearchTool,
} from "./organize.js";
import { followCheckTool, followDeleteTool, followListTool, followUpdateTool } from "./follow.js";
import { strmCheckTool, strmDeleteTool, strmFixTool, strmRebuildTool, strmSearchTool, strmVerifyTool } from "./strm.js";
import { resourceSearchTool } from "./resource.js";
import { libraryAddTool, libraryMatchTool, librarySearchTool, librarySourcesTool, libraryWorkTool, libraryWorksTool } from "./library.js";
import { copyAddTool, copyAfterTool, copyListTool, copyRetryTool } from "./copy.js";

export const AGENT_TOOLS: readonly ToolDef[] = [
  overviewTool,
  tasksListTool,
  jobStatusTool,
  syncStartTool,
  syncCancelTool,
  syncStatusTool,
  syncHistoryTool,
  driveBrowseTool,
  driveArchiveTool,
  shareInspectTool,
  shareSaveTool,
  offlineAddTool,
  offlineListTool,
  organizeListTool,
  organizeStatusTool,
  organizeDetailTool,
  tmdbSearchTool,
  organizePreviewTool,
  organizeAdjustTool,
  organizeCancelTool,
  organizeApplyTool,
  organizeRevertTool,
  organizeSkipTool,
  followListTool,
  followCheckTool,
  followUpdateTool,
  followDeleteTool,
  strmSearchTool,
  strmCheckTool,
  strmVerifyTool,
  strmFixTool,
  strmRebuildTool,
  strmDeleteTool,
  resourceSearchTool,
  librarySearchTool,
  libraryWorksTool,
  libraryWorkTool,
  libraryAddTool,
  libraryMatchTool,
  librarySourcesTool,
  copyListTool,
  copyAddTool,
  copyRetryTool,
  copyAfterTool,
];

/** 档位里有、工具集里也有（基础工具不属于任何一组，总在） */
export function toolsFor(token: Pick<AgentToken, "scopes" | "toolsets">): ToolDef[] {
  return AGENT_TOOLS.filter((t) => token.scopes.includes(t.scope) && hasToolset(token, t.toolset));
}

/** 叫这个名字的工具存不存在（令牌看不到的也算）：调用记录里区分「越权」和「瞎编的工具名」 */
export function isAgentTool(name: string): boolean {
  return AGENT_TOOLS.some((t) => t.name === name);
}

export function toolCatalog(): AgentToolInfo[] {
  return AGENT_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    scope: t.scope,
    toolset: t.toolset,
    readOnly: t.annotations.readOnly,
    destructive: t.annotations.destructive,
  }));
}
