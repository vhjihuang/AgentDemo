/**
 * Agent 层的契约。
 *
 * 这一层的职责被刻意收窄：只处理确定性链路判定不了的条目（NEED_MANUAL），
 * 用工具调查后给出「建议结论 + 证据」，不直接改写决策表。
 * 因此模型、工具、循环三者都必须可替换，才能在无网络环境下测试。
 */
import type { Decision, ReasonCode } from "../triage/types.js";

/** 一次工具调用请求。arguments 是模型生成的 JSON 字符串，可能非法。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** role=tool 时对应哪次调用。 */
  toolCallId?: string;
  /** role=assistant 时本轮的调用请求。 */
  toolCalls?: ToolCall[];
}

/** 工具对模型暴露的描述，字段与 OpenAI function/tool 定义一致。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 一个可执行工具。execute 抛错会被转成文本回传模型，不中断会话。 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

/** 模型端口。生产实现走 OpenAI 兼容端点，测试用脚本化实现。 */
export interface ChatModel {
  complete(
    messages: ModelMessage[],
    tools: ToolDefinition[]
  ): Promise<{ content: string; toolCalls: ToolCall[] }>;
}

/** 单条 NEED_MANUAL 的调查结果。只是建议，不是最终判定。 */
export interface InvestigationReport {
  cveId: string;
  package: string;
  suggestedDecision: Decision;
  reason: ReasonCode;
  /** 支撑结论的证据描述，例如「src/notify.js:12 调用 template」。 */
  evidence: string[];
  rounds: number;
  stoppedBy: "final" | "max_rounds" | "unparseable";
}
