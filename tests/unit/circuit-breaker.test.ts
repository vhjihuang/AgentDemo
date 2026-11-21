/**
 * 熔断器状态机用例。
 *
 * 验证的是「下游不可用时快速失败、冷却后有限试探、试探成功即恢复」，
 * 时钟通过注入推进，不依赖真实等待。
 */
import { describe, expect, test } from "vitest";
import {
  CircuitOpenError,
  createCircuitBreaker,
} from "../../src/triage/circuit-breaker.js";

function failing(): Promise<never> {
  return Promise.reject(new Error("下游 503"));
}

describe("熔断器", () => {
  test("连续失败达到阈值 → OPEN，后续调用直接拒绝且不再触达下游", async () => {
    const clock = { value: 0 };
    const breaker = createCircuitBreaker({ threshold: 3, resetTimeoutMs: 1_000, now: () => clock.value });
    let downstreamCalls = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        breaker.execute(async () => {
          downstreamCalls += 1;
          throw new Error("下游 503");
        })
      ).rejects.toThrow("下游 503");
    }

    expect(breaker.state()).toBe("OPEN");
    expect(downstreamCalls).toBe(3);

    // 打开后必须快速失败，不得再打下游
    await expect(
      breaker.execute(async () => {
        downstreamCalls += 1;
        return "ok";
      })
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(downstreamCalls).toBe(3);
  });

  test("冷却结束 → HALF_OPEN 放行一次试探，成功即恢复 CLOSED", async () => {
    const clock = { value: 0 };
    const breaker = createCircuitBreaker({ threshold: 2, resetTimeoutMs: 1_000, now: () => clock.value });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(breaker.execute(failing)).rejects.toThrow();
    }
    expect(breaker.state()).toBe("OPEN");

    clock.value = 1_000;
    expect(breaker.state()).toBe("HALF_OPEN");

    await expect(breaker.execute(async () => "recovered")).resolves.toBe("recovered");
    expect(breaker.state()).toBe("CLOSED");
  });

  test("HALF_OPEN 试探失败 → 重新 OPEN，冷却时间重新计算", async () => {
    const clock = { value: 0 };
    const breaker = createCircuitBreaker({ threshold: 2, resetTimeoutMs: 1_000, now: () => clock.value });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(breaker.execute(failing)).rejects.toThrow();
    }

    clock.value = 1_000;
    await expect(breaker.execute(failing)).rejects.toThrow();

    expect(breaker.state()).toBe("OPEN");
    clock.value = 1_500;
    expect(breaker.state()).toBe("OPEN");
    clock.value = 2_000;
    expect(breaker.state()).toBe("HALF_OPEN");
  });

  test("成功调用会清零连续失败计数，偶发失败不触发熔断", async () => {
    const clock = { value: 0 };
    const breaker = createCircuitBreaker({ threshold: 3, resetTimeoutMs: 1_000, now: () => clock.value });

    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();
    await breaker.execute(async () => "ok");
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();

    expect(breaker.state()).toBe("CLOSED");
  });
});
