/**
 * 调用面分析端口。
 *
 * 把「代码检查」抽成可替换端口，是因为它存在两种与判定无关的失败：
 *   - 检查不出结果（null）：不能据此推断「未调用」，必须转人工
 *   - 分析轮次失控（rounds 超限）：必须终止，不能挂起
 * 这两种失败都不能被误当成业务结论。
 */
import { analyzeUsage, type UsageResult } from "./usage.js";

export interface AnalysisOutcome {
  usage: UsageResult;
  /** 本次分析消耗的轮次。超过 MAX_ROUNDS 时上层必须终止并转人工。 */
  rounds: number;
}

export interface Analyzer {
  /** 返回 null 表示未能产出可验证结果，上层不得据此判定为「未调用」。 */
  analyze(repoPath: string, packageName: string): Promise<AnalysisOutcome | null>;
}

/** 默认实现：单轮静态分析。 */
export function createDefaultAnalyzer(): Analyzer {
  return {
    async analyze(repoPath, packageName) {
      return { usage: analyzeUsage(repoPath, packageName), rounds: 1 };
    },
  };
}
