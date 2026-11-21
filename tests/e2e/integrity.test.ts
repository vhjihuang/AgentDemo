/**
 * 数据完整性与并发用例（AC-3 / AC-9 / AC-10 / AC-12 / AC-13）。
 *
 * 前四条共享同一个 store 实例，验证的是「跨运行」语义而不是单次运行：
 * 判定可以重算，写入不能重放。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ConfigError,
  createDefaultConfig,
  createInMemoryStore,
  loadConfig,
  triage,
  type TicketSink,
  type VulnerabilityDecisionRow,
} from "../../src/triage/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

function loadSnapshot(version: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, "osv", `lodash-${version}.json`), "utf8"));
}

function repoPath(name: string): string {
  return join(FIXTURES, "repos", name);
}

/** 记录调用次数的工单出口，用于断言「创建调用 0 次」。 */
function countingTicketSink() {
  const state = { calls: 0 };
  const sink: TicketSink = {
    async create() {
      state.calls += 1;
      return { id: `ticket-${state.calls}` };
    },
  };
  return { sink, state };
}

/** 构造预置记录，用于模拟「上次运行已完成 / 崩溃遗留」。 */
function baseRow(
  overrides: Partial<VulnerabilityDecisionRow> & { cveId: string }
): VulnerabilityDecisionRow {
  return {
    package: "lodash",
    installedVersion: "4.17.20",
    decision: null,
    executionStatus: "SUCCEEDED",
    deferReason: null,
    reason: null,
    evidence: null,
    retryCount: 0,
    lastError: null,
    manuallyOverridden: false,
    priorityScore: 0,
    ...overrides,
  };
}

describe("数据完整性与并发", () => {
  test("TC-06 重复运行同一夹具 → 工单仍 1 张，实际创建调用 0 次", async () => {
    const snapshot = loadSnapshot("4.17.21");
    const store = createInMemoryStore();
    const { sink, state } = countingTicketSink();
    const input = { repoPath: repoPath("repo-C"), osvSnapshot: snapshot };

    const first = await triage(input, { ticketSink: sink, store });
    expect(first.tickets).toHaveLength(1);
    expect(state.calls).toBe(1);

    // 第二次运行：终态记录不重跑，不重复建单
    const second = await triage(input, { ticketSink: sink, store });
    expect(second.tickets).toHaveLength(0);
    expect(state.calls).toBe(1);
    expect(await store.listTickets()).toHaveLength(1);
  });

  test("TC-13 处理中途退出后重启 → 已完成条目不复跑，RUNNING 超时回收后继续", async () => {
    const NOW = Date.now();
    const runningTimeoutMs = createDefaultConfig().runningTimeoutMs;
    const clock = { value: NOW - runningTimeoutMs * 2 };
    const store = createInMemoryStore({ now: () => clock.value });
    const { sink, state } = countingTicketSink();

    // 预置：29mw 已完成；35jh 卡在 RUNNING 且已超时
    await store.saveDecision(
      baseRow({
        cveId: "GHSA-29mw-wpgm-hmr9",
        decision: "NOT_AFFECTED",
        reason: "NOT_CALLED",
      })
    );
    await store.saveDecision(
      baseRow({
        cveId: "GHSA-35jh-r3h4-6jhm",
        decision: null,
        executionStatus: "RUNNING",
      })
    );

    clock.value = NOW;
    await triage(
      { repoPath: repoPath("repo-A"), osvSnapshot: loadSnapshot("4.17.20") },
      { store, ticketSink: sink, now: () => NOW }
    );

    // 已完成条目保持原结论，未被重写
    const completed = await store.getDecision("GHSA-29mw-wpgm-hmr9", "lodash");
    expect(completed!.decision).toBe("NOT_AFFECTED");
    expect(completed!.executionStatus).toBe("SUCCEEDED");

    // 超时的 RUNNING 条目被回收并继续处理到终态
    const recovered = await store.getDecision("GHSA-35jh-r3h4-6jhm", "lodash");
    expect(recovered!.decision).toBe("AFFECTED");
    expect(recovered!.executionStatus).toBe("SUCCEEDED");

    // 只为未完成条目建单：35jh 与 r5fr 各一张，29mw 不建
    expect(state.calls).toBe(2);
    expect((await store.listTickets()).map((t) => t.cveId).sort()).toEqual([
      "GHSA-35jh-r3h4-6jhm",
      "GHSA-r5fr-rjxr-66jc",
    ]);
    expect(await store.listStaleRunning(NOW, runningTimeoutMs)).toHaveLength(0);
  });

  test("TC-14 两个 run 并发处理同一夹具 → 唯一约束生效，工单不重复且无未捕获异常", async () => {
    const snapshot = loadSnapshot("4.17.21");
    const store = createInMemoryStore();
    const { sink } = countingTicketSink();
    const input = { repoPath: repoPath("repo-C"), osvSnapshot: snapshot };

    const [runA, runB] = await Promise.all([
      triage(input, { store, ticketSink: sink, runId: "run-a" }),
      triage(input, { store, ticketSink: sink, runId: "run-b" }),
    ]);

    // 唯一键生效：无论两轮谁先插入，最终只有一张工单
    const tickets = await store.listTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].cveId).toBe("GHSA-r5fr-rjxr-66jc");

    // 只有真正插入成功的那一轮把它计入本次新建
    expect(runA.tickets.length + runB.tickets.length).toBe(1);
  });

  test("TC-16 人工覆盖后再跑自动流程 → manuallyOverridden 的记录不被改写", async () => {
    const store = createInMemoryStore();
    await store.saveDecision(
      baseRow({
        cveId: "GHSA-35jh-r3h4-6jhm",
        decision: "NOT_AFFECTED",
        reason: "NOT_CALLED",
        manuallyOverridden: true,
      })
    );

    const result = await triage({
      repoPath: repoPath("repo-A"),
      osvSnapshot: loadSnapshot("4.17.20"),
    }, { store });

    const preserved = await store.getDecision("GHSA-35jh-r3h4-6jhm", "lodash");
    expect(preserved!.decision).toBe("NOT_AFFECTED");
    expect(preserved!.manuallyOverridden).toBe(true);

    // 人工判定为不受影响，因此不得为它建单；另一条 AFFECTED 照常建单
    expect(result.tickets.map((t) => t.cveId)).toEqual(["GHSA-r5fr-rjxr-66jc"]);
  });

  test("TC-17 缺少必需配置 → 启动失败且错误信息指明缺失项", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);

    try {
      loadConfig({});
      expect.unreachable("缺少必需配置时不应返回配置");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.missing).toEqual(
        expect.arrayContaining(["RETRY_MAX", "MAX_OPEN_TICKETS", "CIRCUIT_BREAKER_THRESHOLD"])
      );
      expect(configError.message).toContain("RETRY_MAX");
    }

    // 非法值同样必须失败，不得静默回退到默认值
    expect(() =>
      loadConfig({ RETRY_MAX: "0", MAX_OPEN_TICKETS: "10", CIRCUIT_BREAKER_THRESHOLD: "5" })
    ).toThrow(/RETRY_MAX/);

    const valid = loadConfig({
      RETRY_MAX: "3",
      MAX_OPEN_TICKETS: "10",
      CIRCUIT_BREAKER_THRESHOLD: "5",
    });
    expect(valid.retryMax).toBe(3);
    // 非必需键保留 SPEC §7 默认值
    expect(valid.maxRounds).toBe(createDefaultConfig().maxRounds);
  });
});
