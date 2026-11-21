/**
 * 依赖清单读取：从 package-lock.json 取出根依赖及其已安装版本。
 *
 * 只读 lockfile，不读 package.json 的范围声明——分诊判断的是「实际装了什么」，
 * 不是「允许装什么」。取不到已安装版本时直接失败，不做猜测。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface LockfileShape {
  packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

/** 一个已安装依赖。 */
export interface InstalledPackage {
  name: string;
  version: string;
}

export function readInstalledPackages(repoPath: string): InstalledPackage[] {
  const lockPath = join(repoPath, "package-lock.json");
  let parsed: LockfileShape;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockfileShape;
  } catch (error) {
    throw new Error(`无法读取 lockfile: path=${lockPath}, cause=${(error as Error).message}`);
  }

  const rootDependencies = parsed.packages?.[""]?.dependencies;
  if (!rootDependencies) return [];

  const installed: InstalledPackage[] = [];
  for (const name of Object.keys(rootDependencies)) {
    const entry = parsed.packages?.[`node_modules/${name}`];
    if (!entry?.version) {
      throw new Error(`lockfile 缺少已安装版本: package=${name}, path=${lockPath}`);
    }
    installed.push({ name, version: entry.version });
  }
  return installed;
}
