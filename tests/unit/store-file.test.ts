/**
 * 文件持久化状态存储用例。
 *
 * 重点验证「进程重启」语义：同一路径的第二个实例应看到第一个实例写入的全部状态，
 * 且跨实例仍能靠 (cveId, package) 唯一约束阻止重复建单。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createFileStore } from "../../src/triage/store-file.js";
import type { TicketRow, VulnerabilityDecisionRow } from "../../src/triage/types.js";

const workDir = mkdtempSync(join(tmpdir(), "triage-store-file-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function baseRow(
  overrides: Partial<VulnerabilityDecisionRow> & { cveId: string }
): VulnerabilityDecisionRow {
  return {
    package: "lodash",
    installedVersion: "4.17.20",
    decision: null,
    executionStatus: "PENDING",
    deferReason: "BACKLOG",
    reason: null,
    evidence: null,
    retryCount: 0,
    lastError: null,
    manuallyOverridden: false,
    priorityScore: 0,
    ...overrides,
  };
}

function baseTicket(overrides: Partial<TicketRow> & { cveId: string }): TicketRow {
  return {
    id: `ticket-${overrides.cveId}`,
    package: "lodash",
    fixVersion: "4.17.21",
    status: "open",
    runId: "run-1",
    ...overrides,
  };
}

describe("文件状态存储", () => {
  test("重启后重新加载：决策、工单、日志均保留", async () => {
    const path = join(workDir, "restart.json");
    const now = 1_000;
    const first = createFileStore({ path, now: () => now });

    await first.saveDecision(baseRow({ cveId: "GHSA-aaaa", priorityScore: 5 }));
    await first.insertTicketOnce(baseTicket({ cveId: "GHSA-aaaa" }));
    await first.appendLog({ runId: "run-1", cveId: "GHSA-aaaa", event: "osv_query", seq: 1 });
    await first.appendLog({ runId: "run-1", cveId: "GHSA-aaaa", event: "decision", seq: 2 });

    // 同一路径新建实例 = 模拟进程重启后重新加载
    const second = createFileStore({ path });
    const decision = await second.getDecision("GHSA-aaaa", "lodash");
    expect(decision).toMatchObject({
      cveId: "GHSA-aaaa",
      executionStatus: "PENDING",
      createdAt: now,
      updatedAt: now,
    });
    expect((await second.getTicket("GHSA-aaaa", "lodash"))?.id).toBe("ticket-GHSA-aaaa");
    expect((await second.listLog("run-1")).map((entry) => entry.event)).toEqual([
      "osv_query",
      "decision",
    ]);
    expect(await second.countOpenTickets()).toBe(1);

    // 工单状态变更同样落盘
    await second.closeTicket("ticket-GHSA-aaaa");
    const third = createFileStore({ path });
    expect((await third.getTicket("GHSA-aaaa", "lodash"))?.status).toBe("closed");
    expect(await third.countOpenTickets()).toBe(0);
  });

  test("跨实例 insertTicketOnce 只成功一次", async () => {
    const path = join(workDir, "ticket-once.json");
    const first = createFileStore({ path });

    const created = await first.insertTicketOnce(baseTicket({ cveId: "GHSA-bbbb" }));
    expect(created.created).toBe(true);

    // 第二个实例在首次写入之后启动，等价于进程重启后重新加载
    const second = createFileStore({ path });
    const duplicated = await second.insertTicketOnce(
      baseTicket({ cveId: "GHSA-bbbb", id: "ticket-other" })
    );
    expect(duplicated.created).toBe(false);
    expect(duplicated.ticket.id).toBe("ticket-GHSA-bbbb");
    expect(await second.listTickets()).toHaveLength(1);
  });

  test("manuallyOverridden 的记录不会被 saveDecision 改写", async () => {
    const path = join(workDir, "manual.json");
    let now = 1_000;
    const first = createFileStore({ path, now: () => now });

    await first.saveDecision(
      baseRow({
        cveId: "GHSA-cccc",
        decision: "NOT_AFFECTED",
        executionStatus: "SUCCEEDED",
        deferReason: null,
        reason: "NOT_CALLED",
        manuallyOverridden: true,
      })
    );

    now = 2_000;
    const returned = await first.saveDecision(
      baseRow({
        cveId: "GHSA-cccc",
        decision: "AFFECTED",
        executionStatus: "SUCCEEDED",
        deferReason: null,
        reason: "CALLED",
      })
    );
    expect(returned.decision).toBe("NOT_AFFECTED");
    expect(returned.manuallyOverridden).toBe(true);

    const reloaded = await createFileStore({ path }).getDecision("GHSA-cccc", "lodash");
    expect(reloaded).toMatchObject({
      decision: "NOT_AFFECTED",
      manuallyOverridden: true,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  test("损坏的 JSON 抛出包含路径的错误，而非静默重置", () => {
    const path = join(workDir, "broken.json");
    writeFileSync(path, "{ 这不是合法 JSON", "utf8");

    expect(() => createFileStore({ path })).toThrow(path);

    // 结构合法但缺少表数组同样视为损坏
    writeFileSync(path, "[]", "utf8");
    expect(() => createFileStore({ path })).toThrow(path);
  });

  test("listBacklog 只返回 PENDING，按优先级降序、创建时间升序", async () => {
    const path = join(workDir, "backlog.json");
    let now = 1_000;
    const store = createFileStore({ path, now: () => now });

    await store.saveDecision(baseRow({ cveId: "GHSA-high-early", priorityScore: 10 }));
    now = 2_000;
    await store.saveDecision(baseRow({ cveId: "GHSA-high-late", priorityScore: 10 }));
    now = 500;
    await store.saveDecision(baseRow({ cveId: "GHSA-low", priorityScore: 5 }));
    await store.saveDecision(
      baseRow({
        cveId: "GHSA-done",
        priorityScore: 99,
        executionStatus: "SUCCEEDED",
        decision: "NOT_AFFECTED",
        deferReason: null,
        reason: "NOT_CALLED",
      })
    );
    await store.saveDecision(
      baseRow({
        cveId: "GHSA-running",
        priorityScore: 99,
        executionStatus: "RUNNING",
        deferReason: null,
      })
    );

    const backlog = await store.listBacklog();
    expect(backlog.map((row) => row.cveId)).toEqual([
      "GHSA-high-early",
      "GHSA-high-late",
      "GHSA-low",
    ]);

    // 排序结果同样来自落盘数据
    const reloaded = await createFileStore({ path }).listBacklog();
    expect(reloaded.map((row) => row.cveId)).toEqual([
      "GHSA-high-early",
      "GHSA-high-late",
      "GHSA-low",
    ]);
  });
});
