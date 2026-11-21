/**
 * 基于单个 JSON 文件的持久化状态存储。
 *
 * 进程边界：单进程独占该文件，不支持多进程并发写（未实现文件锁）。
 * 若需要多进程共享同一份状态，请改用带事务的数据库实现。
 *
 * 写入策略：先写 `${path}.tmp` 再 rename 覆盖，保证任何时刻磁盘上的文件都是完整快照。
 * 读取策略：文件不存在视为空库；内容无法解析时直接抛错，绝不静默重置（否则会重复建单）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { TriageStore, StoredDecisionRow } from "./store.js";
import type { DecisionLogRow, TicketRow, VulnerabilityDecisionRow } from "./types.js";

export interface FileStoreOptions {
  /** 状态文件路径，目录需已存在。 */
  path: string;
  /** 可注入时钟，便于测试 createdAt / updatedAt 相关行为。 */
  now?: () => number;
}

/** 落盘格式：三张表的全量快照。 */
interface StoreSnapshot {
  decisions: StoredDecisionRow[];
  tickets: TicketRow[];
  logs: DecisionLogRow[];
}

function keyOf(cveId: string, packageName: string): string {
  return `${cveId}|${packageName}`;
}

function isStoreSnapshot(value: unknown): value is StoreSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoreSnapshot>;
  return (
    Array.isArray(candidate.decisions) &&
    Array.isArray(candidate.tickets) &&
    Array.isArray(candidate.logs)
  );
}

export function createFileStore(options: FileStoreOptions): TriageStore {
  const clock = options.now ?? (() => Date.now());
  const filePath = options.path;

  const decisions = new Map<string, StoredDecisionRow>();
  const tickets = new Map<string, TicketRow>();
  const logs: DecisionLogRow[] = [];

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`状态文件解析失败，拒绝以空库启动：${filePath}（${detail}）`);
    }
    if (!isStoreSnapshot(parsed)) {
      throw new Error(`状态文件结构非法（缺少 decisions/tickets/logs 数组）：${filePath}`);
    }
    for (const row of parsed.decisions) decisions.set(keyOf(row.cveId, row.package), row);
    for (const ticket of parsed.tickets) tickets.set(keyOf(ticket.cveId, ticket.package), ticket);
    logs.push(...parsed.logs);
  }

  /** 全量快照落盘：临时文件 + rename，避免半写。 */
  function persist(): void {
    const snapshot: StoreSnapshot = {
      decisions: [...decisions.values()],
      tickets: [...tickets.values()],
      logs: [...logs],
    };
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
    renameSync(tmpPath, filePath);
  }

  return {
    async getDecision(cveId, packageName) {
      return decisions.get(keyOf(cveId, packageName)) ?? null;
    },

    async saveDecision(row: VulnerabilityDecisionRow) {
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
      persist();
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
      persist();
      return { ticket, created: true };
    },

    async listTickets() {
      return [...tickets.values()];
    },

    async closeTicket(id) {
      let changed = false;
      for (const [key, ticket] of tickets) {
        if (ticket.id === id) {
          tickets.set(key, { ...ticket, status: "closed" });
          changed = true;
        }
      }
      if (changed) persist();
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
      persist();
    },

    async listLog(runId) {
      return runId === undefined ? [...logs] : logs.filter((entry) => entry.runId === runId);
    },
  };
}
