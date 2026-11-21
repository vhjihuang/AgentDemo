/**
 * 分诊状态存储端口。
 *
 * 决策、工单、事件流都落在这里，跨运行语义由它保证：
 *   - 幂等：同一 (cveId, package) 只有一条决策、一张工单
 *   - 人工覆盖优先：manuallyOverridden 的记录不得被自动流程改写
 *   - 排队可查：PENDING 记录必须能通过 listBacklog 取回，不允许丢弃
 *
 * 默认提供内存实现用于测试与本地运行；持久化实现（sqlite）替换同一接口即可。
 */
import type { DecisionLogRow, TicketRow, VulnerabilityDecisionRow } from "./types.js";

/** 存储层额外的审计字段，不进入对外契约。 */
export interface StoredDecisionRow extends VulnerabilityDecisionRow {
  /** 首次写入时间（epoch ms）。 */
  createdAt: number;
  /** 最近一次写入时间（epoch ms），用于 RUNNING 超时回收。 */
  updatedAt: number;
}

export interface TriageStore {
  getDecision(cveId: string, packageName: string): Promise<StoredDecisionRow | null>;
  /** 按 (cveId, package) upsert。已人工覆盖的记录原样返回，不写入。 */
  saveDecision(row: VulnerabilityDecisionRow): Promise<StoredDecisionRow>;
  listDecisions(): Promise<StoredDecisionRow[]>;
  /** 排队视图：PENDING 记录按优先级降序、创建时间升序返回。 */
  listBacklog(): Promise<StoredDecisionRow[]>;

  getTicket(cveId: string, packageName: string): Promise<TicketRow | null>;
  /** 按 (cveId, package) 唯一插入。已存在时返回原记录且 created=false。 */
  insertTicketOnce(ticket: TicketRow): Promise<{ ticket: TicketRow; created: boolean }>;
  listTickets(): Promise<TicketRow[]>;
  closeTicket(id: string): Promise<void>;
  /** 未关闭工单数量，配额以它为准。 */
  countOpenTickets(): Promise<number>;

  /** 卡在 RUNNING 且超过 timeoutMs 的记录，用于崩溃恢复。 */
  listStaleRunning(now: number, timeoutMs: number): Promise<StoredDecisionRow[]>;

  appendLog(row: DecisionLogRow): Promise<void>;
  listLog(runId?: string): Promise<DecisionLogRow[]>;
}

export interface InMemoryStoreOptions {
  /** 可注入时钟，便于构造「超时」场景而不必真实等待。 */
  now?: () => number;
}

function keyOf(cveId: string, packageName: string): string {
  return `${cveId}|${packageName}`;
}

/** 内存实现。单进程内以 Map 保证唯一键，读改写之间不 await，避免并发插入重复。 */
export function createInMemoryStore(options: InMemoryStoreOptions = {}): TriageStore {
  const clock = options.now ?? (() => Date.now());
  const decisions = new Map<string, StoredDecisionRow>();
  const tickets = new Map<string, TicketRow>();
  const logs: DecisionLogRow[] = [];

  return {
    async getDecision(cveId, packageName) {
      return decisions.get(keyOf(cveId, packageName)) ?? null;
    },

    async saveDecision(row) {
      const key = keyOf(row.cveId, row.package);
      const existing = decisions.get(key);
      if (existing?.manuallyOverridden) return existing;

      const timestamp = clock();
      const stored: StoredDecisionRow = {
        ...row,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      decisions.set(key, stored);
      return stored;
    },

    async listDecisions() {
      return [...decisions.values()];
    },

    async listBacklog() {
      return [...decisions.values()]
        .filter((row) => row.executionStatus === "PENDING")
        .sort((a, b) => b.priorityScore - a.priorityScore || a.createdAt - b.createdAt);
    },

    async getTicket(cveId, packageName) {
      return tickets.get(keyOf(cveId, packageName)) ?? null;
    },

    async insertTicketOnce(ticket) {
      const key = keyOf(ticket.cveId, ticket.package);
      const existing = tickets.get(key);
      if (existing) return { ticket: existing, created: false };
      tickets.set(key, ticket);
      return { ticket, created: true };
    },

    async listTickets() {
      return [...tickets.values()];
    },

    async closeTicket(id) {
      for (const [key, ticket] of tickets) {
        if (ticket.id === id) tickets.set(key, { ...ticket, status: "closed" });
      }
    },

    async countOpenTickets() {
      let count = 0;
      for (const ticket of tickets.values()) {
        if (ticket.status === "open") count += 1;
      }
      return count;
    },

    async listStaleRunning(now, timeoutMs) {
      return [...decisions.values()].filter(
        (row) => row.executionStatus === "RUNNING" && now - row.updatedAt >= timeoutMs
      );
    },

    async appendLog(row) {
      logs.push(row);
    },

    async listLog(runId) {
      return runId === undefined ? [...logs] : logs.filter((entry) => entry.runId === runId);
    },
  };
}
