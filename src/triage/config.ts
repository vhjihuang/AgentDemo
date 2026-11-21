/**
 * 运行期配置与启动期校验。
 *
 * AC-13 要求「阈值、重试上限、建单上限必须显式配置」，
 * 因此这三个键没有隐式回退：缺失即启动失败。
 * 其余键在 SPEC §7 有安全默认值，仅在显式提供时覆盖。
 */

/** 配置对象。字段名用 camelCase，环境变量键名保持 UPPER_SNAKE。 */
export interface TriageConfig {
  retryMax: number;
  retryBaseMs: number;
  /** 未关闭工单总量上限（WIP 限制）。名字必须与语义一致：不是「单轮建单数」。 */
  maxOpenTickets: number;
  runningTimeoutMs: number;
  maxRounds: number;
  circuitBreakerThreshold: number;
  /** 熔断打开后多久允许一次试探（HALF_OPEN）。 */
  circuitBreakerResetMs: number;
}

/** 必须显式提供、缺失即启动失败的键。 */
export const REQUIRED_CONFIG_KEYS = [
  "RETRY_MAX",
  "MAX_OPEN_TICKETS",
  "CIRCUIT_BREAKER_THRESHOLD",
] as const;

export type RequiredConfigKey = (typeof REQUIRED_CONFIG_KEYS)[number];

/** 配置校验失败。missing / invalid 携带具体键名，便于运维直接定位。 */
export class ConfigError extends Error {
  readonly missing: string[];
  readonly invalid: string[];

  constructor(missing: string[], invalid: string[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`缺少必需配置: ${missing.join(", ")}`);
    if (invalid.length > 0) parts.push(`配置值非法: ${invalid.join(", ")}`);
    super(`配置校验失败 — ${parts.join("；")}`);
    this.name = "ConfigError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

interface Binding {
  readonly key: string;
  readonly field: keyof TriageConfig;
  /** 允许的最小值（含）。 */
  readonly min: number;
}

const BINDINGS: readonly Binding[] = [
  { key: "RETRY_MAX", field: "retryMax", min: 1 },
  { key: "RETRY_BASE_MS", field: "retryBaseMs", min: 0 },
  { key: "MAX_OPEN_TICKETS", field: "maxOpenTickets", min: 1 },
  { key: "RUNNING_TIMEOUT_MS", field: "runningTimeoutMs", min: 1 },
  { key: "MAX_ROUNDS", field: "maxRounds", min: 1 },
  { key: "CIRCUIT_BREAKER_THRESHOLD", field: "circuitBreakerThreshold", min: 1 },
  { key: "CIRCUIT_BREAKER_RESET_MS", field: "circuitBreakerResetMs", min: 1 },
];

/** SPEC §7 的默认值。仅用于测试与本地运行，生产入口必须走 loadConfig。 */
export function createDefaultConfig(): TriageConfig {
  return {
    retryMax: 3,
    retryBaseMs: 200,
    maxOpenTickets: 10,
    runningTimeoutMs: 600_000,
    maxRounds: 10,
    circuitBreakerThreshold: 5,
    circuitBreakerResetMs: 30_000,
  };
}

/**
 * 从环境变量构造配置。
 *
 * @throws ConfigError 缺少必需键或存在非法数值时抛出，不做静默兜底。
 */
export function loadConfig(env: Record<string, string | undefined>): TriageConfig {
  const config = createDefaultConfig();
  const missing: string[] = [];
  const invalid: string[] = [];
  const requiredKeys = new Set<string>(REQUIRED_CONFIG_KEYS);

  for (const binding of BINDINGS) {
    const raw = env[binding.key];
    if (raw === undefined || raw.trim() === "") {
      if (requiredKeys.has(binding.key)) missing.push(binding.key);
      continue;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < binding.min) {
      invalid.push(`${binding.key}=${raw}（期望整数且 >= ${binding.min}）`);
      continue;
    }
    config[binding.field] = value;
  }

  if (missing.length > 0 || invalid.length > 0) {
    throw new ConfigError(missing, invalid);
  }
  return config;
}
