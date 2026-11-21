/**
 * Agent 调查层对外入口。
 *
 * 这一层不参与确定性判定，只对 NEED_MANUAL 条目产出建议与证据。
 */
export { runAgentLoop } from "./loop.js";
export type { AgentLoopOptions, AgentLoopResult } from "./loop.js";
export { investigateNeedsManual, parseSuggestion } from "./investigate.js";
export type { InvestigateOptions } from "./investigate.js";
export { createInvestigationTools } from "./tools.js";
export type { InvestigationToolContext } from "./tools.js";
export type {
  ChatModel,
  InvestigationReport,
  ModelMessage,
  Tool,
  ToolCall,
  ToolDefinition,
} from "./types.js";
