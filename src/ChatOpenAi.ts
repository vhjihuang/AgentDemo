import OpenAI from "openai";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import 'dotenv/config';
import { logTitle } from "./utils";

export interface ToolCall {
  id: string,
  function: {
    name: string,
    arguments: string
  }
}

export default class ChatOpenAI {
  private llm: OpenAI;
  private model: string;
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private tools: Tool[];
  constructor(model: string, systemPrompt: string = '', tools: Tool[] = [], context: string = '') {
    this.llm = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
    this.model = model;
    this.tools = tools;
    if (systemPrompt) this.messages.push({ role: 'system', content: systemPrompt })
    if (context) this.messages.push({ role: 'user', content: context })
  }
  async chat(prompt?: string) {
    logTitle('chat')
    if (prompt) this.messages.push({ role: 'user', content: prompt });
    const stream = await this.llm.chat.completions.create({
      model: this.model,
      messages: this.messages,
      stream: true,
      tools: this.getToolDefintion()
    });
    let content = ''
    let toolCalls: ToolCall[] = []
    logTitle('RESPONSE')
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (delta.content) {
        const contentChunk = delta.content || '';
        content += contentChunk
        process.stdout.write(contentChunk)
      }
      if (delta.tool_calls) {
        for (const toolCallsChunk of delta.tool_calls) {
          if (toolCalls.length <= toolCallsChunk.index) {
            toolCalls.push({ id: '', function: { name: '', arguments: '' }})
          }
          let currentCall = toolCalls[toolCallsChunk.index]
          if (toolCallsChunk.id) currentCall.id += toolCallsChunk.id
          if (toolCallsChunk.function?.name) currentCall.function.name += toolCallsChunk.function.name
          if (toolCallsChunk.function?.arguments) currentCall.function.arguments += toolCallsChunk.function.arguments
        }
      }
    }
    this.messages.push({
      role: "assistant",
      content,
      tool_calls: toolCalls.map((call) => ({
        type: "function",
        id: call.id,
        function: call.function,
      })),
    });
    return { content, toolCalls }
  }

  public appendToolResult(toolCallId: string, toolOutput: string) {
    this.messages.push({
      role: "tool",
      content: toolOutput,
      tool_call_id: toolCallId,
    });
  }

  private getToolDefintion() {
    return this.tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      },
    }))
  }
}
