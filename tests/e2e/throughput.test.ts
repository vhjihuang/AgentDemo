/**
 * 吞吐与排队用例骨架（AC-7）。
 *
 * 验证截断是「排队」而不是「丢弃」。
 */
import { describe, test } from "vitest";

describe("吞吐与排队", () => {
  test.todo("TC-08 50 条受影响 → 建单数不超过上限，其余为 PENDING/RATE_LIMIT 且可被 backlog 查询到");

  test.todo("TC-08b 释放槽位后 → 原本 deferred 的条目被补位处理，无记录永久停留 PENDING");
});
