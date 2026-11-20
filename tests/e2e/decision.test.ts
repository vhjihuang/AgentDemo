/**
 * 判定正确性用例（AC-1 / AC-2 / AC-6 / AC-8）。
 *
 * TC-01 已落地为真实断言；其余仍为 todo，实现落地后逐个替换。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { triage } from "../../src/triage/index.js";
import {
  assertAffectedHasEvidence,
  assertAffectedHasTicket,
  assertNeedManualHasReason,
  assertNoDuplicateTickets,
  assertNoSilentDowngrade,
} from "../helpers/assertions.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

interface Manifest {
  repos: Record<
    string,
    {
      installedVersion: string;
      expected: Array<{ advisory: string; decision: string; reason: string }>;
    }
  >;
}

const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as Manifest;

/** 读取某个 fixture 仓库的 OSV 快照。 */
function loadSnapshot(version: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, "osv", `lodash-${version}.json`), "utf8"));
}

describe("判定正确性", () => {
  // 夹具 repo-A：lodash 4.17.20，显式调用 _.template
  test("TC-01 版本命中且调用受影响 API → AFFECTED，且写入工单与证据", () => {
    const expected = manifest.repos["repo-A"];
    const result = triage({
      repoPath: join(FIXTURES, "repos", "repo-A"),
      osvSnapshot: loadSnapshot("4.17.20"),
    });

    // 1. 每条漏洞的结论与 manifest 声明一致
    for (const item of expected.expected) {
      const row = result.decisions.find((d) => d.cveId === item.advisory);
      expect(row, `缺少 ${item.advisory} 的决策`).toBeDefined();
      expect(row!.decision, `${item.advisory} 结论不符`).toBe(item.decision);
      expect(row!.reason, `${item.advisory} 原因码不符`).toBe(item.reason);
    }

    // 2. 只有 AFFECTED 才建单
    const affectedIds = expected.expected
      .filter((item) => item.decision === "AFFECTED")
      .map((item) => item.advisory)
      .sort();
    expect(result.tickets.map((t) => t.cveId).sort()).toEqual(affectedIds);

    // 3. AFFECTED 必须带证据，且证据指向真实调用点
    const affectedRows = result.decisions.filter((d) => d.decision === "AFFECTED");
    expect(affectedRows.length).toBe(affectedIds.length);
    for (const row of affectedRows) {
      expect(row.evidence, `${row.cveId} 缺少证据`).not.toBeNull();
      const [site] = row.evidence!.callSites;
      expect(site.file).toBe("src/notify.js");
      expect(site.symbol).toBe("template");
      expect(site.line).toBeGreaterThan(0);
      expect(row.evidence!.versionCheck.installed).toBe("4.17.20");
    }

    // 4. 不变式
    assertNoSilentDowngrade(result.decisions);
    assertAffectedHasTicket(result.decisions, result.tickets);
    assertNoDuplicateTickets(result.tickets);
    assertAffectedHasEvidence(result.decisions);
  });

  // 夹具 repo-B：lodash 4.17.20，声明依赖但未 import
  test("TC-02 版本命中但未调用任何函数 → NOT_AFFECTED/NOT_CALLED，且不建工单", () => {
    const expected = manifest.repos["repo-B"];
    const result = triage({
      repoPath: join(FIXTURES, "repos", "repo-B"),
      osvSnapshot: loadSnapshot("4.17.20"),
    });

    expect(result.decisions).toHaveLength(expected.expected.length);
    for (const item of expected.expected) {
      const row = result.decisions.find((d) => d.cveId === item.advisory);
      expect(row, `缺少 ${item.advisory} 的决策`).toBeDefined();
      expect(row!.decision, `${item.advisory} 结论不符`).toBe(item.decision);
      expect(row!.reason, `${item.advisory} 原因码不符`).toBe(item.reason);
    }

    // 仅声明依赖不得产生任何工单
    expect(result.tickets).toHaveLength(0);
    assertNoSilentDowngrade(result.decisions);
  });

  // 夹具 repo-C：lodash 4.17.21，显式调用 _.template
  test("TC-03 部分修复版本 → r5fr 判 AFFECTED，xxjr 判 NOT_CALLED，已修复漏洞不出现在结果中", () => {
    const expected = manifest.repos["repo-C"];
    const result = triage({
      repoPath: join(FIXTURES, "repos", "repo-C"),
      osvSnapshot: loadSnapshot("4.17.21"),
    });

    // 4.17.21 的 OSV 结果只含 r5fr 与 xxjr，已修复的 29mw/35jh 不得出现
    expect(result.decisions.map((d) => d.cveId).sort()).toEqual(
      expected.expected.map((item) => item.advisory).sort()
    );

    for (const item of expected.expected) {
      const row = result.decisions.find((d) => d.cveId === item.advisory);
      expect(row!.decision, `${item.advisory} 结论不符`).toBe(item.decision);
      expect(row!.reason, `${item.advisory} 原因码不符`).toBe(item.reason);
    }

    // 同版本下只有仍受影响且被调用的 r5fr 建单
    expect(result.tickets.map((t) => t.cveId)).toEqual(["GHSA-r5fr-rjxr-66jc"]);
    expect(result.tickets[0].fixVersion).toBe("4.18.0");
  });

  // 夹具 repo-D：动态 import
  test("TC-04 动态引入不可解析 → NEED_MANUAL/DYN_IMPORT_UNRESOLVABLE，禁止猜测", () => {
    const expected = manifest.repos["repo-D"];
    const result = triage({
      repoPath: join(FIXTURES, "repos", "repo-D"),
      osvSnapshot: loadSnapshot("4.17.20"),
    });

    expect(result.decisions).toHaveLength(expected.expected.length);
    for (const item of expected.expected) {
      const row = result.decisions.find((d) => d.cveId === item.advisory);
      expect(row, `缺少 ${item.advisory} 的决策`).toBeDefined();
      expect(row!.decision, `${item.advisory} 结论不符`).toBe(item.decision);
      expect(row!.reason, `${item.advisory} 原因码不符`).toBe(item.reason);
    }

    // 无法判定时不得建单，也不得冒充不受影响
    expect(result.tickets).toHaveLength(0);
    assertNeedManualHasReason(result.decisions);
  });

});
