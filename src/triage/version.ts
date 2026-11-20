/**
 * 最小 semver 实现。
 *
 * 只覆盖 OSV 区间判定所需的能力：X.Y.Z 与预发布后缀的比较。
 * 不支持 build metadata、通配符与范围表达式——用到时再扩展，
 * 不要在需要之前提前实现。
 */

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 解析 X.Y.Z[-prerelease]，非法输入直接抛出带上下文的错误。 */
export function parseVersion(input: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) {
    throw new Error(`无法解析版本号: "${input}"，仅支持 X.Y.Z[-prerelease] 格式`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

/** 比较两个预发布标识段：数字段按数值比较，字符串段按字典序。 */
function comparePrerelease(a: ParsedVersion, b: ParsedVersion): number {
  // 无预发布后缀的版本更高（4.17.21 > 4.17.21-rc.1）
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left - right;
    // 数字标识段的优先级低于字符串标识段
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** 返回负数表示 a < b，0 表示相等，正数表示 a > b。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  return comparePrerelease(left, right);
}

/** OSV 的受影响区间：introduced 为下界（含），fixed 为上界（不含）。 */
export interface AffectedRange {
  introduced: string;
  fixed: string | null;
}

/**
 * 判断已安装版本是否落在受影响区间内。
 * introduced 为 "0" 表示自最早版本起即受影响。
 */
export function isVersionAffected(installed: string, range: AffectedRange): boolean {
  const lowerOk = range.introduced === "0" || compareVersions(installed, range.introduced) >= 0;
  const upperOk = range.fixed === null || compareVersions(installed, range.fixed) < 0;
  return lowerOk && upperOk;
}
