import path from "path";
import fs from "node:fs";
import Agent from "./Agent";
import ChatOpenAI from "./ChatOpenAi";
import EmbeddingRetrivers from "./EmdeddingRetrivers";
import MCPClient from "./MCPClient";
import { logTitle } from "./utils";

const currentDir = process.cwd();
const fetchMCP = new MCPClient("fetch", "uvx", [
  "--offline", // 只用本地缓存,不搜 pypi,避免联网失败
  "--with",
  "mcp<2",
  "mcp-server-fetch",
]);
const fileMCP = new MCPClient("flie", "npx", [
  "-y",
  "@modelcontextprotocol/server-filesystem",
  currentDir,
]);
async function main() {
  // const llm = new ChatOpenAI(process.env.OPENAI_MODEL!)
  // const { content, toolCalls } = await llm.chat('你好')
  // content 已在 chat() 内流式打印，这里不再重复输出
  // console.log('\ntoolCalls:', toolCalls)
  // --with "mcp<2" 绕开 mcp 2.0.0 把 McpError 改名为 MCPError 的 breaking change

  // await fetchMCP.init()
  // const tools = await fetchMCP.getTools()
  // depth: null 完全展开嵌套对象，避免显示 [Object]
  // console.dir(tools, { depth: null })
  // await fetchMCP.close()

  const prompt = `根据 Kamren 的信息,创作她的故事,并把她的故事保存到${currentDir}/Kamren.md,要包含她的基本信息和故事`;
  const context = await retriveContext(prompt);

  const agent = new Agent(
    process.env.OPENAI_MODEL!,
    [fetchMCP, fileMCP],
    "",
    context,
  );
  await agent.init();
  const response = await agent.invoke(prompt);
  console.log(response);
  await agent.close();
}

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
