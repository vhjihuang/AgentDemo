/**
 * Fixture 自检。
 *
 * 目的不是测试业务逻辑，而是保证冻结数据本身可信：
 * manifest 中声明的漏洞、区间、已装版本，必须与 OSV 快照和仓库文件一致。
 * 这层如果错了，后面所有用例的期望值都不可信。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

interface Advisory {
  cve: string;
  summary: string;
  package: string;
  affectedFunctions: string[];
  range: { introduced: string; fixed: string | null };
}

interface Manifest {
  advisories: Record<string, Advisory>;
  repos: Record<
    string,
    { installedVersion: string; entryFile: string; expected: Array<{ advisory: string; decision: string; reason: string }> }
  >;
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...segments), "utf8")) as T;
}

const manifest = readJson<Manifest>("manifest.json");
const osvByVersion: Record<string, { vulns: Array<Record<string, unknown>> }> = {
  "4.17.20": readJson("osv", "lodash-4.17.20.json"),
  "4.17.21": readJson("osv", "lodash-4.17.21.json"),
};

/** 从 OSV 条目中取出适用于指定包的 SEMVER 区间。 */
function lodashRange(vuln: Record<string, unknown>): { introduced: string; fixed: string | null } | null {
  const affected = (vuln.affected as Array<Record<string, unknown>> | undefined) ?? [];
  const hit = affected.find(
    (a) => (a.package as Record<string, unknown> | undefined)?.name === "lodash"
  );
  if (!hit) return null;
  const ranges = (hit.ranges as Array<Record<string, unknown>> | undefined) ?? [];
  const semver = ranges.find((r) => r.type === "SEMVER");
  if (!semver) return null;
  const events = (semver.events as Array<Record<string, string>>) ?? [];
  const introduced = events.find((e) => "introduced" in e)?.introduced ?? "0";
  const fixed = events.find((e) => "fixed" in e)?.fixed ?? null;
  return { introduced, fixed };
}

describe("fixture 自检", () => {
  it("manifest 中每条 advisory 都能在对应版本的 OSV 快照中找到", () => {
    const found = new Map<string, Set<string>>();
    for (const [version, snapshot] of Object.entries(osvByVersion)) {
      found.set(version, new Set(snapshot.vulns.map((v) => String(v.id))));
    }

    for (const repo of Object.values(manifest.repos)) {
      const ids = found.get(repo.installedVersion);
      expect(ids, `缺少版本 ${repo.installedVersion} 的 OSV 快照`).toBeDefined();
      for (const item of repo.expected) {
        expect(
          ids!.has(item.advisory),
          `${item.advisory} 不在 ${repo.installedVersion} 的 OSV 快照中`
        ).toBe(true);
      }
    }
  });

  it("manifest 中的区间与 OSV 快照逐条一致", () => {
    const byId = new Map<string, Record<string, unknown>>();
    for (const snapshot of Object.values(osvByVersion)) {
      for (const vuln of snapshot.vulns) byId.set(String(vuln.id), vuln);
    }

    for (const [id, advisory] of Object.entries(manifest.advisories)) {
      const vuln = byId.get(id);
      expect(vuln, `OSV 快照中找不到 ${id}`).toBeDefined();
      expect(lodashRange(vuln!)).toEqual(advisory.range);
    }
  });

  it("每个仓库的 package.json 与 manifest 声明版本一致", () => {
    for (const [name, repo] of Object.entries(manifest.repos)) {
      const pkg = readJson<{ dependencies?: Record<string, string> }>("repos", name, "package.json");
      expect(pkg.dependencies?.lodash, `${name} 的 lodash 版本不一致`).toBe(repo.installedVersion);
    }
  });

  it("repo-A/C 确实 import 了 lodash，repo-B 没有", () => {
    const srcOf = (name: string, entry: string) =>
      readFileSync(join(FIXTURES, "repos", name, entry), "utf8");

    expect(srcOf("repo-A", manifest.repos["repo-A"].entryFile)).toMatch(/from\s+["']lodash["']/);
    expect(srcOf("repo-C", manifest.repos["repo-C"].entryFile)).toMatch(/from\s+["']lodash["']/);
    expect(srcOf("repo-B", manifest.repos["repo-B"].entryFile)).not.toMatch(/from\s+["']lodash["']/);
  });

  it("repo-D 使用动态 import，静态不可解析", () => {
    const src = readFileSync(
      join(FIXTURES, "repos", "repo-D", manifest.repos["repo-D"].entryFile),
      "utf8"
    );
    expect(src).toMatch(/import\s*\(\s*[A-Za-z_$]/);
  });

  it("每个 advisory 的 affectedFunctions 非空", () => {
    for (const [id, advisory] of Object.entries(manifest.advisories)) {
      expect(advisory.affectedFunctions.length, `${id} 缺少受影响函数`).toBeGreaterThan(0);
    }
  });

  it("实现侧的受影响函数映射与 manifest 完全一致", async () => {
    const { ADVISORY_FUNCTIONS } = await import("../../src/triage/advisory-functions.js");
    for (const [id, advisory] of Object.entries(manifest.advisories)) {
      expect(ADVISORY_FUNCTIONS[id], `实现侧缺少 ${id}`).toEqual(advisory.affectedFunctions);
    }
  });
});
