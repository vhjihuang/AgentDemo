/**
 * 外部依赖的端口定义（ports）。
 *
 * 把 OSV 查询、工单创建、告警抽成接口，目的不是"为了测试而抽象"，
 * 而是这些操作本身就有独立的失败语义：网络会超时、下游会 500。
 * 只有把它们变成可替换的实现，故障注入才可能，重试策略才有落点。
 */
import type { AdvisoryMatch } from "./osv.js";
import { matchAdvisories, type AdvisoryFunctionIndex } from "./osv.js";

/** 漏洞数据源。失败时抛出，由调用方决定重试与降级。 */
export interface OsvSource {
  query(packageName: string, installedVersion: string): Promise<AdvisoryMatch[]>;
}

/** 创建工单所需的最小信息。 */
export interface TicketDraft {
  cveId: string;
  package: string;
  fixVersion: string | null;
}

/** 工单系统的出口。失败时抛出，禁止伪造成功响应。 */
export interface TicketSink {
  create(draft: TicketDraft): Promise<{ id: string }>;
}

export type AlertKind = "osv_failure" | "ticket_failure";

/** 告警载荷。cveId 为 null 表示包级失败（尚未定位到具体漏洞）。 */
export interface AlertPayload {
  kind: AlertKind;
  package: string;
  cveId: string | null;
  message: string;
}

/** 告警与人工队列的出口。 */
export interface AlertSink {
  notify(payload: AlertPayload): Promise<void>;
}

/** 重试策略。sleep 可注入，测试中替换为空实现以免真实等待。 */
export interface RetryPolicy {
  /** 总尝试次数，包含首次调用。 */
  maxAttempts: number;
  /** 指数退避基数，单位毫秒。 */
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

/** 基于冻结快照的默认数据源，测试与非在线场景使用。 */
export function createSnapshotOsvSource(
  snapshot: unknown,
  functions: AdvisoryFunctionIndex
): OsvSource {
  return {
    async query(packageName, installedVersion) {
      return matchAdvisories(snapshot, packageName, installedVersion, functions);
    },
  };
}

/** 内存工单出口，仅用于本地运行与测试。 */
export function createInMemoryTicketSink(): TicketSink {
  let counter = 0;
  return {
    async create() {
      counter += 1;
      return { id: `ticket-${counter}` };
    },
  };
}

/** 默认告警出口：不做任何事。真实环境应替换为工单系统或 IM 通知。 */
export function createNoopAlertSink(): AlertSink {
  return {
    async notify() {
      // 有意为空：默认不产生外部副作用
    },
  };
}

/** 重试策略：按配置构造，sleep 默认为真实等待。 */
export function createRetryPolicy(options: {
  maxAttempts: number;
  baseDelayMs: number;
}): RetryPolicy {
  return {
    maxAttempts: options.maxAttempts,
    baseDelayMs: options.baseDelayMs,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
