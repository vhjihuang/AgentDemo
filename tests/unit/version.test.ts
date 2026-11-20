/**
 * TC-10 版本区间边界（AC-1）。
 *
 * 用 manifest 中声明的真实 OSV 区间做表驱动校验。
 * 预发布版本比较是自研 semver 最易出错的地方，单独覆盖。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compareVersions, isVersionAffected } from "../../src/triage/version.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

interface Manifest {
  advisories: Record<string, { range: { introduced: string; fixed: string | null } }>;
}

const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as Manifest;

describe("TC-10 版本区间边界", () => {
  test("OSV 区间判定与 fixture 期望逐条一致", () => {
    const cases = [
      // 35jh: introduced 0（自最早版本起受影响）, fixed 4.17.21
      { advisory: "GHSA-35jh-r3h4-6jhm", version: "3.10.1", expected: true },
      { advisory: "GHSA-35jh-r3h4-6jhm", version: "4.17.20", expected: true },
      { advisory: "GHSA-35jh-r3h4-6jhm", version: "4.17.21", expected: false },
      // 29mw: introduced 4.0.0（含）, fixed 4.17.21（不含）
      { advisory: "GHSA-29mw-wpgm-hmr9", version: "3.10.1", expected: false },
      { advisory: "GHSA-29mw-wpgm-hmr9", version: "4.0.0", expected: true },
      { advisory: "GHSA-29mw-wpgm-hmr9", version: "4.17.21", expected: false },
      // r5fr: [4.0.0, 4.18.0)
      { advisory: "GHSA-r5fr-rjxr-66jc", version: "4.17.21", expected: true },
      { advisory: "GHSA-r5fr-rjxr-66jc", version: "4.18.0", expected: false },
      // xxjr: [4.0.0, 4.17.23)
      { advisory: "GHSA-xxjr-mmjv-4gpg", version: "4.17.22", expected: true },
      { advisory: "GHSA-xxjr-mmjv-4gpg", version: "4.17.23", expected: false },
      // 预发布版本低于对应的正式版本，仍落在区间内
      { advisory: "GHSA-35jh-r3h4-6jhm", version: "4.17.21-rc.1", expected: true },
    ];

    for (const item of cases) {
      const range = manifest.advisories[item.advisory].range;
      expect(
        isVersionAffected(item.version, range),
        `${item.advisory} @ ${item.version} 期望 ${item.expected}`
      ).toBe(item.expected);
    }
  });

  test("预发布版本比较符合 semver 语义", () => {
    expect(compareVersions("4.17.21-rc.1", "4.17.21")).toBeLessThan(0);
    expect(compareVersions("4.17.21-rc.1", "4.17.21-rc.2")).toBeLessThan(0);
    expect(compareVersions("4.17.21", "4.17.21-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("4.17.21", "4.17.21")).toBe(0);
    expect(compareVersions("4.18.0", "4.17.23")).toBeGreaterThan(0);
    // 数字标识段优先级低于字符串标识段
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });
});
