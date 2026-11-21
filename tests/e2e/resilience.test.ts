/**
 * 失败与降级用例（AC-4 / AC-5 / AC-11）。
 *
 * 重点不是「能成功」，而是「失败时不得伪装成成功」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultConfig,
  matchAdvisories,
  triage,
  type AlertPayload,
  type OsvSource,
  type RetryPolicy,
  type TicketSink,
} from "../../src/triage/index.js";
import { ADVISORY_FUNCTIONS } from "../../src/triage/advisory-functions.js";
import type { AdvisoryMatch } from "../../src/triage/osv.js";
import {
  assertAffectedHasTicket,
  assertNeedManualHasReason,
  assertNoSilentDowngrade,
} from "../helpers/assertions.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** 测试用重试策略：3 次尝试，不真实等待。 */
const fastRetry: RetryPolicy = { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} };

function loadSnapshot(version: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, "osv", `lodash-${version}.json`), "utf8"));
}

function repoPath(name: string): string {
  return join(FIXTURES, "repos", name);
}

/** 前 failures 次调用抛错，之后返回真实结果的 OSV 源。 */
function flakyOsvSource(advisories: AdvisoryMatch[], failures: number) {
  const state = { calls: 0 };
  const source: OsvSource = {
    async query() {
      state.calls += 1;
      if (state.calls <= failures) throw new Error("OSV 请求超时 (504)");
      return advisories;
    },
  };
  return { source, state };
}

/** 前 failures 次调用抛错的工单出口。 */
function flakyTicketSink(failures: number) {
  const state = { calls: 0 };
  const sink: TicketSink = {
    async create() {
      state.calls += 1;
      if (state.calls <= failures) throw new Error("工单服务 500");
      return { id: `ticket-${state.calls}` };
    },
  };
  return { sink, state };
}

/** 记录所有告警的出口。 */
function recordingAlertSink() {
  const alerts: AlertPayload[] = [];
  return {
    sink: {
      async notify(payload: AlertPayload) {
        alerts.push(payload);
      },
    },
    alerts,
  };
}

describe("失败与降级", () => {
  test("TC-05 数据源瞬时失败 → 退避重试后成功，retryCount 等于失败次数", async () => {
    const snapshot = loadSnapshot("4.17.20");
    const real = matchAdvisories(snapshot, "lodash", "4.17.20", ADVISORY_FUNCTIONS);
    const { source, state } = flakyOsvSource(real, 2);

    const result = await triage(
      { repoPath: repoPath("repo-A"), osvSnapshot: snapshot },
      { osvSource: source, retry: fastRetry }
    );

    expect(state.calls).toBe(3);
    expect(result.decisions).toHaveLength(real.length);
    expect(result.decisions.every((row) => row.executionStatus === "SUCCEEDED")).toBe(true);
    expect(result.decisions.every((row) => row.retryCount === 2)).toBe(true);
    assertNoSilentDowngrade(result.decisions);
  });

  test("TC-05b 数据源持续失败 → FAILED_PERMANENT，禁止降级为不受影响", async () => {
    const snapshot = loadSnapshot("4.17.20");
    const real = matchAdvisories(snapshot, "lodash", "4.17.20", ADVISORY_FUNCTIONS);
    const { source, state } = flakyOsvSource(real, 99);
    const { sink: alertSink, alerts } = recordingAlertSink();

    const result = await triage(
      { repoPath: repoPath("repo-A"), osvSnapshot: snapshot },
      { osvSource: source, retry: fastRetry, alertSink }
    );

    expect(state.calls).toBe(3);
    expect(result.decisions).toHaveLength(1);
    const [row] = result.decisions;
    expect(row.decision).toBeNull();
    expect(row.executionStatus).toBe("FAILED_PERMANENT");
    expect(row.retryCount).toBe(2);
    expect(row.lastError).toBeTruthy();
    expect(result.tickets).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("osv_failure");
    assertNoSilentDowngrade(result.decisions);
  });

  test("TC-07 建单瞬时失败 → 重试后成功且只落一张工单", async () => {
    const snapshot = loadSnapshot("4.17.21");
    const { sink: ticketSink, state } = flakyTicketSink(2);

    const result = await triage(
      { repoPath: repoPath("repo-C"), osvSnapshot: snapshot },
      { ticketSink, retry: fastRetry }
    );

    expect(state.calls).toBe(3);
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].cveId).toBe("GHSA-r5fr-rjxr-66jc");

    const row = result.decisions.find((item) => item.cveId === "GHSA-r5fr-rjxr-66jc");
    expect(row).toBeDefined();
    expect(row!.decision).toBe("AFFECTED");
    expect(row!.executionStatus).toBe("SUCCEEDED");
    expect(row!.retryCount).toBe(2);
  });

  test("TC-07b 建单持续失败 → 不得停在完成态，也不得伪造工单", async () => {
    const snapshot = loadSnapshot("4.17.21");
    const { sink: ticketSink, state } = flakyTicketSink(99);
    const { sink: alertSink, alerts } = recordingAlertSink();

    const result = await triage(
      { repoPath: repoPath("repo-C"), osvSnapshot: snapshot },
      { ticketSink, retry: fastRetry, alertSink }
    );

    expect(state.calls).toBe(3);
    expect(result.tickets).toHaveLength(0);

    const row = result.decisions.find((item) => item.cveId === "GHSA-r5fr-rjxr-66jc");
    expect(row).toBeDefined();
    expect(row!.decision).toBe("AFFECTED");
    expect(row!.executionStatus).toBe("FAILED_PERMANENT");
    expect(row!.retryCount).toBe(2);
    expect(row!.lastError).toBeTruthy();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("ticket_failure");

    // AFFECTED 但未成功的不要求有工单，此不变式仍应通过
    assertAffectedHasTicket(result.decisions, result.tickets);
  });

  test("TC-09 代码检查返回空 → 禁止 AFFECTED，转 NEED_MANUAL/EVIDENCE_MISSING", async () => {
    const snapshot = loadSnapshot("4.17.20");
    const result = await triage(
      { repoPath: repoPath("repo-A"), osvSnapshot: snapshot },
      {
        analyzer: {
          async analyze() {
            return null;
          },
        },
      }
    );

    // 检查不出结果时，四条漏洞都不能下业务结论
    expect(result.decisions).toHaveLength(4);
    for (const row of result.decisions) {
      expect(row.decision, `${row.cveId} 不得给出业务结论`).toBe("NEED_MANUAL");
      expect(row.reason, `${row.cveId} 原因码不符`).toBe("EVIDENCE_MISSING");
    }
    expect(result.tickets).toHaveLength(0);
    assertNeedManualHasReason(result.decisions);
  });

  test("TC-15 分析轮次超过 MAX_ROUNDS → NEED_MANUAL/MAX_ROUNDS_EXCEEDED，不得挂起", async () => {
    const snapshot = loadSnapshot("4.17.20");
    const result = await triage(
      { repoPath: repoPath("repo-A"), osvSnapshot: snapshot },
      {
        config: { ...createDefaultConfig(), maxRounds: 3 },
        analyzer: {
          async analyze() {
            // 超过上限 1 轮，必须被终止而不是继续循环
            return {
              rounds: 4,
              usage: { importsPackage: true, dynamicImport: false, callSites: [] },
            };
          },
        },
      }
    );

    expect(result.decisions).toHaveLength(4);
    for (const row of result.decisions) {
      expect(row.decision, `${row.cveId} 不得给出业务结论`).toBe("NEED_MANUAL");
      expect(row.reason, `${row.cveId} 原因码不符`).toBe("MAX_ROUNDS_EXCEEDED");
    }
    expect(result.tickets).toHaveLength(0);
    assertNeedManualHasReason(result.decisions);
  }, 5_000);
});
