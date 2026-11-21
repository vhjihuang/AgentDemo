/**
 * Agent 调查层用例。
 *
 * 重点验证三件事：循环有界、工具错误不会炸会话、不可解析的输出绝不产出业务结论。
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createInvestigationTools,
  investigateNeedsManual,
  parseSuggestion,
  runAgentLoop,
} from "../../src/agent/index.js";
import type { ChatModel, Tool, ToolCall } from "../../src/agent/types.js";
import { ADVISORY_FUNCTIONS } from "../../src/triage/advisory-functions.js";
import type { TriageResult, VulnerabilityDecisionRow } from "../../src/triage/types.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** 按预设脚本逐步返回的模型，用于让循环行为完全确定。 */
function scriptedModel(steps: Array<{ content?: string; toolCalls?: ToolCall[] }>): ChatModel {
  let index = 0;
  return {
    async complete() {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return { content: step.content ?? "", toolCalls: step.toolCalls ?? [] };
    },
  };
}

function echoTool(): Tool {
  return {
    definition: { name: "echo", description: "回显文本", parameters: { type: "object" } },
    async execute(args) {
      return String(args.text ?? "");
    },
  };
}

function baseRow(overrides: Partial<VulnerabilityDecisionRow> & { cveId: string }): VulnerabilityDecisionRow {
  return {
    package: "lodash",
    installedVersion: "4.17.20",
    decision: null,
    executionStatus: "SUCCEEDED",
    deferReason: null,
    reason: null,
    evidence: null,
    retryCount: 0,
    lastError: null,
    manuallyOverridden: false,
    priorityScore: 0,
    ...overrides,
  };
}

describe("Agent 循环", () => {
  test("调用工具后拿到结果并给出最终答复", async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: "1", name: "echo", arguments: '{"text":"hi"}' }] },
      { content: "done" },
    ]);

    const result = await runAgentLoop("测试", {
      model,
      tools: [echoTool()],
      maxRounds: 3,
      systemPrompt: "sys",
    });

    expect(result.stoppedBy).toBe("final");
    expect(result.finalContent).toBe("done");
    expect(result.rounds).toBe(2);
    expect(result.messages.some((m) => m.role === "tool" && m.content === "hi")).toBe(true);
  });

  test("工具不存在、参数非法、工具抛错都转成文本回传，不中断会话", async () => {
    const thrower: Tool = {
      definition: { name: "boom", description: "总是失败", parameters: { type: "object" } },
      async execute() {
        throw new Error("权限不足");
      },
    };

    const model = scriptedModel([
      { toolCalls: [{ id: "1", name: "nope", arguments: "{}" }] },
      { toolCalls: [{ id: "2", name: "echo", arguments: "{bad json" }] },
      { toolCalls: [{ id: "3", name: "boom", arguments: "{}" }] },
      { content: "收尾" },
    ]);

    const result = await runAgentLoop("测试", {
      model,
      tools: [echoTool(), thrower],
      maxRounds: 5,
      systemPrompt: "sys",
    });

    const toolOutputs = result.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(toolOutputs[0]).toContain("tool not found");
    expect(toolOutputs[1]).toContain("invalid arguments");
    expect(toolOutputs[2]).toContain("tool error");
    expect(result.stoppedBy).toBe("final");
  });

  test("达到 MAX_ROUNDS 立即终止，不挂起", async () => {
    const model = scriptedModel([{ toolCalls: [{ id: "1", name: "echo", arguments: "{}" }] }]);

    const result = await runAgentLoop("测试", {
      model,
      tools: [echoTool()],
      maxRounds: 3,
      systemPrompt: "sys",
    });

    expect(result.stoppedBy).toBe("max_rounds");
    expect(result.rounds).toBe(3);
  });
});

describe("调查工具", () => {
  const tools = createInvestigationTools({
    repoPath: join(FIXTURES, "repos", "repo-A"),
    snapshot: {},
    advisoryFunctions: ADVISORY_FUNCTIONS,
  });
  const readSource = tools.find((tool) => tool.definition.name === "read_source")!;

  test("读取源码返回带行号内容", async () => {
    const output = await readSource.execute({ path: "src/notify.js", startLine: 1, endLine: 5 });
    expect(output).toMatch(/^\d+\t/);
  });

  test("路径越界被拒绝", async () => {
    await expect(readSource.execute({ path: "../../etc/passwd" })).rejects.toThrow("路径越界");
  });

  test("漏洞查询失败时返回显式错误，不伪装成空结果", async () => {
    const listAdvisories = tools.find((tool) => tool.definition.name === "list_advisories")!;
    const output = await listAdvisories.execute({ package: "lodash", version: "4.17.20" });
    expect(output).toContain("advisory query failed");
  });
});

describe("NEED_MANUAL 调查编排", () => {
  test("只调查 NEED_MANUAL 条目并解析出建议结论", async () => {
    const result: TriageResult = {
      decisions: [
        baseRow({
          cveId: "GHSA-r5fr-rjxr-66jc",
          decision: "NEED_MANUAL",
          reason: "DYN_IMPORT_UNRESOLVABLE",
        }),
        baseRow({ cveId: "GHSA-35jh-r3h4-6jhm", decision: "AFFECTED", reason: "CALLED" }),
      ],
      tickets: [],
      log: [],
    };

    const model = scriptedModel([
      {
        content:
          '{"decision":"NEED_MANUAL","reason":"DYN_IMPORT_UNRESOLVABLE","evidence":["src/notify.js 使用变量动态 import"]}',
      },
    ]);

    const reports = await investigateNeedsManual(result, {
      model,
      repoPath: join(FIXTURES, "repos", "repo-D"),
      snapshot: {},
      maxRounds: 3,
      tools: [],
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].cveId).toBe("GHSA-r5fr-rjxr-66jc");
    expect(reports[0].suggestedDecision).toBe("NEED_MANUAL");
    expect(reports[0].stoppedBy).toBe("final");
    expect(reports[0].evidence).toHaveLength(1);
  });

  test("输出不可解析 → NEED_MANUAL/EVIDENCE_MISSING，禁止猜结论", async () => {
    const result: TriageResult = {
      decisions: [
        baseRow({ cveId: "GHSA-x", decision: "NEED_MANUAL", reason: "EVIDENCE_MISSING" }),
      ],
      tickets: [],
      log: [],
    };

    const reports = await investigateNeedsManual(result, {
      model: scriptedModel([{ content: "我认为大概可能影响" }]),
      repoPath: join(FIXTURES, "repos", "repo-A"),
      snapshot: {},
      maxRounds: 3,
      tools: [],
    });

    expect(reports[0].suggestedDecision).toBe("NEED_MANUAL");
    expect(reports[0].reason).toBe("EVIDENCE_MISSING");
    expect(reports[0].stoppedBy).toBe("unparseable");
  });

  test("轮次耗尽 → NEED_MANUAL/MAX_ROUNDS_EXCEEDED", async () => {
    const result: TriageResult = {
      decisions: [
        baseRow({ cveId: "GHSA-x", decision: "NEED_MANUAL", reason: "EVIDENCE_MISSING" }),
      ],
      tickets: [],
      log: [],
    };

    const reports = await investigateNeedsManual(result, {
      model: scriptedModel([
        { toolCalls: [{ id: "1", name: "list_source_files", arguments: "{}" }] },
      ]),
      repoPath: join(FIXTURES, "repos", "repo-A"),
      snapshot: {},
      maxRounds: 2,
      tools: createInvestigationTools({
        repoPath: join(FIXTURES, "repos", "repo-A"),
        snapshot: {},
        advisoryFunctions: ADVISORY_FUNCTIONS,
      }),
    });

    expect(reports[0].reason).toBe("MAX_ROUNDS_EXCEEDED");
    expect(reports[0].stoppedBy).toBe("max_rounds");
  });

  test("解析器拒绝枚举外原因码与空证据", () => {
    expect(parseSuggestion('{"decision":"AFFECTED","reason":"WHATEVER","evidence":["x"]}')).toBeNull();
    expect(parseSuggestion('{"decision":"AFFECTED","reason":"CALLED","evidence":[]}')).toBeNull();
    expect(parseSuggestion("not json")).toBeNull();
  });
});
