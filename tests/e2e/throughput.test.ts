/**
 * 吞吐与排队用例（AC-7）。
 *
 * 验证截断是「排队」而不是「丢弃」。
 *
 * 说明：这两条验证的是配额与排队状态机，不验证判定正确性。
 * 判定正确性由 TC-01~04 的真实 OSV 快照覆盖，因此这里用注入端口构造 50 个目标，
 * 而不是伪造 50 条漏洞数据。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { assertDeferredWellFormed, assertNoStarvation } from "../helpers/assertions.js";
import {
  createDefaultConfig,
  createInMemoryStore,
  triage,
  type Analyzer,
  type OsvSource,
  type TicketSink,
} from "../../src/triage/index.js";

const TARGETS = 50;
const MAX_TICKETS = 10;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 生成一个声明 count 个依赖、且依赖均已安装的最小仓库。 */
function createQuotaRepo(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "triage-quota-"));
  tempDirs.push(dir);

  const dependencies: Record<string, string> = {};
  const packages: Record<string, unknown> = {
    "": { name: "quota-fixture", version: "1.0.0", dependencies },
  };

  for (let index = 0; index < count; index += 1) {
    const name = `pkg-${String(index).padStart(2, "0")}`;
    dependencies[name] = "1.0.0";
    packages[`node_modules/${name}`] = { version: "1.0.0" };
  }

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "quota-fixture", version: "1.0.0", dependencies }, null, 2)
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify(
      {
        name: "quota-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages,
      },
      null,
      2
    )
  );
  return dir;
}

/** 每个包都命中一条漏洞。 */
const quotaOsvSource: OsvSource = {
  async query(packageName) {
    return [
      {
        advisoryId: `GHSA-quota-${packageName}`,
        aliases: [],
        affectedFunctions: ["run"],
        range: { introduced: "0.0.0", fixed: "9.9.9" },
      },
    ];
  },
};

/** 每个包都被标记为「引用并调用了受影响函数」。 */
const calledAnalyzer: Analyzer = {
  async analyze() {
    return {
      rounds: 1,
      usage: {
        importsPackage: true,
        dynamicImport: false,
        callSites: [{ file: "src/index.js", line: 1, symbol: "run" }],
      },
    };
  },
};

function countingTicketSink() {
  const state = { calls: 0 };
  const sink: TicketSink = {
    async create() {
      state.calls += 1;
      return { id: `quota-ticket-${state.calls}` };
    },
  };
  return { sink, state };
}

function createHarness() {
  const repoPath = createQuotaRepo(TARGETS);
  const store = createInMemoryStore();
  const { sink, state } = countingTicketSink();
  const dependencyOverrides = {
    store,
    ticketSink: sink,
    osvSource: quotaOsvSource,
    analyzer: calledAnalyzer,
    config: { ...createDefaultConfig(), maxOpenTickets: MAX_TICKETS },
  };
  return { repoPath, store, sink, state, dependencyOverrides };
}

describe("吞吐与排队", () => {
  test("TC-08 50 条受影响 → 建单数不超过上限，其余为 PENDING/RATE_LIMIT 且可被 backlog 查询到", async () => {
    const { repoPath, store, state, dependencyOverrides } = createHarness();

    const result = await triage(
      { repoPath, osvSnapshot: {} },
      { ...dependencyOverrides, runId: "run-08" }
    );

    expect(result.decisions).toHaveLength(TARGETS);
    expect(
      result.decisions.filter(
        (row) => row.decision === "AFFECTED" && row.executionStatus === "SUCCEEDED"
      )
    ).toHaveLength(MAX_TICKETS);
    expect(result.decisions.filter((row) => row.executionStatus === "PENDING")).toHaveLength(
      TARGETS - MAX_TICKETS
    );

    // 排队行不得提前带结论，且必须带排队原因
    assertDeferredWellFormed(result.decisions);

    expect(state.calls).toBe(MAX_TICKETS);
    expect(await store.listTickets()).toHaveLength(MAX_TICKETS);
    // 截断即排队：剩余条目全部可查，没有丢弃
    expect(await store.listBacklog()).toHaveLength(TARGETS - MAX_TICKETS);
  });

  test("TC-08b 释放槽位后 → 原本 deferred 的条目被补位处理，无记录永久停留 PENDING", async () => {
    const { repoPath, store, dependencyOverrides } = createHarness();

    const first = await triage(
      { repoPath, osvSnapshot: {} },
      { ...dependencyOverrides, runId: "run-08" }
    );

    // 关闭 5 张未关闭工单，模拟槽位释放
    const openTickets = (await store.listTickets()).filter((ticket) => ticket.status === "open");
    for (const ticket of openTickets.slice(0, 5)) {
      await store.closeTicket(ticket.id);
    }

    const second = await triage(
      { repoPath, osvSnapshot: {} },
      { ...dependencyOverrides, runId: "run-08b" }
    );

    // 补位顺序：按排队先后，最先进入队列的 5 条获得新槽位
    expect(second.tickets.map((ticket) => ticket.cveId).sort()).toEqual([
      "GHSA-quota-pkg-10",
      "GHSA-quota-pkg-11",
      "GHSA-quota-pkg-12",
      "GHSA-quota-pkg-13",
      "GHSA-quota-pkg-14",
    ]);
    expect(await store.listTickets()).toHaveLength(MAX_TICKETS + 5);
    expect(await store.listBacklog()).toHaveLength(TARGETS - MAX_TICKETS - 5);

    assertDeferredWellFormed(second.decisions);
    assertNoStarvation([first.decisions, second.decisions]);
  });
});
