/**
 * 调查编排：只处理 NEED_MANUAL 条目，产出建议结论。
 *
 * 为什么不让 Agent 直接改决策表：
 *   1. NEED_MANUAL 的含义就是「自动流程不可信」，模型同样不可信，只能给建议；
 *   2. 建议与最终结论分离后，人工复核有明确输入，审计链完整；
 *   3. 确定性链路保持可测试，Agent 出错不影响主流程。
 */
import { ADVISORY_FUNCTIONS } from "../triage/advisory-functions.js";
import type { TriageResult, VulnerabilityDecisionRow } from "../triage/types.js";
import { REASON_CODES } from "../triage/types.js";
import { runAgentLoop } from "./loop.js";
import { createInvestigationTools, type InvestigationToolContext } from "./tools.js";
import type { ChatModel, InvestigationReport, Tool } from "./types.js";

const SYSTEM_PROMPT = [
  "你是依赖漏洞分诊助手，只负责调查自动流程无法判定的条目。",
  "你可以使用只读工具查看源码、使用面分析与冻结的漏洞数据。",
  "判定口径：只有「确实引用并调用了受影响函数」才算 AFFECTED；仅声明依赖或未调用必须判 NOT_AFFECTED；",
  "遇到无法静态解析的动态引入或证据不足，必须判 NEED_MANUAL，禁止猜测。",
  "调查结束后只输出一个 JSON 对象，不要输出解释性文字或 Markdown 代码块。",
].join("");

const OUTPUT_FORMAT = [
  "输出格式（严格遵守，只输出这一段 JSON）：",
  '{"decision":"AFFECTED|NOT_AFFECTED|NEED_MANUAL","reason":"<原因码>","evidence":["<证据1>","<证据2>"]}',
  `reason 必须取自：${REASON_CODES.join(", ")}。`,
  "evidence 至少一条，写明文件与行号或版本比较依据。",
].join("\n");

/** 从模型输出中抠出 JSON 对象。允许前后有噪声，但要求字段合法。 */
export function parseSuggestion(
  content: string
): { decision: "AFFECTED" | "NOT_AFFECTED" | "NEED_MANUAL"; reason: string; evidence: string[] } | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const decision = record.decision;
  if (decision !== "AFFECTED" && decision !== "NOT_AFFECTED" && decision !== "NEED_MANUAL") {
    return null;
  }

  const reason = typeof record.reason === "string" ? record.reason : "";
  if (!(REASON_CODES as readonly string[]).includes(reason)) return null;

  const evidence = Array.isArray(record.evidence)
    ? record.evidence.filter((item): item is string => typeof item === "string")
    : [];
  if (evidence.length === 0) return null;

  return { decision, reason, evidence };
}

function buildPrompt(row: VulnerabilityDecisionRow): string {
  return [
    `漏洞 ${row.cveId} 影响包 ${row.package}，已安装版本 ${row.installedVersion}。`,
    `自动流程无法判定，原因码：${row.reason ?? "UNKNOWN"}。`,
    "请用工具调查这个仓库是否真的调用了受影响函数，再给出结论。",
    "",
    OUTPUT_FORMAT,
  ].join("\n");
}

export interface InvestigateOptions {
  model: ChatModel;
  repoPath: string;
  snapshot: unknown;
  maxRounds: number;
  /** 可注入工具，默认按仓库构造只读工具集。 */
  tools?: Tool[];
  advisoryFunctions?: InvestigationToolContext["advisoryFunctions"];
}

/** 调查一次分诊结果中所有 NEED_MANUAL 条目。 */
export async function investigateNeedsManual(
  result: TriageResult,
  options: InvestigateOptions
): Promise<InvestigationReport[]> {
  const targets = result.decisions.filter((row) => row.decision === "NEED_MANUAL");
  if (targets.length === 0) return [];

  const tools =
    options.tools ??
    createInvestigationTools({
      repoPath: options.repoPath,
      snapshot: options.snapshot,
      advisoryFunctions: options.advisoryFunctions ?? ADVISORY_FUNCTIONS,
    });

  const reports: InvestigationReport[] = [];
  for (const row of targets) {
    const loop = await runAgentLoop(buildPrompt(row), {
      model: options.model,
      tools,
      maxRounds: options.maxRounds,
      systemPrompt: SYSTEM_PROMPT,
    });

    // 轮次耗尽是系统层失败，优先于模型输出
    if (loop.stoppedBy === "max_rounds") {
      reports.push({
        cveId: row.cveId,
        package: row.package,
        suggestedDecision: "NEED_MANUAL",
        reason: "MAX_ROUNDS_EXCEEDED",
        evidence: [`调查达到 ${loop.rounds} 轮上限仍未收敛`],
        rounds: loop.rounds,
        stoppedBy: "max_rounds",
      });
      continue;
    }

    const suggestion = parseSuggestion(loop.finalContent);
    if (!suggestion) {
      // 输出不可解析时不得给出任何业务结论
      reports.push({
        cveId: row.cveId,
        package: row.package,
        suggestedDecision: "NEED_MANUAL",
        reason: "EVIDENCE_MISSING",
        evidence: [loop.finalContent.slice(0, 200) || "(模型无输出)"],
        rounds: loop.rounds,
        stoppedBy: "unparseable",
      });
      continue;
    }

    reports.push({
      cveId: row.cveId,
      package: row.package,
      suggestedDecision: suggestion.decision,
      reason: suggestion.reason as InvestigationReport["reason"],
      evidence: suggestion.evidence,
      rounds: loop.rounds,
      stoppedBy: "final",
    });
  }

  return reports;
}
