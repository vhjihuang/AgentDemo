/**
 * 漏洞影响面分诊模块的对外入口。
 *
 * 能力边界：usage-based filtering（使用面过滤），不是可达性分析。
 * 详见 tests/SPEC.md 的「能力声明」章节。
 */
export { triage } from "./engine.js";
export { analyzeUsage } from "./usage.js";
export { matchAdvisories } from "./osv.js";
export { compareVersions, isVersionAffected, parseVersion } from "./version.js";
export { REASON_CODES } from "./types.js";
export type {
  Decision,
  DecisionLogRow,
  DeferReason,
  Evidence,
  ExecutionStatus,
  ReasonCode,
  TicketRow,
  TriageInput,
  TriageResult,
  VulnerabilityDecisionRow,
} from "./types.js";
