/**
 * MCP 客户端封装:以 stdio 子进程方式管理外部 MCP server。
 *
 * 核心思想:server 是独立进程(由 uvx/npx 拉起),本类负责它的完整生命周期:
 *   连接(init) → 枚举工具(getTools) → 调用(callTool) → 断开(close)
 *
 * ---------------------------------------------------------------------------
 * 分层差距(参照系:earendil-works/pi,分层框架详见 Agent.ts 头部):
 *
 * [L2 事件层] 连接成功/失败目前直接 console.log。事件化后,
 *   本类应发 connection 状态事件,由订阅者决定怎么展示与记录。
 *
 * [2a 审批层] callTool 无超时、无审批拦截点。补 2a 时,
 *   审批钩子应挂在 callTool 之前(Agent 侧)而非本类内部——
 *   本类是协议封装,审批是业务策略,分层上必须分开。
 *
 * [运维健壮性] 以下属于进程级运维问题,不在 Pi 的分层内,单列:
 *   - 无超时与重试:server 启动慢或卡死时,callTool 会一直挂着。
 *     (MCP SDK 的 Client 构造支持 timeout 选项,可直接启用。)
 *   - getTools 只返回连接时缓存的列表,server 热更新工具无法感知。
 *   - 未监听子进程 exit 事件:server 崩溃后调用会静默失败或挂起。
 * ---------------------------------------------------------------------------
 */
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { Tool } from "@modelcontextprotocol/sdk/spec.types";

export default class MCPClient {
  private mcp: Client;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];
  private command: string;
  private args: string[];

  constructor(name: string, command: string, args: string[], version?: string) {
    this.mcp = new Client({ name, version: version || "1.0.0" });
    this.command = command;
    this.args = args;
  }

  public async init() {
    await this.connectToServer();
  }

  public async close() {
    await this.mcp.close();
  }

  /** 返回连接时缓存的工具列表(不每次动态查询,避免多次 IPC)。 */
  public async getTools() {
    return this.tools;
  }

  public async callTool(name: string, params: Record<string, any>) {
    return await this.mcp.callTool({ name, arguments: params });
  }

  async connectToServer() {
    try {
      // StdioClientTransport:通过 stdin/stdout 与子进程通信。
      // 为什么选它:比 HTTP 传输省去端口与地址管理,适合本地工具 server。
      this.transport = new StdioClientTransport({
        command: this.command,
        args: this.args,
      });

      await this.mcp.connect(this.transport);

      // 连接成功后一次性枚举工具并缓存。
      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      console.log(
        "connected to server with tools",
        this.tools.map(({ name }) => name),
      );
    } catch (e) {
      // 失败必须重新抛出:让上层(Agent.init 的 allSettled)决定降级策略。
      console.log("Failed to connect to MCP server:", e);
      throw e;
    }
  }
}
