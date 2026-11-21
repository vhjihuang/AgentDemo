/**
 * 熔断器（三态：CLOSED / OPEN / HALF_OPEN）。
 *
 * 目的不是重试，而是「下游已经明确不可用时，别再打它」。
 * 与 withRetry 的组合顺序固定为：熔断在外、重试在内——
 * 否则熔断打开后仍会被重试层白打若干次，等于没熔断。
 *
 * SPEC §7 要求按数据源整体共享一个实例，不为单条漏洞独立熔断。
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** 熔断期间调用被拒绝。携带剩余冷却时间，便于上层区分「不可用」与「这次失败」。 */
export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`数据源熔断中，${retryAfterMs}ms 后允许试探`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CircuitBreakerOptions {
  /** 连续失败达到该次数后打开熔断。 */
  threshold: number;
  /** OPEN 状态持续多久后进入 HALF_OPEN 试探。 */
  resetTimeoutMs: number;
  now?: () => number;
}

export interface CircuitBreaker {
  state(): CircuitState;
  execute<T>(task: () => Promise<T>): Promise<T>;
}

export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const now = options.now ?? (() => Date.now());

  let state: CircuitState = "CLOSED";
  let consecutiveFailures = 0;
  let openedAt = 0;
  let halfOpenTrialInFlight = false;

  /** OPEN 冷却结束后允许进入 HALF_OPEN；试探失败会重新打开。 */
  const refresh = (): void => {
    if (state === "OPEN" && now() - openedAt >= options.resetTimeoutMs) {
      state = "HALF_OPEN";
      halfOpenTrialInFlight = false;
    }
  };

  const open = (): void => {
    state = "OPEN";
    openedAt = now();
    halfOpenTrialInFlight = false;
  };

  return {
    state: () => {
      refresh();
      return state;
    },

    async execute<T>(task: () => Promise<T>): Promise<T> {
      refresh();

      if (state === "OPEN") {
        throw new CircuitOpenError(options.resetTimeoutMs - (now() - openedAt));
      }

      // HALF_OPEN 只放行一个试探请求，避免恢复瞬间被并发打满
      if (state === "HALF_OPEN") {
        if (halfOpenTrialInFlight) {
          throw new CircuitOpenError(options.resetTimeoutMs);
        }
        halfOpenTrialInFlight = true;
      }

      try {
        const result = await task();
        consecutiveFailures = 0;
        state = "CLOSED";
        halfOpenTrialInFlight = false;
        return result;
      } catch (error) {
        consecutiveFailures += 1;
        if (state === "HALF_OPEN" || consecutiveFailures >= options.threshold) {
          open();
        } else {
          halfOpenTrialInFlight = false;
        }
        throw error;
      }
    },
  };
}
