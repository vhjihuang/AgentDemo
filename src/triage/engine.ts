/**
 * 决策引擎：把 lockfile、OSV 快照、静态调用面三路信息合成最终结论。
 *
 * 当前只覆盖 TC-01 所需路径（成功判定 + 工单 + 事件流）。
 * 重试、配额、并发、持久化等能力按验收规格后续补齐，不提前实现。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADVISORY_FUNCTIONS } from "./advisory-functions.js";
import { matchAdvisories, type AdvisoryMatch } from "./osv.js";
import { analyzeUsage, type UsageResult } from "./usage.js";
import type {
  DecisionLogRow,
  TriageInput,
  TriageResult,
  TicketRow,
  VulnerabilityDecisionRow,
} from "./types.js";

interface LockfileShape {
  packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

interface InstalledPackage {
  name: string;
  version: string;
}

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

/** 执行一次分诊，产出决策、工单与事件流。 */
export function triage(input: TriageInput): TriageResult {
  const runId = `run-${Date.now()}`;
  const decisions: VulnerabilityDecisionRow[] = [];
  const tickets: TicketRow[] = [];
  const log: DecisionLogRow[] = [];
  let seq = 0;

  for (const installed of readInstalledPackages(input.repoPath)) {
    const advisories = matchAdvisories(
      input.osvSnapshot,
      installed.name,
      installed.version,
      ADVISORY_FUNCTIONS
    );
    const usage = analyzeUsage(input.repoPath, installed.name);

    for (const advisory of advisories) {
      log.push({ runId, cveId: advisory.advisoryId, event: "osv_query", seq: ++seq });
      log.push({ runId, cveId: advisory.advisoryId, event: "code_check", seq: ++seq });

      const row = decide(advisory, usage, installed.name, installed.version);
      decisions.push(row);
      log.push({ runId, cveId: advisory.advisoryId, event: "decision", seq: ++seq });

      if (row.decision === "AFFECTED" && row.executionStatus === "SUCCEEDED") {
        tickets.push({
          id: `ticket-${tickets.length + 1}`,
          cveId: advisory.advisoryId,
          package: installed.name,
          fixVersion: advisory.range.fixed,
          status: "open",
          runId,
        });
      }
    }
  }

  return { decisions, tickets, log };
}
