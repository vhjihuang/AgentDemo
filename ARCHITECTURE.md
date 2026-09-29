# AgentDemo 项目拆解分析

> 基于项目源码（src/ 下 7 个文件，共 447 行）逐行核对生成。
> 定位：一个手写的最小可用 AI Agent —— 「LLM + Tools + Loop」内核 + MCP 工具协议 + RAG 检索增强。

---

## 0. 项目快照

| 项 | 值 |
|---|---|
| 语言/运行时 | TypeScript + Node.js 22（tsx 直跑，无编译产物） |
| 包管理 | pnpm |
| 外部依赖 | `openai`（OpenAI 兼容 SDK）、`@modelcontextprotocol/sdk`（MCP 客户端）、`chalk`、`dotenv` |
| LLM | 本地 Ollama（`gemma4:e4b`），走 OpenAI 兼容端点 `/v1` |
| Embedding | 本地 Ollama（`nomic-embed-text`，768 维），同端口 `/v1/embeddings` |
| 工具层 | MCP 协议：`mcp-server-fetch`（uvx 启动，Python）+ `@modelcontextprotocol/server-filesystem`（npx 启动，Node） |
| 知识库 | `knowledge/` 目录下 9 个 md 文件（JSONPlaceholder users 数据） |

```
src/
├── index.ts              # 入口：装配 + RAG 检索 + 启动（63 行）
├── Agent.ts              # 核心：Agent 循环（116 行）
├── ChatOpenAi.ts         # LLM 封装：流式 + 工具调用组装（90 行）
├── MCPClient.ts          # MCP 客户端封装（58 行）
├── EmdeddingRetrivers.ts # RAG：embedding + 检索（50 行）
├── VectorStore.ts        # 内存向量库 + 余弦相似度（57 行）
└── utils.ts              # 日志美化（13 行）
```

---

## 1. 总体架构

```
                        ┌──────────────────────────────────────────┐
                        │              index.ts (main)              │
                        │  1. 装配 MCP 客户端                       │
                        │  2. retriveContext(prompt) ← RAG 检索     │
                        │  3. new Agent(model, clients, "", context) │
                        │  4. agent.init() → agent.invoke(prompt)   │
                        └───────┬──────────────────────┬───────────┘
                                │                      │
              ┌─────────────────▼───────┐   ┌──────────▼────────────────┐
              │      Agent (核心循环)     │   │   EmbeddingRetrivers      │
              │  toolMap: name→MCPClient │   │  + VectorStore (内存数组)  │
              │  init: allSettled 降级   │   │  embed → addItem → search │
              │  invoke: ≤10 轮工具循环   │   └──────────┬────────────────┘
              └───────┬─────────┬────────┘              │
                      │         │                    fetch
                      │         │           http://localhost:11434/v1/embeddings
                      ▼         ▼                      ▼
        ┌──────────────┐  ┌──────────────┐    ┌─────────────────┐
        │  ChatOpenAI   │  │  MCPClient   │    │ Ollama 服务      │
        │ messages 累积  │  │ stdio 子进程  │    │ gemma4:e4b      │
        │ 流式解析      │  │ listTools    │    │ nomic-embed-text│
        │ toolCalls 组装│  │ callTool     │    └─────────────────┘
        └──────┬───────┘  └──────┬───────┘
               │                 │ spawn (stdio)
               ▼                 ▼
        http://localhost   ┌─────────────────────────────┐
        :11434/v1/chat     │ uvx mcp-server-fetch (Py)   │
        /completions       │ npx server-filesystem (Node)│
                           └─────────────────────────────┘
```

要点：
- **三个进程模型**：主进程（Node）+ 2 个 MCP server 子进程（stdio 通信）+ 1 个 Ollama 常驻服务（HTTP）。
- **RAG 与 Agent 是并列的两条链**：RAG 在 `main` 里先跑完，检索结果作为字符串一次性注入；Agent 循环内不再检索。
- **单一知识流向**：prompt → embedding → 检索 top-3 → context → LLM → 工具调用（fetch/write_file）→ 最终回答 + 落盘。

---

## 2. 一次完整运行的时序

```
main()
 │
 ├─ retriveContext("根据 Kamren 的信息,创作她的故事...")
 │   ├─ 遍历 knowledge/*.md（9 个文件，串行）
 │   │   └─ 每个文件 → POST /v1/embeddings（768 维向量）→ VectorStore.addItem
 │   ├─ prompt → embedQuery → VectorStore.search(topK=3, 余弦相似度)
 │   └─ 返回 top-3 文档拼接的 context 字符串
 │
 ├─ new Agent(model, [fetchMCP, fileMCP], "", context)
 ├─ agent.init()
 │   ├─ Promise.allSettled 并行拉起 2 个 MCP server（失败降级，全败抛错）
 │   ├─ 收集全部工具（fetch 1 个 + filesystem 14 个 = 15 个）
 │   ├─ 构建 toolMap: 工具名 → 所属 MCPClient
 │   └─ new ChatOpenAI(model, systemPrompt="", tools, context)
 │       └─ messages = [user(context)]   ← 注意：context 以 user 角色注入
 │
 └─ agent.invoke(prompt)
     ├─ chat(prompt)          → messages 追加 user(prompt)
     ├─ 流式响应 → 组装 content + toolCalls[]
     ├─ 循环（最多 10 轮）:
     │   ├─ toolCalls 为空 → 返回 content（结束）
     │   └─ 对每个 toolCall:
     │       ├─ toolMap.get(name) 找不到 → appendToolResult("tool not found")
     │       ├─ JSON.parse(arguments || "{}") → mcp.callTool(name, args)
     │       ├─ 异常 → "tool error:..." 作为工具结果回传（不崩会话）
     │       └─ appendToolResult(id, result) → messages 追加 tool 消息
     │       └─ chat() 继续下一轮
     └─ finally → close()（Promise.allSettled 关闭所有 MCP 客户端）
```

实际运行轨迹（以 Kamren 任务为例）：`chat → fetch(users API) → 截断 → write_file(Kamren.md) → 无工具调用 → 返回故事文本`。

---

## 3. 模块拆解

### 3.1 `Agent.ts` — 核心循环（心脏）

**职责**：编排 LLM 与工具的交互循环，是整个项目存在意义所在。

| 成员/方法 | 设计点 |
|---|---|
| `toolMap: Map<string, MCPClient>` | init 时一次构建，invoke 中 O(1) 同步查找，消除运行时异步查询 |
| `init()` 的 `Promise.allSettled` | 部分 server 失败仍降级运行（fetch 挂了不影响 filesystem），全失败才抛错 |
| `invoke()` 的 `MAX_ROUNDS = 10` | 防模型死循环调工具，超限抛错 |
| try/catch 包住单个工具调用 | 工具异常/JSON 非法 → 错误文本回传 LLM 继续对话，而不是崩掉会话 |
| `finally { close() }` | 任何退出路径都释放 MCP 连接（但见 §6 已知问题 #1） |

**这段代码与 Pi agent 的 `agent-loop.ts` 是同构的**：外层 while 对应 Pi 的 outer loop，`for toolCall` 对应 `executeToolCalls()`，`MAX_ROUNDS` 对应 `shouldStopAfterTurn`。

### 3.2 `ChatOpenAi.ts` — LLM 封装

**职责**：消息历史管理 + 流式解析 + OpenAI 格式工具调用协议。

- **流式组装**（41-58 行）：分桶按 `toolCallsChunk.index` 累加 id/name/arguments —— 处理了 OpenAI 流式协议中"一个 tool call 跨多个 chunk、参数字符串分段"的正确姿势。
- **`getToolDefintion()`**：MCP 工具的 `inputSchema` 映射为 OpenAI 的 `parameters` —— 两套工具协议的适配层。
- **`appendToolResult`**：public，供 Agent 回填 `role: "tool"` 消息，与 assistant 的 `tool_call_id` 对齐。
- messages 只增不减（无压缩/裁剪）。

### 3.3 `MCPClient.ts` — MCP 协议封装

- `StdioClientTransport`：以子进程方式拉起 server，stdin/stdout 通信。
- `connectToServer()` 里 `listTools()` 后**裁剪字段**只保留 `{name, description, inputSchema}`。
- 失败时 `throw e` 向上传播，配合 Agent 的 allSettled 形成降级链。

### 3.4 `EmdeddingRetrivers.ts` — RAG 检索

- `embed()`：裸 `fetch` 调 `OPENAI_BASE_URL/embeddings`（与 LLM 共用同一 Ollama 端点）。
- `embedDocument()`：embed + 存入 VectorStore；`retrive()`：query embedding + topK 检索。
- 注意：**无持久化** —— 每次进程启动都要全量重新 embed（见 §6 #3）。

### 3.5 `VectorStore.ts` — 内存向量库

- 纯数组 + `sort` 取 topK，余弦相似度 O(n·d) 暴力扫描。
- `cosineSim()` 附带完整中文注释（点积/模长/归一化的直觉解释）。
- 对当前规模（9 文档 × 768 维）完全够用；万级以上需要换真正的向量库。

### 3.6 `index.ts` — 装配层

- MCP 客户端配置集中在顶部（uvx `--offline` 是为绕开网络拉包失败，属环境适配补丁）。
- `retriveContext` 检索结果以 **user 角色** 消息注入（更常见做法是 system 或拼进 prompt）。

---

## 4. 三大核心机制的本质

**① Agent Loop（ReAct）**
```
while 有工具调用:
    执行所有工具调用 → 结果作为 tool 消息回填 → 再次请求 LLM
```
这就是 2023 年 ReAct 论文定型至今所有 Agent 的内核，包括 Claude Code、TRAE、Pi。本项目的 `invoke()` 是它的最小完整实现。

**② MCP 工具协议**
工具从"写死的函数"升级为"标准协议服务"：工具在 server 端声明 schema，客户端 `listTools` 动态发现。换一个 MCP server = 换一段启动参数，Agent 代码零改动。这是本项目与"教程级 function calling demo"的本质区别。

**③ RAG 语义检索**
`余弦相似度 = dot(v1,v2) / (‖v1‖·‖v2‖)`，衡量向量方向一致性。768 维 embedding 把"Kamren 的故事"这个中文 query 和英文文档 Chelsey Dietrich（Username: Kamren）关联到 top-1 —— 跨语言检索实际生效。

---

## 5. 设计决策与权衡

| 决策 | 收益 | 代价 | 评价 |
|---|---|---|---|
| allSettled 部分失败降级 | 单个 server 挂不炸整个 Agent | 需要处理"成功子集"状态 | 生产思路，正确 |
| toolMap 预构建 | invoke 内 O(1) 查找 | init 稍重 | 正确 |
| 工具错误转结果回传 | 会话不死，模型可自纠 | —— | 与主流实现一致 |
| MAX_ROUNDS=10 | 防死循环 | 复杂任务可能不够 | 小项目合理 |
| 内存数组暴力余弦 | 零依赖、代码透明 | 每次全量重算 + O(n) 检索 | 教程级正确，生产需换 |
| invoke 内 finally close | 不会泄漏连接 | Agent 变一次性（二次 invoke 即废） | 需明确生命周期归属 |
| 本地 Ollama 双模型 | 零 API 成本、数据不出本机 | 小模型工具调用不稳定（实测有幻觉/空响应） | 与目标匹配 |

---

## 6. 已知问题与技术债（按优先级）

1. **双 close**：`Agent.invoke` 的 finally 调 `close()`，`main` 末尾又调 `agent.close()` —— allSettled 使其无害但冗余，且暗示生命周期归属未定（invoke 内 close ⇒ 不支持多轮 invoke）。
2. **两份 `Tool` 类型来源**：`Agent.ts`/`MCPClient.ts` import 自 `@modelcontextprotocol/sdk/spec.types`，`ChatOpenAi.ts` import 自 `@modelcontextprotocol/sdk/types.js` —— 运行时结构兼容所以能跑，但名义上是两个类型，应统一。
3. **无持久化向量库**：每次运行对 9 个文档全量重新 embedding（9 次 HTTP 请求），知识库增长后线性恶化。
4. **`VectorStore.ts` 第 1 行误导入**：`import { dot } from "node:test/reporters"` —— 无用且把测试内部模块拉进依赖图，应删除。
5. **embedding 调试残留**：`embed()` 内 `console.log(data.data[0].embedding)` 每次打印完整 768 维数组。
6. **空 `tool_calls: []`**：纯文本轮也会给 assistant 消息带上空数组（Ollama 宽容，严格实现会拒）。
7. **串行 embed + 循环内 I/O**：for 循环逐个 await，违反"循环内禁 I/O"约束（量小无感，量大需并发分批）。
8. **`method: "post"` 小写**：fetch 规范容忍，应统一 `"POST"`。
9. **拼写债**（不影响运行，影响可读性）：文件名 `EmdeddingRetrivers.ts`、`ChatOpenAi.ts`；标识符 `vectorStroe`、`retrive`、`getToolDefintion`、`magnitud1/2`、MCP 客户端名 `"flie"`。
10. **`utils.ts` 的 `hello()`**：死代码。

---

## 7. 演进路线（对照生产级 Agent）

```
当前(447 行, 已完成)          →  下一步
─────────────────────────────────────────────────────
循环内核    ✅ 已手写           读 Pi 的 agent-loop.ts 对照精读
工具协议    ✅ MCP              工具收敛: 4 个精心设计的 > 15 个平铺
RAG        ✅ 可用但无持久化     ① 向量落盘(JSON/sqlite) + 增量 embed
会话        ✅ 单次              ② close 移出 invoke,支持多轮续聊
上下文      ⚠️ messages 只增     ③ 超过 N 轮压缩/裁剪历史
安全        ⚠️ 依赖 server 侧   ④ 写操作 approval 确认
观测        ⚠️ console.log      ⑤ 每步决策 + token 计量落日志
```

最小改动收益最大的是 **①向量持久化**（消全量 re-embed）和 **②close 归属调整**（解锁多轮会话）。

---

## 附：本项目验证过的完整故障排查史（环境层，与代码无关）

- MCP server 包名拼写 404（`filesysem`→`filesystem`）
- uvx 首次运行需联网拉 pypi 包（离线 + 缓存组合的取舍）
- 本地回环 `EADDRNOTAVAIL`（VPN/TUN 掉线导致，`ifconfig lo0 down/up` 恢复）
- fetch 5000 字符截断 → 需模型用 `start_index` 续抓（依赖工具 schema 传参到位）
- 小模型（gemma4:e4b）的工具调用不稳定：幻觉补数据、`<|tool_call|>` 乱码、偶发空响应

这份记录说明：**代码链路的每一个环节都被真实运行验证过**。
