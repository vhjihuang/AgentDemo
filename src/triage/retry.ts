/**
 * 通用重试工具。
 *
 * 语义约定：
 *   - maxAttempts 是「总尝试次数」，包含首次调用
 *   - 失败的 attempts 次调用后抛出 RetryExhaustedError
 *   - 退避采用指数增长并叠加少量抖动，避免多个调用方同步重试形成尖峰
 */
import type { RetryPolicy } from "./ports.js";

/** 重试耗尽后的错误，携带实际尝试次数与最后一次失败原因。 */
export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    super(`重试 ${attempts} 次后仍失败: ${reason}`);
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export interface RetryOutcome<T> {
  value: T;
  /** 实际尝试次数，1 表示首次即成功。 */
  attempts: number;
}

/** 按策略执行任务，失败则退避重试。 */
export async function withRetry<T>(
  task: () => Promise<T>,
  policy: RetryPolicy
): Promise<RetryOutcome<T>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return { value: await task(), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === policy.maxAttempts) break;

      const base = policy.baseDelayMs * 2 ** (attempt - 1);
      const jitter = base > 0 ? Math.floor(Math.random() * base * 0.1) : 0;
      await policy.sleep(base + jitter);
    }
  }

  throw new RetryExhaustedError(policy.maxAttempts, lastError);
}
