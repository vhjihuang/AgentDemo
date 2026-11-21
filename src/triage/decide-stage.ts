/**
 * 判定阶段：纯函数，不读盘、不写库、不发网络请求。
 *
 * 判定顺序即风险优先级：
 *   分析未完成 > 动态引入不可解析 > 未引用 > 调用了受影响函数 > 引用了但没调用
 * 前三种都不能产出 AFFECTED，也都不允许被误判成 NOT_AFFECTED。
 */
import type { AnalysisStatus } from "./analyze-stage.js";
import type { AdvisoryMatch } from "./osv.js";
import type { VulnerabilityDecisionRow } from "./types.js";

export function decide(
  advisory: AdvisoryMatch,
  analysis: AnalysisStatus,
  packageName: string,
  installedVersion: string
): VulnerabilityDecisionRow {
  const base: VulnerabilityDecisionRow = {
    cveId: advisory.advisoryId,
    package: packageName,
    installedVersion,
    decision: null,
    executionStatus: "SUCCEEDED",
    deferReason: null,
    reason: null,
    evidence: null,
    retryCount: 0,
    lastError: null,
    manuallyOverridden: false,
    priorityScore: 0,
  };

  if (analysis.kind === "max_rounds") {
    return { ...base, decision: "NEED_MANUAL", reason: "MAX_ROUNDS_EXCEEDED" };
  }

  if (analysis.kind === "missing") {
    return { ...base, decision: "NEED_MANUAL", reason: "EVIDENCE_MISSING" };
  }

  const { usage } = analysis;

  // 存在不可解析的动态引入时，任何「未调用」的判断都不可信，必须升级人工
  if (usage.dynamicImport) {
    return { ...base, decision: "NEED_MANUAL", reason: "DYN_IMPORT_UNRESOLVABLE" };
  }

  if (!usage.importsPackage) {
    return { ...base, decision: "NOT_AFFECTED", reason: "NOT_CALLED" };
  }

  const callSite = usage.callSites.find((site) =>
    advisory.affectedFunctions.includes(site.symbol)
  );
  if (callSite) {
    return {
      ...base,
      decision: "AFFECTED",
      reason: "CALLED",
      evidence: {
        callSites: [callSite],
        versionCheck: {
          installed: installedVersion,
          introduced: advisory.range.introduced,
          fixed: advisory.range.fixed,
        },
      },
    };
  }

  return { ...base, decision: "NOT_AFFECTED", reason: "NOT_CALLED" };
}
