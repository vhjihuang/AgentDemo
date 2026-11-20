/**
 * LLM 封装:管理对话历史 + 流式输出 + OpenAI 工具调用协议。
 *
 * ---------------------------------------------------------------------------
 * 分层差距(参照系:earendil-works/pi,详见 Agent.ts 头部的分层框架):
 *
 * [L1 状态层] messages 是唯一的会话存储,但它是本类私有的、
 *   全生命周期一份的数组。没有"会话"抽象,多轮对话必然混在一起。
 *   Pi 的做法:transcript 独立存储、按 session 隔离、可 reset。
 *   依赖关系:会话抽象落地后,L3 持久层才有"按会话落盘"的单元。
 *
 * [L2 事件层] 流式 chunk 与工具调用目前直接 process.stdout.write,
 *   观测逻辑内嵌在业务循环里。Pi 的做法:chat 过程发 message_start/
 *   message_update/message_end 事件,展示与记录由订阅者各自处理。
 *   好处:同一份事件流可同时接终端展示、日志落盘、测试断言,互不干扰。
 *
 * [L3 持久层] messages 只增不减,长会话必然爆上下文窗口。
 *   Pi 的 harness 用 compaction(自动压缩)解决,且压缩时机由
 *   事件流驱动(token 阈值事件)。依赖 L1:先有会话边界,
 *   才能定义"压缩哪一段"。
 *
 * [协议适配] 只适配 OpenAI 协议,换 Anthropic 或其他本地协议需另写实现。
 *   Pi 的做法:pi-ai 层把 Provider 抽象出来,Model 是一等对象。
 *   这条独立于分层,属于可插拔性问题,优先级由实际需求决定。
 *
 * 另:Tool 类型从 types.js 导入,而 Agent.ts 从 spec.types 导入。
 * 两处来源应统一,避免名义上同一类型实际是两个声明。
 * ---------------------------------------------------------------------------
 */
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
      // 指向 Ollama 的 OpenAI 兼容端点
      baseURL: process.env.OPENAI_BASE_URL,
    });
    this.model = model;
    this.tools = tools;
    // 角色顺序重要:system(指令)必须排在最前,user 消息依序在后。
    // TODO(L1 状态层):context 当 user 塞,LLM 可能把它当成
    // "用户本人说的话"。补会话抽象时应把 RAG context 归入
    // 会话初始状态(system 或独立标注消息),而不是散在 user 里。
    if (systemPrompt) this.messages.push({ role: 'system', content: systemPrompt })
    if (context) this.messages.push({ role: 'user', content: context })
  }
  async chat(prompt?: string) {
    logTitle('chat')
    // prompt 缺省等于"续聊":依赖上一轮 appendToolResult 回填的工具结果。
    // 这是 Agent 循环的关键路径:不带参数再问一次 LLM。
    if (prompt) this.messages.push({ role: 'user', content: prompt });
    const stream = await this.llm.chat.completions.create({
      model: this.model,
      messages: this.messages,
      // 流式输出:大输出时可增量展示,用户可感知"正在回答",
      // 而不是等全部生成完才看到。非流式功能上可行,这里是体验取舍。
      stream: true,
      tools: this.getToolDefintion()
    });
    let content = ''
    let toolCalls: ToolCall[] = []
    logTitle('RESPONSE')
    // 流式协议:内容与工具调用被切成很多 chunk,每个 chunk 只带"增量片段",
    // 必须用 += 拼接;工具调用还按 index 分片,需要靠 index 定位累积。
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (delta.content) {
        const contentChunk = delta.content || '';
        content += contentChunk
        // 边收边打印,用户可感知"正在回答"
        process.stdout.write(contentChunk)
      }
      if (delta.tool_calls) {
        for (const toolCallsChunk of delta.tool_calls) {
          // index = "这是第几个工具调用"的流式分段。
          // 该 index 第一次出现时先补一个占位,否则 toolCalls[index] 越界。
          if (toolCalls.length <= toolCallsChunk.index) {
            toolCalls.push({ id: '', function: { name: '', arguments: '' }})
          }
          let currentCall = toolCalls[toolCallsChunk.index]
          // id/name/arguments 可能跨多个 chunk 才给全,只能追加拼接。
          if (toolCallsChunk.id) currentCall.id += toolCallsChunk.id
          if (toolCallsChunk.function?.name) currentCall.function.name += toolCallsChunk.function.name
          if (toolCallsChunk.function?.arguments) currentCall.function.arguments += toolCallsChunk.function.arguments
        }
      }
    }
    // 把本轮完整 assistant 消息(含 content 与 tool_calls)记入历史。
    // 为什么必须:OpenAI 协议要求"工具调用"之后的下一轮请求,
    // 必须携带带 tool_calls 的 assistant 消息,否则协议校验失败。
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

  /** 追加一条工具结果,按 tool_call_id 对应上一轮 assistant 的某个调用。 */
  public appendToolResult(toolCallId: string, toolOutput: string) {
    this.messages.push({
      role: "tool",
      content: toolOutput,
      tool_call_id: toolCallId,
    });
  }

  /** 把 MCP 的 Tool schema 转换成 OpenAI 的 function 声明格式。 */
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
