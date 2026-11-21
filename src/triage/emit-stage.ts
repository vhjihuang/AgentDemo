/**
 * 副作用阶段：建单、配额排队、失败告警。
 *
 * 三条硬约束：
 *   - 已有工单的记录不再创建（幂等，AC-3）
 *   - 未关闭工单达到上限时排队而不是丢弃（AC-7），且排队行不得带结论
 *   - 建单失败必须落到 FAILED_PERMANENT 并告警，不允许停留在完成态（AC-5）
 */
import type { AlertSink, RetryPolicy, TicketSink } from "./ports.js";
import { RetryExhaustedError, withRetry } from "./retry.js";
import type { TriageStore } from "./store.js";
import type { DecisionLogRow, TicketRow, VulnerabilityDecisionRow } from "./types.js";

export interface EmitContext {
  store: TriageStore;
  ticketSink: TicketSink;
  alertSink: AlertSink;
  retry: RetryPolicy;
  /** 未关闭工单总量上限（WIP 限制），不是单轮建单数。 */
  maxOpenTickets: number;
}

export interface EmitOutcome {
  row: VulnerabilityDecisionRow;
  /** 仅当本次运行真正新建了工单时非空。 */
  ticket: TicketRow | null;
  events: Array<DecisionLogRow["event"]>;
}

export async function emitDecision(
  context: EmitContext,
  runId: string,
  row: VulnerabilityDecisionRow,
  fixVersion: string | null
): Promise<EmitOutcome> {
  const events: Array<DecisionLogRow["event"]> = [];

  if (row.decision !== "AFFECTED" || row.executionStatus !== "SUCCEEDED") {
    return { row, ticket: null, events };
  }

  // 幂等：同一 (cveId, package) 已有工单时不再调用下游
  const existingTicket = await context.store.getTicket(row.cveId, row.package);
  if (existingTicket) {
    return { row, ticket: null, events };
  }

  const openTickets = await context.store.countOpenTickets();
  if (openTickets >= context.maxOpenTickets) {
    // 排队而不是丢弃：清空结论，等待槽位释放后重入
    return {
      row: {
        ...row,
        decision: null,
        executionStatus: "PENDING",
        deferReason: "RATE_LIMIT",
        reason: null,
        evidence: null,
      },
      ticket: null,
      events,
    };
  }

  try {
    const created = await withRetry(
      () =>
        context.ticketSink.create({
          cveId: row.cveId,
          package: row.package,
          fixVersion,
        }),
      context.retry
    );

    const draft: TicketRow = {
      id: created.value.id,
      cveId: row.cveId,
      package: row.package,
      fixVersion,
      status: "open",
      runId,
    };
    const inserted = await context.store.insertTicketOnce(draft);

    return {
      row: { ...row, retryCount: row.retryCount + (created.attempts - 1) },
      ticket: inserted.created ? inserted.ticket : null,
      events,
    };
  } catch (error) {
    const exhausted =
      error instanceof RetryExhaustedError
        ? error
        : new RetryExhaustedError(context.retry.maxAttempts, error);

    events.push("ticket_create_failed");
    await context.alertSink.notify({
      kind: "ticket_failure",
      package: row.package,
      cveId: row.cveId,
      message: exhausted.message,
    });

    return {
      row: {
        ...row,
        executionStatus: "FAILED_PERMANENT",
        retryCount: row.retryCount + Math.max(0, exhausted.attempts - 1),
        lastError: exhausted.message,
      },
      ticket: null,
      events,
    };
  }
}
