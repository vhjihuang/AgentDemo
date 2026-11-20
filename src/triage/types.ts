/**
 * 分诊系统的对外契约。
 *
 * decision 与 executionStatus 是两个正交维度：
 *   - decision 回答「业务上判出来了吗」
 *   - executionStatus 回答「系统执行到哪一步」
 * 合并成一个枚举会导致系统故障与业务不确定无法区分。
 */

/** 业务结论。null 表示尚未得出结论（执行未完成或已失败）。 */
export type Decision = "AFFECTED" | "NOT_AFFECTED" | "NEED_MANUAL" | null;

/** 系统执行状态，与业务结论正交。 */
export type ExecutionStatus =
  | "PENDING"
  | "RUNNING"
  | "RETRYING"
  | "SUCCEEDED"
  | "FAILED_PERMANENT";

/** 尚未开始执行的排队原因。仅当 executionStatus = PENDING 时允许非空。 */
export type DeferReason = "RATE_LIMIT" | "BACKLOG" | null;

/** 结论原因码。NEED_MANUAL 必须带非空的 ReasonCode。 */
export type ReasonCode =
  | "CALLED"
  | "NOT_CALLED"
  | "VERSION_NOT_AFFECTED"
  | "DYN_IMPORT_UNRESOLVABLE"
  | "EVIDENCE_MISSING"
  | "SOURCE_UNAVAILABLE"
  | "MAX_ROUNDS_EXCEEDED"
  | "FIX_VERSION_BREAKING"
  | "PACKAGE_DEPRECATED"
  | "RATE_LIMIT";

/** 证据链。 */
export interface Evidence {
  /** 命中的源码位置，例如 src/notify.js:12 */
  callSites: Array<{ file: string; line: number; symbol: string }>;
  /** 版本比较过程，便于回溯判定依据。 */
  versionCheck: { installed: string; introduced: string; fixed: string | null };
}

/** 单条决策记录，对应 vulnerability_decisions 表。 */
export interface VulnerabilityDecisionRow {
  /** OSV advisory 标识（GHSA 或 CVE）。 */
  cveId: string;
  package: string;
  installedVersion: string;
  decision: Decision;
  executionStatus: ExecutionStatus;
  deferReason: DeferReason;
  /** 结论原因码，decision 非 null 时必须非空。 */
  reason: ReasonCode | null;
  /** 证据链：命中的文件、行号、版本比较过程。AFFECTED 时必须非空。 */
  evidence: Evidence | null;
  retryCount: number;
  lastError: string | null;
  /** 人工覆盖后为 true，自动流程不得改写该行。 */
  manuallyOverridden: boolean;
  priorityScore: number;
}

/** 工单记录，对应 tickets 表。 */
export interface TicketRow {
  id: string;
  cveId: string;
  package: string;
  fixVersion: string | null;
  status: "open" | "closed";
  runId: string;
}

/** 事件流记录，对应 decision_log 表。 */
export interface DecisionLogRow {
  runId: string;
  cveId: string;
  event: "osv_query" | "code_check" | "decision" | "ticket_create_failed";
  seq: number;
}

/** 一次分诊运行的输入。 */
export interface TriageInput {
  repoPath: string;
  /** 冻结的 OSV 查询结果，测试期不得实时请求外部 API。 */
  osvSnapshot: unknown;
}

/** 消费端看到的判定结果。 */
export interface TriageResult {
  decisions: VulnerabilityDecisionRow[];
  tickets: TicketRow[];
  log: DecisionLogRow[];
}
