/**
 * 有界 ReAct 循环。
 *
 * 与确定性链路的边界：这里允许模型自由选工具，但轮次被 MAX_ROUNDS 硬性截断；
 * 工具异常、参数非法、工具不存在都转成文本回传，让模型自纠而不是炸掉会话。
 */
import type { ChatModel, ModelMessage, Tool, ToolCall, ToolDefinition } from "./types.js";

export interface AgentLoopOptions {
  model: ChatModel;
  tools: Tool[];
  maxRounds: number;
  systemPrompt: string;
}

export interface AgentLoopResult {
  messages: ModelMessage[];
  finalContent: string;
  rounds: number;
  stoppedBy: "final" | "max_rounds";
}

/** 执行单次工具调用，永远返回文本，不抛错。 */
async function runTool(
  toolMap: Map<string, Tool>,
  call: ToolCall
): Promise<string> {
  const tool = toolMap.get(call.name);
  if (!tool) return `tool not found: ${call.name}`;

  let args: Record<string, unknown>;
  try {
    args = call.arguments.trim() === "" ? {} : (JSON.parse(call.arguments) as Record<string, unknown>);
  } catch (error) {
    return `invalid arguments: ${(error as Error).message}`;
  }

  try {
    return await tool.execute(args);
  } catch (error) {
    return `tool error: ${(error as Error).message}`;
  }
}

export async function runAgentLoop(
  prompt: string,
  options: AgentLoopOptions
): Promise<AgentLoopResult> {
  const toolMap = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  const definitions: ToolDefinition[] = options.tools.map((tool) => tool.definition);

  const messages: ModelMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: prompt },
  ];

  let rounds = 0;
  let lastContent = "";

  while (rounds < options.maxRounds) {
    rounds += 1;
    const reply = await options.model.complete(messages, definitions);
    lastContent = reply.content;

    messages.push({
      role: "assistant",
      content: reply.content,
      toolCalls: reply.toolCalls,
    });

    if (reply.toolCalls.length === 0) {
      return { messages, finalContent: reply.content, rounds, stoppedBy: "final" };
    }

    for (const call of reply.toolCalls) {
      messages.push({
        role: "tool",
        content: await runTool(toolMap, call),
        toolCallId: call.id,
      });
    }
  }

  return { messages, finalContent: lastContent, rounds, stoppedBy: "max_rounds" };
}
