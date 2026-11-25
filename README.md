# AgentDemo

一个手写的最小 AI Agent 实现：`LLM + Tools + Loop` 内核 + MCP 工具协议 + RAG 检索增强，没有框架封装。

- `src/Agent.ts` — Agent 循环内核
- `src/ChatOpenAi.ts` — OpenAI 兼容 LLM 封装（流式 + 工具调用组装）
- `src/MCPClient.ts` — MCP 客户端（用 stdio 管理工具子进程）
- `src/EmdeddingRetrivers.ts` / `src/VectorStore.ts` — 768 维 embedding 与余弦相似度检索
- `src/index.ts` — 装配入口：RAG 检索 → 初始化 Agent → 执行任务
- `knowledge/` — 检索用知识库
- `ARCHITECTURE.md` — 逐文件架构拆解

## 运行

需要一个 OpenAI 兼容端点（本地 Ollama 即可），并提供 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`：

```bash
pnpm install
pnpm dev
```

工具层依赖 `uvx`（`mcp-server-fetch`）与 `npx`（`@modelcontextprotocol/server-filesystem`），首次运行会额外拉取。
