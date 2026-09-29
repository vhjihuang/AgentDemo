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
  /** toolName -> MCPClient 的映射,在 init 时构建,避免 invoke 中异步查询*/
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

    // 并行初始化所有客户端,并保留每个结果(成功或失败)
    const results: PromiseSettledResult<any>[] = await Promise.allSettled(
      this.mcpClients.map(async (mcpClient) => {
        await mcpClient.init();
        return mcpClient;
      }),
    );

    // 筛选失败的客户端
    const failedClients = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failedClients.length > 0) {
      const reasons = failedClients.map((r) => r.reason).join(", ");
      logTitle(`部分客户端初始化失败: ${reasons}`);
    }

    // 只使用成功初始化的客户端
    const successfulClients = results
      .filter(
        (r): r is PromiseFulfilledResult<MCPClient> => r.status === "fulfilled",
      )
      .map((r) => r.value);

    // 如果全部失败,则无法继续
    if (successfulClients.length === 0) {
      throw new Error("所有MCP 客户端初始化失败, 无法启动 Agent");
    }

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

  //
  public async close() {
    logTitle("CLOSE MCP CLIENTS");
    await Promise.allSettled(this.mcpClients.map((c) => c.close()));
  }

  async invoke(prompt: string): Promise<string | undefined> {
    if (!this.llm) throw new Error("LLM not initialized");
    let response = await this.llm.chat(prompt);
    try {
      const MAX_ROUNDS = 10;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (response.toolCalls.length === 0) return response.content;
        // 处理工具调用
        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.function.name;
          const mcp = this.toolMap.get(toolName);
          if (!mcp) {
            this.llm.appendToolResult(toolCall.id, "tool not found");
            continue;
          }
          let result: string;
          try {
            logTitle("TOOL USE" + toolCall.function.name);
            console.log(`Calling tool:${toolCall.function.name}`);
            console.log(toolCall.function.arguments);
            const args = JSON.parse(toolCall.function.arguments || "{}");
            result = JSON.stringify(
              await mcp.callTool(toolCall.function.name, args),
            );
          } catch (err) {
            result = `tool error:${err instanceof Error ? err.message : String(err)}`;
          }
          console.log(`Result: ${result}`);
          this.llm.appendToolResult(toolCall.id, result);
        }
        response = await this.llm.chat();
      }
      throw new Error(`工具调用循环超过${MAX_ROUNDS}轮`);
    } finally {
      await this.close();
    }
  }
}
