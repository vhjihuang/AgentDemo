/**
 * 持久化阶段：跨运行的幂等与人工覆盖守卫都在这里。
 *
 * 判定可以重算，写入不能重放：
 *   - 已终态的记录不再重跑（AC-3 / AC-9）
 *   - 人工覆盖的记录原样保留（AC-12）
 *   - 崩溃遗留的 RUNNING 记录在超时后回收为排队态（AC-9）
 */
import type { TriageStore } from "./store.js";
import type { VulnerabilityDecisionRow } from "./types.js";

export type PersistPrecheck =
  | { action: "skip"; row: VulnerabilityDecisionRow }
  | { action: "proceed" };

/** 判断一条已存在的记录是否应当阻止本次重算与副作用。 */
export async function precheckDecision(
  store: TriageStore,
  computed: VulnerabilityDecisionRow
): Promise<PersistPrecheck> {
  const existing = await store.getDecision(computed.cveId, computed.package);
  if (!existing) return { action: "proceed" };

  if (existing.manuallyOverridden) return { action: "skip", row: existing };

  const isTerminal = existing.executionStatus === "SUCCEEDED" && existing.decision !== null;
  if (isTerminal) return { action: "skip", row: existing };

  return { action: "proceed" };
}

/** 把卡死的 RUNNING 记录回收为排队态，返回回收条数。 */
export async function reclaimStaleRunning(
  store: TriageStore,
  now: number,
  timeoutMs: number
): Promise<number> {
  const stale = await store.listStaleRunning(now, timeoutMs);
  for (const row of stale) {
    await store.saveDecision({
      ...row,
      decision: null,
      executionStatus: "PENDING",
      deferReason: "BACKLOG",
      reason: null,
      evidence: null,
    });
  }
  return stale.length;
}
