/**
 * 分诊编排：把五个阶段串成一次运行。
 *
 * 本文件只负责顺序与错误边界，不含判定逻辑、不含存储实现、不含建单细节。
 * 各阶段的归属：
 *   lockfile.ts   读依赖
 *   analyze-stage 代码检查（含缺失/超轮次）
 *   decide-stage  纯判定
 *   persist-stage 跨运行幂等与崩溃恢复
 *   emit-stage    建单、配额、告警
 *
 * 外部依赖全部通过 ports / store / analyzer 注入，测试据此做故障注入。
 */
import { ADVISORY_FUNCTIONS } from "./advisory-functions.js";
import { createDefaultAnalyzer, type Analyzer } from "./analyzer.js";
import { runAnalysis } from "./analyze-stage.js";
import { createDefaultConfig, type TriageConfig } from "./config.js";
import { decide } from "./decide-stage.js";
import { emitDecision } from "./emit-stage.js";
import { readInstalledPackages, type InstalledPackage } from "./lockfile.js";
import type { AdvisoryMatch } from "./osv.js";
import { precheckDecision, reclaimStaleRunning } from "./persist-stage.js";
import {
  createCircuitBreaker,
  type CircuitBreaker,
} from "./circuit-breaker.js";
import {
  createInMemoryTicketSink,
  createNoopAlertSink,
  createRetryPolicy,
  createSnapshotOsvSource,
  type AlertSink,
  type OsvSource,
  type RetryPolicy,
  type TicketSink,
} from "./ports.js";
import { RetryExhaustedError, withRetry } from "./retry.js";
import { createInMemoryStore, type TriageStore } from "./store.js";
import type {
  DecisionLogRow,
  TriageInput,
  TriageResult,
  TicketRow,
  VulnerabilityDecisionRow,
} from "./types.js";

/** 可替换的依赖集合。测试通过它注入故障与时钟。 */
export interface TriageDependencies {
  osvSource?: OsvSource;
  ticketSink?: TicketSink;
  alertSink?: AlertSink;
  retry?: RetryPolicy;
  store?: TriageStore;
  analyzer?: Analyzer;
  config?: TriageConfig;
  /** 默认按数据源整体共享一个实例；注入用于测试。 */
  circuitBreaker?: CircuitBreaker;
  runId?: string;
  now?: () => number;
}

/** 包级 OSV 查询失败时使用的占位标识，与 package 组合构成唯一键。 */
const OSV_FAILURE_ID = "OSV_QUERY_FAILED";

/** 构造包级查询失败记录。decision 必须为 null，禁止冒充任何业务结论。 */
function createOsvFailureRow(
  installed: InstalledPackage,
  error: RetryExhaustedError
): VulnerabilityDecisionRow {
  return {
    cveId: OSV_FAILURE_ID,
    package: installed.name,
    installedVersion: installed.version,
    decision: null,
    executionStatus: "FAILED_PERMANENT",
    deferReason: null,
    reason: "SOURCE_UNAVAILABLE",
    evidence: null,
    // 失败次数 = 总尝试次数 - 1
    retryCount: Math.max(0, error.attempts - 1),
    lastError: error.message,
    manuallyOverridden: false,
    priorityScore: 0,
  };
}

/** 执行一次分诊，产出决策、工单与事件流。 */
export async function triage(
  input: TriageInput,
  overrides: TriageDependencies = {}
): Promise<TriageResult> {
  const now = overrides.now ?? (() => Date.now());
  const config = overrides.config ?? createDefaultConfig();
  const runId = overrides.runId ?? `run-${now()}`;
  const store = overrides.store ?? createInMemoryStore({ now });
  const analyzer = overrides.analyzer ?? createDefaultAnalyzer();
  const osvSource =
    overrides.osvSource ?? createSnapshotOsvSource(input.osvSnapshot, ADVISORY_FUNCTIONS);
  const ticketSink = overrides.ticketSink ?? createInMemoryTicketSink();
  const alertSink = overrides.alertSink ?? createNoopAlertSink();
  const retry =
    overrides.retry ??
    createRetryPolicy({ maxAttempts: config.retryMax, baseDelayMs: config.retryBaseMs });
  // 熔断在外、重试在内：熔断打开后不再被重试层白打
  const circuitBreaker =
    overrides.circuitBreaker ??
    createCircuitBreaker({
      threshold: config.circuitBreakerThreshold,
      resetTimeoutMs: config.circuitBreakerResetMs,
      now,
    });

  // 上次运行崩溃遗留的 RUNNING 记录先回收，否则会永久卡死
  await reclaimStaleRunning(store, now(), config.runningTimeoutMs);

  const decisions: VulnerabilityDecisionRow[] = [];
  const tickets: TicketRow[] = [];
  const log: DecisionLogRow[] = [];
  let seq = 0;

  const appendLog = async (cveId: string, event: DecisionLogRow["event"]): Promise<void> => {
    seq += 1;
    const entry: DecisionLogRow = { runId, cveId, event, seq };
    log.push(entry);
    await store.appendLog(entry);
  };

  for (const installed of readInstalledPackages(input.repoPath)) {
    let advisories: AdvisoryMatch[];
    let osvAttempts: number;

    try {
      const outcome = await circuitBreaker.execute(() =>
        withRetry(() => osvSource.query(installed.name, installed.version), retry)
      );
      advisories = outcome.value;
      osvAttempts = outcome.attempts;
    } catch (error) {
      const exhausted =
        error instanceof RetryExhaustedError
          ? error
          : new RetryExhaustedError(retry.maxAttempts, error);
      const row = createOsvFailureRow(installed, exhausted);
      await store.saveDecision(row);
      decisions.push(row);
      await alertSink.notify({
        kind: "osv_failure",
        package: installed.name,
        cveId: null,
        message: row.lastError ?? "OSV 查询失败",
      });
      continue;
    }

    const analysis = await runAnalysis(analyzer, input.repoPath, installed.name, config.maxRounds);

    for (const advisory of advisories) {
      await appendLog(advisory.advisoryId, "osv_query");
      await appendLog(advisory.advisoryId, "code_check");

      const computed: VulnerabilityDecisionRow = {
        ...decide(advisory, analysis, installed.name, installed.version),
        retryCount: osvAttempts - 1,
      };

      const precheck = await precheckDecision(store, computed);
      if (precheck.action === "skip") {
        decisions.push(precheck.row);
        await appendLog(advisory.advisoryId, "decision");
        continue;
      }

      const emitted = await emitDecision(
        { store, ticketSink, alertSink, retry, maxOpenTickets: config.maxOpenTickets },
        runId,
        computed,
        advisory.range.fixed
      );
      const saved = await store.saveDecision(emitted.row);

      for (const event of emitted.events) await appendLog(advisory.advisoryId, event);
      if (emitted.ticket) tickets.push(emitted.ticket);
      decisions.push(saved);
      await appendLog(advisory.advisoryId, "decision");
    }
  }

  return { decisions, tickets, log };
}
