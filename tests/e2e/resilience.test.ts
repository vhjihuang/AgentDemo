/**
 * 失败与降级用例骨架（AC-4 / AC-5 / AC-11）。
 *
 * 重点不是「能成功」，而是「失败时不得伪装成成功」。
 */
import { describe, test } from "vitest";

describe("失败与降级", () => {
  test.todo("TC-05 数据源前两次超时、第三次成功 → RETRYING 后 SUCCEEDED，retryCount=2");

  test.todo("TC-05b 数据源持续超时 → FAILED_PERMANENT 且 decision=null，全表无 NOT_AFFECTED");

  test.todo("TC-07 建单前两次 500、第三次成功 → 最终仅 1 张工单");

  test.todo("TC-07b 建单持续失败 → decision=AFFECTED 但 executionStatus=FAILED_PERMANENT，无工单");

  test.todo("TC-09 代码检查返回空 → 禁止 AFFECTED，转 NEED_MANUAL/EVIDENCE_MISSING");

  test.todo("TC-15 Agent 循环达到 MAX_ROUNDS → 终止并给出 MAX_ROUNDS_EXCEEDED，不得挂起");
});
