/**
 * 验收不变式断言。
 *
 * 这些函数只做纯数据判断，不依赖数据库或框架，便于在单元测试、
 * e2e 测试、以及对账脚本三处复用同一套规则。
 */
import assert from "node:assert/strict";
import type { TicketRow, VulnerabilityDecisionRow } from "../contracts/types.js";

/** 生成带上下文的错误信息，便于定位是哪条 CVE 违反了不变式。 */
function ctx(row: Pick<VulnerabilityDecisionRow, "cveId" | "installedVersion">): string {
  return `cveId=${row.cveId} version=${row.installedVersion}`;
}

/**
 * 不变式 1：NOT_AFFECTED 只能出现在执行成功的记录上。
 * 数据源超时、代码检查失败等情况下绝不允许降级为「不受影响」。
 */
export function assertNoSilentDowngrade(rows: VulnerabilityDecisionRow[]): void {
  const violated = rows.filter(
    (r) => r.decision === "NOT_AFFECTED" && r.executionStatus !== "SUCCEEDED"
  );
  assert.equal(
    violated.length,
    0,
    `存在静默降级: ${violated.map(ctx).join(", ") || "(none)"}`
  );
}

/**
 * 不变式 2：判定为 AFFECTED 且执行成功的记录，必须存在对应工单。
 * 等价于「不允许出现已完成但没落单」的状态组合。
 */
export function assertAffectedHasTicket(
  rows: VulnerabilityDecisionRow[],
  tickets: TicketRow[]
): void {
  const ticketKeys = new Set(tickets.map((t) => `${t.cveId}|${t.package}`));
  const violated = rows.filter(
    (r) =>
      r.decision === "AFFECTED" &&
      r.executionStatus === "SUCCEEDED" &&
      !ticketKeys.has(`${r.cveId}|${r.package}`)
  );
  assert.equal(
    violated.length,
    0,
    `AFFECTED 已完成但缺少工单: ${violated.map(ctx).join(", ") || "(none)"}`
  );
}

/** 不变式 3：同一 (cveId, package) 不得存在多张工单。 */
export function assertNoDuplicateTickets(tickets: TicketRow[]): void {
  const seen = new Map<string, number>();
  for (const t of tickets) {
    const key = `${t.cveId}|${t.package}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  assert.equal(duplicated.length, 0, `存在重复工单: ${duplicated.join(", ") || "(none)"}`);
}

/** 不变式 4：NEED_MANUAL 必须携带原因码，禁止空原因。 */
export function assertNeedManualHasReason(rows: VulnerabilityDecisionRow[]): void {
  const violated = rows.filter((r) => r.decision === "NEED_MANUAL" && !r.reason);
  assert.equal(
    violated.length,
    0,
    `NEED_MANUAL 缺少原因码: ${violated.map(ctx).join(", ") || "(none)"}`
  );
}

/** 不变式 5：AFFECTED 必须携带证据链（调用点或版本比较过程）。 */
export function assertAffectedHasEvidence(rows: VulnerabilityDecisionRow[]): void {
  const violated = rows.filter(
    (r) => r.decision === "AFFECTED" && (!r.evidence || r.evidence.callSites.length === 0)
  );
  assert.equal(
    violated.length,
    0,
    `AFFECTED 缺少证据: ${violated.map(ctx).join(", ") || "(none)"}`
  );
}

/** 不变式 6：排队中的记录必须有 deferReason，且不得提前带结论。 */
export function assertDeferredWellFormed(rows: VulnerabilityDecisionRow[]): void {
  const missingReason = rows.filter((r) => r.executionStatus === "PENDING" && !r.deferReason);
  const earlyDecision = rows.filter((r) => r.executionStatus === "PENDING" && r.decision !== null);
  assert.equal(missingReason.length, 0, `PENDING 缺少 deferReason: ${missingReason.map(ctx).join(", ")}`);
  assert.equal(earlyDecision.length, 0, `PENDING 已提前给出结论: ${earlyDecision.map(ctx).join(", ")}`);
}

/**
 * 不变式 7：排队记录不得丢失。
 *
 * 容量上限会合理地让部分记录持续排队，因此「仍为 PENDING」不能用来判定饥饿。
 * 真正的失败是记录既没有出队、也查不到——即从库中静默消失。
 * @param snapshots 按运行轮次排列的记录快照
 */
export function assertNoStarvation(snapshots: VulnerabilityDecisionRow[][]): void {
  if (snapshots.length < 2) return;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const lastKeys = new Set(last.map((r) => `${r.cveId}|${r.package}`));
  const lost = first
    .filter((r) => r.executionStatus === "PENDING" && !lastKeys.has(`${r.cveId}|${r.package}`))
    .map((r) => `${r.cveId}|${r.package}`);
  assert.equal(lost.length, 0, `排队记录丢失: ${lost.join(", ") || "(none)"}`);
}
