/**
 * 决策引擎：把 lockfile、OSV 源、静态调用面三路信息合成最终结论。
 *
 * 外部依赖通过 ports 注入，默认实现基于冻结快照与内存工单。
 * 重试只处理「可恢复的外部调用失败」，不掩盖业务判定错误。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADVISORY_FUNCTIONS } from "./advisory-functions.js";
import type { AdvisoryMatch } from "./osv.js";
import {
  createDefaultRetryPolicy,
  createInMemoryTicketSink,
  createNoopAlertSink,
  createSnapshotOsvSource,
  type AlertSink,
  type OsvSource,
  type RetryPolicy,
  type TicketSink,
} from "./ports.js";
import { RetryExhaustedError, withRetry } from "./retry.js";
import { analyzeUsage, type UsageResult } from "./usage.js";
import type {
  DecisionLogRow,
  TriageInput,
  TriageResult,
  TicketRow,
  VulnerabilityDecisionRow,
} from "./types.js";

/** 可替换的依赖集合。测试通过它注入故障。 */
export interface TriageDependencies {
  osvSource?: OsvSource;
  ticketSink?: TicketSink;
  alertSink?: AlertSink;
  retry?: RetryPolicy;
  runId?: string;
}

interface LockfileShape {
  packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

interface InstalledPackage {
  name: string;
  version: string;
}

/** 包级 OSV 查询失败时使用的占位标识，与 package 组合构成唯一键。 */
const OSV_FAILURE_ID = "OSV_QUERY_FAILED";

/** 从 package-lock.json 读取根依赖及其已安装版本。 */
function readInstalledPackages(repoPath: string): InstalledPackage[] {
  const lockPath = join(repoPath, "package-lock.json");
  let parsed: LockfileShape;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockfileShape;
  } catch (error) {
    throw new Error(`无法读取 lockfile: path=${lockPath}, cause=${(error as Error).message}`);
  }

  const rootDependencies = parsed.packages?.[""]?.dependencies;
  if (!rootDependencies) return [];

  const installed: InstalledPackage[] = [];
  for (const name of Object.keys(rootDependencies)) {
    const entry = parsed.packages?.[`node_modules/${name}`];
    if (!entry?.version) {
      throw new Error(`lockfile 缺少已安装版本: package=${name}, path=${lockPath}`);
    }
    installed.push({ name, version: entry.version });
  }
  return installed;
}

/** 对单条漏洞给出结论。判定顺序即风险优先级，不可随意调换。 */
function decide(
  advisory: AdvisoryMatch,
  usage: UsageResult,
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
  const runId = overrides.runId ?? `run-${Date.now()}`;
  const osvSource =
    overrides.osvSource ?? createSnapshotOsvSource(input.osvSnapshot, ADVISORY_FUNCTIONS);
  const ticketSink = overrides.ticketSink ?? createInMemoryTicketSink();
  const alertSink = overrides.alertSink ?? createNoopAlertSink();
  const retry = overrides.retry ?? createDefaultRetryPolicy();

  const decisions: VulnerabilityDecisionRow[] = [];
  const tickets: TicketRow[] = [];
  const log: DecisionLogRow[] = [];
  let seq = 0;

  for (const installed of readInstalledPackages(input.repoPath)) {
    let advisories: AdvisoryMatch[];
    let osvAttempts: number;
    try {
      const outcome = await withRetry(
        () => osvSource.query(installed.name, installed.version),
        retry
      );
      advisories = outcome.value;
      osvAttempts = outcome.attempts;
    } catch (error) {
      const exhausted =
        error instanceof RetryExhaustedError
          ? error
          : new RetryExhaustedError(retry.maxAttempts, error);
      const row = createOsvFailureRow(installed, exhausted);
      decisions.push(row);
      await alertSink.notify({
        kind: "osv_failure",
        package: installed.name,
        cveId: null,
        message: row.lastError ?? "OSV 查询失败",
      });
      continue;
    }

    const osvRetryCount = osvAttempts - 1;
    const usage = analyzeUsage(input.repoPath, installed.name);

    for (const advisory of advisories) {
      log.push({ runId, cveId: advisory.advisoryId, event: "osv_query", seq: ++seq });
      log.push({ runId, cveId: advisory.advisoryId, event: "code_check", seq: ++seq });

      const row = decide(advisory, usage, installed.name, installed.version);
      row.retryCount = osvRetryCount;

      if (row.decision === "AFFECTED" && row.executionStatus === "SUCCEEDED") {
        try {
          const created = await withRetry(
            () =>
              ticketSink.create({
                cveId: advisory.advisoryId,
                package: installed.name,
                fixVersion: advisory.range.fixed,
              }),
            retry
          );
          row.retryCount += created.attempts - 1;
          tickets.push({
            id: created.value.id,
            cveId: advisory.advisoryId,
            package: installed.name,
            fixVersion: advisory.range.fixed,
            status: "open",
            runId,
          });
        } catch (error) {
          const exhausted =
            error instanceof RetryExhaustedError
              ? error
              : new RetryExhaustedError(retry.maxAttempts, error);
          // 建单失败时不得停留在完成态，也不得伪造工单
          row.executionStatus = "FAILED_PERMANENT";
          row.retryCount += Math.max(0, exhausted.attempts - 1);
          row.lastError = exhausted.message;
          log.push({
            runId,
            cveId: advisory.advisoryId,
            event: "ticket_create_failed",
            seq: ++seq,
          });
          await alertSink.notify({
            kind: "ticket_failure",
            package: installed.name,
            cveId: advisory.advisoryId,
            message: exhausted.message,
          });
        }
      }

      decisions.push(row);
      log.push({ runId, cveId: advisory.advisoryId, event: "decision", seq: ++seq });
    }
  }

  return { decisions, tickets, log };
}
