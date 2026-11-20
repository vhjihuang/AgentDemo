/**
 * 判定正确性用例骨架（AC-1 / AC-2 / AC-6 / AC-8）。
 *
 * 当前全部为 todo：实现落地后再补断言。
 * 每条 todo 的文案即验收条件，删除 todo 前不得改动语义。
 */
import { describe, test } from "vitest";

describe("判定正确性", () => {
  // 夹具 repo-A：lodash 4.17.20，显式调用 _.template
  test.todo("TC-01 版本命中且调用受影响 API → AFFECTED，且写入工单与证据");

  // 夹具 repo-B：lodash 4.17.20，声明依赖但未 import
  test.todo("TC-02 版本命中但未调用任何函数 → NOT_AFFECTED/NOT_CALLED，且不建工单");

  // 夹具 repo-C：lodash 4.17.21，显式调用 _.template
  test.todo("TC-03 部分修复版本 → r5fr 判 AFFECTED，xxjr 判 NOT_CALLED，且不读未命中源码");

  // 夹具 repo-D：动态 import
  test.todo("TC-04 动态引入不可解析 → NEED_MANUAL/DYN_IMPORT_UNRESOLVABLE，禁止猜测");

  test.todo("TC-10 版本区间边界 → 预发布版本与开闭区间的比较结果与 fixture 期望逐条一致");

  test.todo("TC-11 事件流完整 → osv_query → code_check → decision 顺序与 seq 单调递增");

  test.todo("TC-12 NEED_MANUAL 必须带枚举内原因码，空原因视为失败");
});
