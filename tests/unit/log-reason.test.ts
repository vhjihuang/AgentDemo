/**
 * TC-11 事件流完整 / TC-12 失败必须带原因码。
 *
 * 这两条验证的是可观测性契约：出问题时能否复原判定过程，
 * 以及失败是否有明确归因而非静默。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REASON_CODES, triage } from "../../src/triage/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

function loadSnapshot(version: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, "osv", `lodash-${version}.json`), "utf8"));
}

describe("TC-11 事件流完整", () => {
  test("每条漏洞的事件顺序为 osv_query → code_check → decision，且 seq 单调递增", async () => {
    const result = await triage({
      repoPath: join(FIXTURES, "repos", "repo-A"),
      osvSnapshot: loadSnapshot("4.17.20"),
    });

    const eventsByCve = new Map<string, string[]>();
    for (const entry of result.log) {
      const events = eventsByCve.get(entry.cveId) ?? [];
      events.push(entry.event);
      eventsByCve.set(entry.cveId, events);
    }

    expect(eventsByCve.size).toBe(result.decisions.length);
    for (const [cveId, events] of eventsByCve) {
      expect(events, `${cveId} 事件序列不符`).toEqual(["osv_query", "code_check", "decision"]);
    }

    const seqs = result.log.map((entry) => entry.seq);
    expect(new Set(seqs).size, "seq 存在重复").toBe(seqs.length);
    expect(seqs, "seq 未单调递增").toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("TC-12 失败必须带原因码", () => {
  test("NEED_MANUAL 必须带枚举内原因码", async () => {
    const result = await triage({
      repoPath: join(FIXTURES, "repos", "repo-D"),
      osvSnapshot: loadSnapshot("4.17.20"),
    });

    const needManual = result.decisions.filter((row) => row.decision === "NEED_MANUAL");
    expect(needManual.length).toBeGreaterThan(0);
    for (const row of needManual) {
      expect(row.reason, `${row.cveId} 缺少原因码`).not.toBeNull();
      expect(REASON_CODES as readonly string[]).toContain(row.reason);
    }
  });

  test("正常路径不应产生 NEED_MANUAL", async () => {
    const result = await triage({
      repoPath: join(FIXTURES, "repos", "repo-A"),
      osvSnapshot: loadSnapshot("4.17.20"),
    });
    expect(result.decisions.filter((row) => row.decision === "NEED_MANUAL")).toHaveLength(0);
  });
});
