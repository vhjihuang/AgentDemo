/**
 * 数据完整性与并发用例骨架（AC-3 / AC-9 / AC-10 / AC-12 / AC-13）。
 */
import { describe, test } from "vitest";

describe("数据完整性与并发", () => {
  test.todo("TC-06 重复运行同一夹具 → 工单数仍为 1，实际创建调用 0 次");

  test.todo("TC-13 处理中途强制退出后重启 → 已完成条目不复跑，RUNNING 超时回收后继续");

  test.todo("TC-14 两个 run 并发处理同一夹具 → 唯一约束生效，工单不重复且无未捕获异常");

  test.todo("TC-16 人工覆盖后再跑自动流程 → manuallyOverridden=1 的记录不被改写");

  test.todo("TC-17 缺少必需配置 → 启动失败且错误信息指明缺失项，不得用默认值静默运行");
});
