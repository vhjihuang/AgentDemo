/**
 * OpenAI 兼容端点的模型适配器。
 *
 * 只做协议转换，不持有会话状态——消息历史由循环维护，这样同一个适配器
 * 既能接本地 Ollama，也能接任何兼容 /v1/chat/completions 的服务。
 *
 * 刻意不做流式：调查阶段是短循环，非流式更容易保证一次返回完整 tool_calls。
 */
import type OpenAI from "openai";
import type { ChatModel, ModelMessage, ToolCall, ToolDefinition } from "./types.js";

type ChatClient = OpenAI;
type CreateParams = Parameters<ChatClient["chat"]["completions"]["create"]>[0];
type MessageParam = NonNullable<CreateParams["messages"]>[number];

function toMessage(message: ModelMessage): MessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content,
    } as MessageParam;
  }

  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    } as MessageParam;
  }

  return { role: message.role, content: message.content } as MessageParam;
}

function toToolDefinition(tool: ToolDefinition): NonNullable<CreateParams["tools"]>[number] {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  } as NonNullable<CreateParams["tools"]>[number];
}

export interface OpenAiChatModelOptions {
  client: ChatClient;
  /** 模型名，例如 gemma4:e4b。 */
  model: string;
  temperature?: number;
}

export function createOpenAiChatModel(options: OpenAiChatModelOptions): ChatModel {
  return {
    async complete(messages, tools) {
      const response = await options.client.chat.completions.create({
        model: options.model,
        temperature: options.temperature ?? 0,
        messages: messages.map(toMessage),
        ...(tools.length > 0 ? { tools: tools.map(toToolDefinition) } : {}),
      });

      const choice = response.choices[0]?.message;
      const toolCalls: ToolCall[] = (choice?.tool_calls ?? [])
        .filter((call) => call.type === "function")
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        }));

      return { content: choice?.content ?? "", toolCalls };
    },
  };
}
