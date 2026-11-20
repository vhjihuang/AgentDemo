/**
 * 入口文件:串联「RAG 检索 → 初始化 Agent → 执行任务」的完整流程。
 *
 * ---------------------------------------------------------------------------
 * 分层差距(参照系:earendil-works/pi,分层框架详见 Agent.ts 头部):
 *
 * [L1 状态层] 本文件是 Agent 生命周期的持有者,补 L1 时:
 *   close 归属移到这里统一管理,并示范多轮 invoke 的用法。
 *   (invoke 内嵌的 close 是当前"一次性"的根源,见 Agent.ts。)
 *
 * [L3 持久层·RAG 侧] Pi 没有 RAG,以下两条属于领域通用实践,
 *   不在 Pi 参照系内,单列:
 *   - 每次启动全量 re-embed(文档数 = HTTP 请求数)。成熟做法:
 *     embedding 持久化(JSON/SQLite),只对新增或变更文件增量嵌入。
 *   - knowledge 目录不存在时 readdirSync 抛裸异常,应快速失败。
 *
 * [快速失败] 环境变量(OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL)
 *   缺失时应启动即报错,而不是到 LLM 请求时才报难以定位的 401。
 *   Pi 的 harness 在启动阶段做完整环境校验,属于同一层级的启动边界。
 * ---------------------------------------------------------------------------
 */
import path from "path";
import fs from "node:fs";
import Agent from "./Agent";
import ChatOpenAI from "./ChatOpenAi";
import EmbeddingRetrivers from "./EmdeddingRetrivers";
import MCPClient from "./MCPClient";
import { logTitle } from "./utils";

const currentDir = process.cwd();

/**
 * 通过 uvx 拉起的 mcp-server-fetch:server 是独立子进程,由本程序用 stdio 管理。
 * --offline:只用本地缓存,不联网搜 pypi,避免离线环境启动失败。
 * --with "mcp<2":强制 mcp 1.x,绕开 2.0.0 把 McpError 改名为
 * MCPError 的 breaking change。不固定版本的话,升级后 SDK 抛的
 * 异常类型不一致,上层 catch 会静默失效。
 */
const fetchMCP = new MCPClient("fetch", "uvx", [
  "--offline",
  "--with",
  "mcp<2",
  "mcp-server-fetch",
]);
/**
 * filesystem server:暴露文件读写工具,工作目录被限制在
 * currentDir 下(安全边界)。
 * TODO: server 名 "flie" 是拼写错误,应改为 "filesystem",
 * 仅影响日志可读性。
 */
const fileMCP = new MCPClient("flie", "npx", [
  "-y",
  "@modelcontextprotocol/server-filesystem",
  currentDir,
]);

async function main() {
  // 以下为调试代码(注释保留,可随时取消注释验证单模块):
  // const llm = new ChatOpenAI(process.env.OPENAI_MODEL!)
  // const { content, toolCalls } = await llm.chat('你好')
  // content 已在 chat() 内流式打印,这里不再重复输出
  // console.log('\ntoolCalls:', toolCalls)

  // await fetchMCP.init()
  // const tools = await fetchMCP.getTools()
  // depth: null 完全展开嵌套对象,避免显示 [Object]
  // console.dir(tools, { depth: null })
  // await fetchMCP.close()

  // 任务:先检索 Kamren 的资料,再让 Agent 生成故事并写入文件。
  // 写文件会触发 filesystem server 的 write_file 工具调用,
  // 验证完整工具链。
  const prompt = `根据 Kamren 的信息,创作她的故事,并把她的故事保存到${currentDir}/Kamren.md,要包含她的基本信息和故事`;
  const context = await retriveContext(prompt);

  const agent = new Agent(
    process.env.OPENAI_MODEL!,
    [fetchMCP, fileMCP],
    "",
    context,
  );
  await agent.init();
  // TODO(L1 状态层):invoke() 内部的 finally 已调用 close(),此处再 close
  // 属于双重关闭。补 L1 时 close 归属移交到这里,并示范多轮 invoke。
  const response = await agent.invoke(prompt);
  console.log(response);
  await agent.close();
}

/**
 * RAG 检索:把 knowledge/ 下全部文档嵌入向量库,再用 prompt
 * 语义检索相关片段。
 *
 * 为什么这样写:"离线建索引 → 在线查询"是 RAG 的标准两步走。
 * TODO(L3 持久层·RAG 侧):每次启动全量 re-embed,文档数等于
 * HTTP 请求数,文档一多线性变慢。成熟做法:embedding 持久化到
 * 本地(JSON/SQLite),只对新增或变更文件增量嵌入。
 * (RAG 不在 Pi 参照系内,此条属领域通用实践。)
 */
async function retriveContext(prompt: string) {
  const embeddingRetriver = new EmbeddingRetrivers("nomic-embed-text:latest");
  const knowledgeDir = path.join(currentDir, "knowledge");
  const files = fs.readdirSync(knowledgeDir);
  for (const file of files) {
    const content = fs.readFileSync(path.join(knowledgeDir, file), "utf-8");
    await embeddingRetriver.embedDocument(content);
  }
  const context = await embeddingRetriver.retrive(prompt);
  logTitle("CONTEXT");
  console.log(context);
  return context.map((item) => item.document).join("\n");
}

main();
