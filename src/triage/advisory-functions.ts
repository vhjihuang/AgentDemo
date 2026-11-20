/**
 * 漏洞到受影响函数的映射。
 *
 * OSV 数据不提供结构化的「影响了哪些函数」字段，这一层必须由本地知识库维护。
 * 生产环境的做法通常是定期同步商业漏洞库或人工审核，demo 阶段先静态维护。
 */
export const ADVISORY_FUNCTIONS: Record<string, string[]> = {
  // CVE-2020-28500 ReDoS
  "GHSA-29mw-wpgm-hmr9": ["toNumber", "trim", "trimEnd"],
  // CVE-2021-23337 template 命令注入
  "GHSA-35jh-r3h4-6jhm": ["template"],
  // CVE-2026-4800 template imports 代码注入
  "GHSA-r5fr-rjxr-66jc": ["template"],
  // CVE-2025-13465 原型污染
  "GHSA-xxjr-mmjv-4gpg": ["unset", "omit", "pullAt"],
};
