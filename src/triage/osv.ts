/**
 * OSV 快照解析：从冻结数据中筛出适用于指定包、且版本命中的漏洞。
 *
 * OSV 的 query 结果里，每条 vuln 的 affected 会同时列出多个包
 * （如 lodash、lodash-es、lodash.template）。因此必须按包名重新筛选，
 * 不能直接把 query 结果当作「当前包受影响」。
 */
import { isVersionAffected, type AffectedRange } from "./version.js";

/** 一条命中当前包与当前版本的漏洞。 */
export interface AdvisoryMatch {
  /** OSV 标识，通常是 GHSA-xxxx。 */
  advisoryId: string;
  aliases: string[];
  /** 该漏洞影响的函数名，用于调用面判定。 */
  affectedFunctions: string[];
  range: AffectedRange;
}

interface OsvRange {
  type?: string;
  events?: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
}

interface OsvAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: OsvRange[];
}

interface OsvVuln {
  id?: string;
  aliases?: string[];
  affected?: OsvAffected[];
}

interface OsvSnapshot {
  vulns?: OsvVuln[];
}

/** 从 OSV 的 SEMVER 区间中提取 introduced / fixed，忽略 last_affected 形式。 */
function extractRange(vuln: OsvVuln, packageName: string): AffectedRange | null {
  const affected = vuln.affected ?? [];
  const hit = affected.find((entry) => entry.package?.name === packageName);
  if (!hit) return null;
  const semver = (hit.ranges ?? []).find((range) => range.type === "SEMVER");
  if (!semver) return null;

  const events = semver.events ?? [];
  const introduced = events.find((event) => event.introduced !== undefined)?.introduced;
  const fixed = events.find((event) => event.fixed !== undefined)?.fixed ?? null;
  if (introduced === undefined) return null;
  return { introduced, fixed };
}

/** OSV 数据里没有结构化的受影响函数列表，需由本地知识库补齐。 */
export interface AdvisoryFunctionIndex {
  [advisoryId: string]: string[];
}

/**
 * 从快照中筛选适用于 packageName、且 installedVersion 命中的漏洞。
 *
 * @param snapshot OSV query 的冻结结果
 * @param packageName 目标包名
 * @param installedVersion 已安装版本
 * @param functions 漏洞到受影响函数的映射
 */
export function matchAdvisories(
  snapshot: unknown,
  packageName: string,
  installedVersion: string,
  functions: AdvisoryFunctionIndex
): AdvisoryMatch[] {
  const data = snapshot as OsvSnapshot;
  if (!data || !Array.isArray(data.vulns)) {
    throw new Error(`OSV 快照格式非法: 缺少 vulns 数组, package=${packageName}`);
  }

  const matches: AdvisoryMatch[] = [];
  for (const vuln of data.vulns) {
    if (!vuln.id) continue;
    const range = extractRange(vuln, packageName);
    if (!range) continue;
    if (!isVersionAffected(installedVersion, range)) continue;

    const affectedFunctions = functions[vuln.id];
    if (!affectedFunctions || affectedFunctions.length === 0) {
      // 缺少受影响函数信息时无法做调用面判定，不能静默跳过
      throw new Error(`缺少漏洞函数映射: advisory=${vuln.id}, package=${packageName}`);
    }

    matches.push({
      advisoryId: vuln.id,
      aliases: vuln.aliases ?? [],
      affectedFunctions,
      range,
    });
  }
  return matches;
}
