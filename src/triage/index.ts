/**
 * 漏洞影响面分诊模块的对外入口。
 *
 * 能力边界：usage-based filtering（使用面过滤），不是可达性分析。
 * 详见 tests/SPEC.md 的「能力声明」章节。
 */
export { triage, type TriageDependencies } from "./engine.js";
export { analyzeUsage } from "./usage.js";
export type { CallSite, UsageResult } from "./usage.js";
export { matchAdvisories, type AdvisoryFunctionIndex } from "./osv.js";
export { compareVersions, isVersionAffected, parseVersion, type AffectedRange } from "./version.js";
export { REASON_CODES } from "./types.js";

export { RetryExhaustedError, withRetry } from "./retry.js";
export {
  createInMemoryTicketSink,
  createNoopAlertSink,
  createRetryPolicy,
  createSnapshotOsvSource,
} from "./ports.js";
export type {
  AlertKind,
  AlertPayload,
  AlertSink,
  OsvSource,
  RetryPolicy,
  TicketDraft,
  TicketSink,
} from "./ports.js";

export {
  ConfigError,
  createDefaultConfig,
  loadConfig,
  REQUIRED_CONFIG_KEYS,
} from "./config.js";
export type { RequiredConfigKey, TriageConfig } from "./config.js";

export { createDefaultAnalyzer } from "./analyzer.js";
export type { AnalysisOutcome, Analyzer } from "./analyzer.js";

export { createInMemoryStore } from "./store.js";
export type { InMemoryStoreOptions, StoredDecisionRow, TriageStore } from "./store.js";

export {
  CircuitOpenError,
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
} from "./circuit-breaker.js";

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
