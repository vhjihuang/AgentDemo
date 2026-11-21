/**
 * 离线回归评测脚本。
 *
 * 在冻结 fixture 上逐个仓库运行 triage()，把实际结论与 manifest 的人工期望逐条比对，
 * 并按仓库输出指标、写入 eval/report.json。全程不联网，不使用实时 OSV。
 *
 * 边界：这是 fixture 上的回归评测，不代表线上准确率。
 * 能力边界：usage-based filtering（使用面过滤），不是 reachability analysis。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { triage } from "../src/triage/index.js";
import type { TriageResult } from "../src/triage/index.js";
import {
  assertAffectedHasEvidence,
  assertAffectedHasTicket,
  assertDeferredWellFormed,
  assertNeedManualHasReason,
  assertNoDuplicateTickets,
  assertNoSilentDowngrade,
} from "../tests/helpers/assertions.js";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const REPORT_PATH = join(ROOT, "eval", "report.json");

interface ExpectedEntry {
  advisory: string;
  decision: string;
  reason: string;
}

interface ManifestRepo {
  installedVersion: string;
  entryFile: string;
  expected: ExpectedEntry[];
}

interface Manifest {
  repos: Record<string, ManifestRepo>;
}

interface EntryReport {
  advisory: string;
  expectedDecision: string;
  actualDecision: string | null;
  expectedReason: string;
  actualReason: string | null;
  decisionOk: boolean;
  reasonOk: boolean;
  /** 期望受影响但未判受影响。 */
  missed: boolean;
  /** 期望不受影响（或需人工）却被判受影响。 */
  falsePositive: boolean;
  /** 一条记录命中的全部问题，供终端展示。 */
  issues: string[];
}

interface InvariantReport {
  name: string;
  ok: boolean;
  message: string | null;
}

interface RepoReport {
  repo: string;
  installedVersion: string;
  expectedEntries: number;
  decisionCorrect: number;
  reasonCorrect: number;
  missed: number;
  falsePositives: number;
  /** 结果中出现但 manifest 未声明的 vulnerability。 */
  unexpected: string[];
  invariants: InvariantReport[];
  entries: EntryReport[];
  tickets: number;
  passed: boolean;
  runError: string | null;
}

interface Summary {
  reposTotal: number;
  reposPassed: number;
  totalEntries: number;
  decisionCorrect: number;
  reasonCorrect: number;
  missed: number;
  falsePositives: number;
  unexpectedEntries: number;
  invariantFailures: number;
  passed: boolean;
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(...segments), "utf8")) as T;
}

/** 逐条比对单个仓库的期望与实际结论。 */
function compareEntries(
  expected: ExpectedEntry[],
  result: TriageResult | null
): EntryReport[] {
  const rows = result?.decisions ?? [];
  return expected.map((item) => {
    const row = rows.find((d) => d.cveId === item.advisory) ?? null;
    const actualDecision = row ? row.decision : null;
    const actualReason = row ? row.reason : null;
    const decisionOk = actualDecision === item.decision;
    const reasonOk = actualReason === item.reason;
    const missed = item.decision === "AFFECTED" && actualDecision !== "AFFECTED";
    const falsePositive = item.decision !== "AFFECTED" && actualDecision === "AFFECTED";

    const issues: string[] = [];
    if (!row) issues.push("缺失");
    else if (missed) issues.push("漏判");
    else if (falsePositive) issues.push("误判");
    else if (!decisionOk) issues.push("结论不符");
    if (row && !reasonOk) issues.push("原因码不符");

    return {
      advisory: item.advisory,
      expectedDecision: item.decision,
      actualDecision,
      expectedReason: item.reason,
      actualReason,
      decisionOk,
      reasonOk,
      missed,
      falsePositive,
      issues,
    };
  });
}

/** 依次执行不变式断言，单项失败不影响其余项。 */
function checkInvariants(result: TriageResult): InvariantReport[] {
  const checks: Array<{ name: string; run: () => void }> = [
    { name: "assertNoSilentDowngrade", run: () => assertNoSilentDowngrade(result.decisions) },
    {
      name: "assertAffectedHasTicket",
      run: () => assertAffectedHasTicket(result.decisions, result.tickets),
    },
    { name: "assertNoDuplicateTickets", run: () => assertNoDuplicateTickets(result.tickets) },
    { name: "assertNeedManualHasReason", run: () => assertNeedManualHasReason(result.decisions) },
    { name: "assertAffectedHasEvidence", run: () => assertAffectedHasEvidence(result.decisions) },
    { name: "assertDeferredWellFormed", run: () => assertDeferredWellFormed(result.decisions) },
  ];

  return checks.map(({ name, run }) => {
    try {
      run();
      return { name, ok: true, message: null };
    } catch (error) {
      return { name, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
}

async function evalRepo(name: string, repo: ManifestRepo): Promise<RepoReport> {
  const repoPath = join(FIXTURES, "repos", name);
  const snapshotPath = join(FIXTURES, "osv", `lodash-${repo.installedVersion}.json`);

  let result: TriageResult | null = null;
  let runError: string | null = null;
  let snapshot: unknown = null;

  try {
    snapshot = readJson<unknown>(snapshotPath);
    result = await triage({ repoPath, osvSnapshot: snapshot });
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }

  const entries = compareEntries(repo.expected, result);
  const expectedAdvisories = new Set(repo.expected.map((item) => item.advisory));
  const unexpected = (result?.decisions ?? [])
    .filter((row) => !expectedAdvisories.has(row.cveId))
    .map((row) => `${row.cveId}(${row.decision ?? "null"})`);

  const invariants = result
    ? checkInvariants(result)
    : [{ name: "triage_run", ok: false, message: runError ?? "未产生运行结果" }];

  const decisionCorrect = entries.filter((e) => e.decisionOk).length;
  const reasonCorrect = entries.filter((e) => e.reasonOk).length;
  const missed = entries.filter((e) => e.missed).length;
  const falsePositives = entries.filter((e) => e.falsePositive).length;
  const passed =
    !runError &&
    entries.every((e) => e.decisionOk && e.reasonOk) &&
    unexpected.length === 0 &&
    invariants.every((i) => i.ok);

  return {
    repo: name,
    installedVersion: repo.installedVersion,
    expectedEntries: entries.length,
    decisionCorrect,
    reasonCorrect,
    missed,
    falsePositives,
    unexpected,
    invariants,
    entries,
    tickets: result?.tickets.length ?? 0,
    passed,
    runError,
  };
}

/** 终端显示宽度：CJK 字符占两列，保证纯文本表格对齐。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x20000 && code <= 0x3fffd));
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function printTable(reports: RepoReport[]): void {
  const headers = ["仓库", "漏洞", "期望结论", "实际结论", "期望原因码", "实际原因码", "结果"];
  const rows: string[][] = [];
  for (const report of reports) {
    for (const entry of report.entries) {
      const resultText =
        entry.issues.length === 0 ? "通过" : entry.issues.join("/");
      rows.push([
        report.repo,
        entry.advisory,
        entry.expectedDecision,
        entry.actualDecision ?? "(缺失)",
        entry.expectedReason,
        entry.actualReason ?? "(缺失)",
        resultText,
      ]);
    }
    if (report.unexpected.length > 0) {
      rows.push([report.repo, report.unexpected.join(","), "-", "未声明", "-", "-", "意外条目"]);
    }
  }

  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index])))
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => pad(cell, widths[index])).join("  ").trimEnd();

  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));

  let currentRepo = "";
  for (const row of rows) {
    if (currentRepo !== "" && row[0] !== currentRepo) {
      console.log(widths.map((w) => "-".repeat(w)).join("  "));
    }
    currentRepo = row[0];
    console.log(line(row));
  }
}

function printSummary(summary: Summary, reports: RepoReport[]): void {
  console.log("");
  console.log("=== 汇总 ===");
  console.log(`仓库：${summary.reposPassed}/${summary.reposTotal} 通过`);
  console.log(
    `条目：${summary.totalEntries} 条，判定正确 ${summary.decisionCorrect}，原因码正确 ${summary.reasonCorrect}`
  );
  console.log(
    `漏判 ${summary.missed}，误判 ${summary.falsePositives}，意外条目 ${summary.unexpectedEntries}，不变式失败 ${summary.invariantFailures}`
  );

  const invariantFailures = reports.flatMap((report) =>
    report.invariants.filter((item) => !item.ok).map((item) => ({ repo: report.repo, item }))
  );
  if (invariantFailures.length > 0) {
    console.log("");
    console.log("=== 不变式失败 ===");
    for (const { repo, item } of invariantFailures) {
      console.log(`[${repo}] ${item.name}: ${item.message ?? "失败"}`);
    }
  }
}

async function main(): Promise<void> {
  const manifest = readJson<Manifest>(FIXTURES, "manifest.json");
  const reports: RepoReport[] = [];

  for (const [name, repo] of Object.entries(manifest.repos)) {
    reports.push(await evalRepo(name, repo));
  }

  const summary: Summary = {
    reposTotal: reports.length,
    reposPassed: reports.filter((r) => r.passed).length,
    totalEntries: reports.reduce((n, r) => n + r.expectedEntries, 0),
    decisionCorrect: reports.reduce((n, r) => n + r.decisionCorrect, 0),
    reasonCorrect: reports.reduce((n, r) => n + r.reasonCorrect, 0),
    missed: reports.reduce((n, r) => n + r.missed, 0),
    falsePositives: reports.reduce((n, r) => n + r.falsePositives, 0),
    unexpectedEntries: reports.reduce((n, r) => n + r.unexpected.length, 0),
    invariantFailures: reports.reduce(
      (n, r) => n + r.invariants.filter((i) => !i.ok).length,
      0
    ),
    passed: reports.every((r) => r.passed),
  };

  console.log("=== 离线评测（冻结 fixture 回归）===");
  console.log("");
  printTable(reports);
  printSummary(summary, reports);

  const report = {
    generatedAt: new Date().toISOString(),
    scope: "tests/fixtures 冻结数据上的回归评测，不是线上准确率",
    summary,
    repos: reports,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("");
  console.log(`报告已写入 ${REPORT_PATH}`);

  if (!summary.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[eval] 评测脚本异常: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
