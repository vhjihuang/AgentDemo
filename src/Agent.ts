/**
 * Agent:ReAct 循环内核(Reasoning + Acting)
 *
 * 职责:持有 LLM 与一批 MCP 工具,反复执行:
 *   ① 问 LLM → ② 若返回工具调用则执行并把结果回填 → ③ 再问 LLM
 * 直到 LLM 不再要求调用工具,给出最终答案为止。
 *
 * 为什么需要循环:LLM 单次只能输出"要调哪个工具 + 参数"。
 * 工具执行的结果必须塞回上下文,LLM 才能据此推理下一步。
 * 所以"多次请求"是 Agent 能力的本质,而不是实现细节。
 * (与 Pi agent 的 agent-loop.ts、Claude Code 同构)
 *
 * ---------------------------------------------------------------------------
 * 分层差距(完整参照系:earendil-works/pi 的 agent-core,源码已核对)。
 * 当前实现 = L0 循环层。其余各层"一起实现才成立",不可逐条孤立地抄:
 *
 * [L1 状态层] Pi 用 AgentState + Agent 类:常驻进程、prompt/continue/reset
 *   多入口、transcript 与单次 invoke 分离。本类的差距:
 *   - invoke 的 finally 里 close 连接 ⇒ Agent 一次性,二次 invoke 即废。
 *   - ChatOpenAI.messages 是唯一会话存储,无"会话"概念,多轮即混在一起。
 *   正确补法(必须三条一起动):close 移交调用方 + messages 按会话隔离
 *   + 提供 continue() 续跑语义。只改 close 一条,messages 仍是一次性,
 *   补出来的是半个器官。
 *
 * [L2 事件层] Pi 的 EventStream 发 agent_start/turn_start/message_update/
 *   tool_execution_start|end 等事件,subscribe() 挂消费者。本类全靠
 *   console.log,无法过滤/重放/做 UI/写测试断言。为什么它优先级最高:
 *   审批层(2a)本质上就是"工具执行前事件 + 消费者",没有事件层,
 *   审批无处挂载;持久层记录的也是事件流。先事件化,后续层才有挂点。
 *
 * [2a 审批层] Pi 的 beforeToolCall 钩子 + 权限系统联动。write_file 这类
 *   写操作需要审批确认。依赖 L2:审批结果要通过事件传播。
 *
 * [L3 持久层] Pi 的 harness:session 持久化 + compaction(上下文压缩)。
 *   对应本项目的 messages 只增不减问题。依赖 L1(先有会话概念,
 *   才谈得上按会话持久化)。
 *
 * 分层补齐顺序建议:L2 事件层 → L1 状态层 → 2a 审批层 → L3 持久层。
 * 理由:每补一层能独立跑通验证;且 L2 是其他层的挂点基础设施。
 * ---------------------------------------------------------------------------
 */
import { Tool } from "@modelcontextprotocol/sdk/spec.types";
import ChatOpenAI from "./ChatOpenAi";
import MCPClient from "./MCPClient";
import { logTitle } from "./utils";

export default class Agent {
  private mcpClients: MCPClient[];
  private llm: ChatOpenAI | null = null;
  private model: string;
  private systemPrompt: string;
  private context: string;
  /**
   * toolName -> MCPClient 映射,在 init 时构建。
   * 为什么用 Map:把"工具名 -> 负责它的 server"收敛成一处路由表。
   * invoke 内按名取用,避免散落的 if-else 查找逻辑。
   * TODO(2a 审批层):不同 server 可能暴露同名工具,Map 会静默覆盖后者。
   * 补审批层时应同时按 server 命名空间隔离或校验冲突——
   * 审批要回答"谁的工具被谁批准",同名工具会让审批归属不清。
   */
  private toolMap: Map<string, MCPClient> = new Map();

  constructor(
    model: string,
    mcpClients: MCPClient[],
    systemPrompt: string = "",
    context: string = "",
  ) {
    this.mcpClients = mcpClients;
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.context = context;
  }

  public async init(): Promise<void> {
    logTitle("INIT LLM AND TOOLS");

    // 并行初始化所有 server,并保留每个结果(成功或失败)。
    // 为什么用 allSettled 而不是 all:某个 server 挂了,
    // 不能拖垮其他可用的 server。
    const results: PromiseSettledResult<any>[] = await Promise.allSettled(
      this.mcpClients.map(async (mcpClient) => {
        await mcpClient.init();
        return mcpClient;
      }),
    );

    // 筛选失败的客户端,只记日志(优雅降级),不打断启动。
    const failedClients = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failedClients.length > 0) {
      const reasons = failedClients.map((r) => r.reason).join(", ");
      logTitle(`部分客户端初始化失败: ${reasons}`);
    }

    // 只使用成功初始化的客户端继续。
    const successfulClients = results
      .filter(
        (r): r is PromiseFulfilledResult<MCPClient> => r.status === "fulfilled",
      )
      .map((r) => r.value);

    // 全部失败意味着一个工具都没有,LLM 将无法完成任务,直接快速失败。
    if (successfulClients.length === 0) {
      throw new Error("所有MCP 客户端初始化失败, 无法启动 Agent");
    }

    // 汇总所有成功 server 的工具,并登记"工具名 -> server"映射。
    const tools: Tool[] = [];
    for (const mcpClient of successfulClients) {
      for (const tool of await mcpClient.getTools()) {
        tools.push(tool);
        this.toolMap.set(tool.name, mcpClient);
      }
    }
    this.llm = new ChatOpenAI(
      this.model,
      this.systemPrompt,
      tools,
      this.context,
    );
  }

  /** 关闭所有 server 连接(进程级清理,程序退出前调用)。 */
  public async close() {
    logTitle("CLOSE MCP CLIENTS");
    // 同样用 allSettled:单个 server 关闭失败,不应阻塞其余 server 关闭。
    await Promise.allSettled(this.mcpClients.map((c) => c.close()));
  }

  /**
   * ReAct 主循环:对用户的一个提问,循环执行工具调用直至拿到最终答案。
   */
  async invoke(prompt: string): Promise<string | undefined> {
    if (!this.llm) throw new Error("LLM not initialized");
    let response = await this.llm.chat(prompt);
    try {
      const MAX_ROUNDS = 10;
      // 外层循环:只要 LLM 还在要求调工具就继续。
      // 为什么必须有上限:没有它,一个"坏"模型可能无限
      // "调用→回填→再调用",烧光 token 且永不出结果。
      // 超限后抛错等于快速失败,而不是死循环。
      for (let round = 0; round < MAX_ROUNDS; round++) {
        // 终止条件:LLM 本轮没有工具调用,说明已给出最终答案。
        if (response.toolCalls.length === 0) return response.content;
        // 内层循环:逐个执行本轮的所有工具调用。
        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.function.name;
          const mcp = this.toolMap.get(toolName);
          // 模型请求了不存在的工具(幻觉)时,把 "not found"
          // 回填给 LLM 自行纠正。若此处直接抛错,整个会话就废了。
          // 回填错误文本是"容错 + 引导自愈"。
          if (!mcp) {
            this.llm.appendToolResult(toolCall.id, "tool not found");
            continue;
          }
          let result: string;
          try {
            logTitle("TOOL USE" + toolCall.function.name);
            console.log(`Calling tool:${toolCall.function.name}`);
            console.log(toolCall.function.arguments);
            // OpenAI 协议里 arguments 是 JSON 字符串,须先解析成对象
            // 再传给 server。空串兜底为 {},防止 JSON.parse("") 抛错。
            const args = JSON.parse(toolCall.function.arguments || "{}");
            result = JSON.stringify(
              await mcp.callTool(toolCall.function.name, args),
            );
          } catch (err) {
            // 工具执行失败同样回填错误文本而不是中断:
            // 很多工具错误(如文件不存在、网络超时)模型自己就能修正重试。
            // TODO(2a 审批层):此处执行前没有审批拦截,write_file 这类
            // 写操作会被直接执行。Pi 用 beforeToolCall 钩子 + 权限系统
            // 联动实现,而钩子的审批结果要通过 L2 事件层传播,
            // 所以该层依赖事件层先落地。
            result = `tool error:${err instanceof Error ? err.message : String(err)}`;
          }
          console.log(`Result: ${result}`);
          // 关键一步:把工具结果按 toolCallId 追加进对话历史,
          // LLM 下一轮才能"看到"工具到底返回了什么。
          this.llm.appendToolResult(toolCall.id, result);
        }
        // 无 prompt 等于续聊,LLM 会基于回填的工具结果继续推理。
        response = await this.llm.chat();
      }
      throw new Error(`工具调用循环超过${MAX_ROUNDS}轮`);
    } finally {
      // TODO(L1 状态层):close 放在 finally 里使 Agent 变成"一次性"——
      // invoke 结束连接即销毁,无法进行多轮对话。
      // index.ts 里又 close 一次,属于双重关闭。
      // 注意:单改这一条补不成状态层——messages 仍是全生命周期一份,
      // 多轮会话依旧混在一起。补 L1 必须同时做:
      // close 移交调用方 + 会话状态与 Agent 实例分离 + continue() 语义。
      // 参照 Pi 的 Agent 类(prompt/continue/reset,transcript 独立存储)。
      await this.close();
    }
  }
}
