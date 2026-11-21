/**
 * 分析阶段：把分析端口的输出收敛成三种状态。
 *
 * 这里刻意不返回 UsageResult，而是返回带语义的状态：
 * 「没跑出结果」和「跑出结果但没引用」是两件事，前者必须转人工。
 */
import type { Analyzer } from "./analyzer.js";
import type { UsageResult } from "./usage.js";

export type AnalysisStatus =
  | { kind: "ok"; usage: UsageResult }
  | { kind: "missing" }
  | { kind: "max_rounds" };

export async function runAnalysis(
  analyzer: Analyzer,
  repoPath: string,
  packageName: string,
  maxRounds: number
): Promise<AnalysisStatus> {
  const outcome = await analyzer.analyze(repoPath, packageName);
  if (outcome === null) return { kind: "missing" };
  if (outcome.rounds > maxRounds) return { kind: "max_rounds" };
  return { kind: "ok", usage: outcome.usage };
}
