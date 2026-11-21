# 依赖漏洞影响面分诊：验收规格

> 本文是验收的唯一权威来源。测试用例编号、期望状态、原因码枚举均以此处为准；
> 与对话记录冲突时，以本文为准。

## 1. 目标与范围

输入一个 npm 项目仓库（`package.json` + `package-lock.json` + 源码）和一份冻结的 OSV 查询结果，
输出每个漏洞的处置结论，并在结论为「受影响」时创建修复工单。

系统要解决的核心问题不是「发现了多少漏洞」，而是**在几百条告警里判断哪些真的需要修**。

## 2. 能力声明（必须先读）

本系统的调用面判定是 **usage-based filtering（使用面过滤）**，不是可达性分析。

| 覆盖 | 不覆盖 |
|------|--------|
| 单文件内的显式调用 | 跨文件调用链 |
| 一层 `import` / `require` 声明 | 动态 `import()`、`require(变量)` |
| 静态可解析的函数引用 | 反射、依赖注入、运行时拼接 |
| `lodash/x` 子路径导入 | 打包器 tree-shaking 后的真实运行时 |

**任何文档、README、演示中不得声称本系统做了 reachability analysis。**
声称超出实际能力，是本项目最大的可信度风险。

## 3. 状态模型

三个正交维度，不得合并成一个枚举：

| 维度 | 取值 | 语义 |
|------|------|------|
| `decision` | `AFFECTED` / `NOT_AFFECTED` / `NEED_MANUAL` / `null` | 业务结论，`null` 表示未得出结论 |
| `executionStatus` | `PENDING` / `RUNNING` / `RETRYING` / `SUCCEEDED` / `FAILED_PERMANENT` | 系统执行到哪一步 |
| `deferReason` | `RATE_LIMIT` / `BACKLOG` / `null` | 尚未开始的原因，仅 `PENDING` 时允许非空 |

### 不变式

1. `NOT_AFFECTED` 只能出现在 `executionStatus = SUCCEEDED`。
2. `decision != null` 必须伴随 `executionStatus ∈ {SUCCEEDED, FAILED_PERMANENT}`。
3. `deferReason != null` 必须伴随 `executionStatus = PENDING`。
4. 判定为 `AFFECTED` 且 `SUCCEEDED` 的记录，必须存在对应工单。
5. 同一 `(cveId, package)` 不得存在多张工单。
6. `NEED_MANUAL` 必须带非空 `reason`。
7. `AFFECTED` 必须带非空 `evidence`。
8. `manuallyOverridden = true` 的记录不得被自动流程改写。

## 4. 数据契约

```
vulnerability_decisions(
  cve_id, package, installed_version,   -- 幂等键
  decision, execution_status, defer_reason,
  reason, evidence_json,
  retry_count, next_retry_at, last_error,
  priority_score,                        -- 仅用于排序，不参与 decision 计算
  manually_overridden,
  created_at, updated_at,
  UNIQUE(cve_id, package)
)

tickets(id, cve_id, package, fix_version, status, run_id, UNIQUE(cve_id, package))

decision_log(run_id, cve_id, event, payload, seq)
```

类型定义见 [tests/contracts/types.ts](../contracts/types.ts)。

## 5. 验收标准

| 编号 | 标准 |
|------|------|
| AC-1 | 版本判定与 semver 语义一致，覆盖开闭区间、多区间并集、预发布版本 |
| AC-2 | 仅「确实引用并调用受影响 API」判 `AFFECTED`；仅声明依赖必须判 `NOT_AFFECTED` |
| AC-3 | 同一仓库同一漏洞重复运行不重复建单、不重复写终态 |
| AC-4 | 数据源异常时**绝不**产出 `NOT_AFFECTED` |
| AC-5 | 建单失败时决策不得停留在完成态 |
| AC-6 | `AFFECTED` 必须带证据（文件 + 行号 + 版本比较过程） |
| AC-7 | 单次运行建单数不超过上限，超出部分排队而非丢弃 |
| AC-8 | 所有 `NEED_MANUAL` 必须带枚举内原因码 |
| AC-9 | 进程中途崩溃重启后不重复建单，未完成条目继续 |
| AC-10 | 两个 run 并发处理同一目标不重复建单 |
| AC-11 | 单条分析循环不超过 `MAX_ROUNDS`，超出终止并给出原因 |
| AC-12 | 人工覆盖的结论不被自动流程改写 |
| AC-13 | 阈值、重试上限、建单上限必须显式配置并在启动时校验 |

## 6. 测试用例总览

| 编号 | 场景 | 期望结论 | 关键断言 |
|------|------|---------|---------|
| TC-01 | repo-A：4.17.20 + 调用 `_.template` | 35jh/r5fr → `AFFECTED`；29mw/xxjr → `NOT_CALLED` | 工单 2 张；证据含文件行号 |
| TC-02 | repo-B：声明依赖未 import | 4 条全部 `NOT_CALLED` | 工单 0 张 |
| TC-03 | repo-C：4.17.21 + 调用 `_.template` | r5fr → `AFFECTED`；xxjr → `NOT_CALLED` | 29mw/35jh 不出现在结果中 |
| TC-04 | repo-D：动态 import | 4 条全部 `NEED_MANUAL/DYN_IMPORT_UNRESOLVABLE` | 工单 0 张 |
| TC-05 | OSV 前两次超时后成功 | `RETRYING` → `SUCCEEDED`，`retryCount=2` | 无 `NOT_AFFECTED` |
| TC-05b | OSV 持续超时 | `FAILED_PERMANENT`，`decision=null` | 全表无 `NOT_AFFECTED`；有告警 |
| TC-06 | 重复运行 | 结论幂等 | 工单仍 1 张，创建调用 0 次 |
| TC-07 | 建单前两次 500 后成功 | 最终 1 张工单 | 创建请求 3 次、落库 1 张 |
| TC-07b | 建单持续失败 | `AFFECTED` + `FAILED_PERMANENT` | 不存在「已完成但无工单」 |
| TC-08 | 50 条受影响 | 10 条成功、40 条 `PENDING/RATE_LIMIT` | deferred 全部可查询，无丢弃 |
| TC-08b | 释放槽位 | 原 deferred 条目补位 | 无记录永久 `PENDING` |
| TC-09 | 代码检查返回空 | `NEED_MANUAL/EVIDENCE_MISSING` | 禁止 `AFFECTED` |
| TC-10 | 版本边界（预发布、开闭区间） | 与 fixture 期望逐条一致 | 逐条比对 |
| TC-11 | 事件流 | `osv_query → code_check → decision` | `seq` 单调递增 |
| TC-12 | 原因码 | 全部 `NEED_MANUAL` 带枚举内原因 | 空原因为失败 |
| TC-13 | 中途崩溃重启 | 已完成不重跑 | 工单无重复 |
| TC-14 | 并发两个 run | 唯一约束生效 | 工单 1 张，无未捕获异常 |
| TC-15 | 循环超限 | `NEED_MANUAL/MAX_ROUNDS_EXCEEDED` | 不挂起 |
| TC-16 | 人工覆盖后重跑 | 人工结论保持 | `manuallyOverridden` 行不变 |
| TC-17 | 缺少必需配置 | 启动失败 | 退出码非 0 且报出配置名 |

### 6.1 TC-05 / TC-05b：数据源降级（重写）

- **前置条件**：repo-A；OSV 客户端可注入响应序列；`RETRY_MAX = 3`；退避基数 200ms。
- **故障注入**：TC-05 前两次返回 504、第三次返回正常；TC-05b 全部返回超时。
- **预期数据库状态**：
  - TC-05：`executionStatus` 经历 `RETRYING → SUCCEEDED`，最终 `decision=AFFECTED`，`retryCount=2`。
  - TC-05b：`executionStatus=FAILED_PERMANENT`，`decision=null`，`retryCount=2`（3 次尝试全部失败，重试次数为 2），`lastError` 非空。
- **预期外部副作用**：
  - TC-05：OSV 调用 3 次，重试间隔递增且带抖动。
  - TC-05b：告警 1 次，人工队列通知 1 次，工单创建 0 次。
- **通过/失败判定**：
  - `assertNoSilentDowngrade(rows)` 通过；
  - TC-05b 额外断言存在告警记录。
  - **失败判定优先看负面断言**：只要出现该漏洞的 `NOT_AFFECTED` 即判失败，不论其它字段多正确。

### 6.2 TC-07 / TC-07b：副作用失败（重写）

- **前置条件**：repo-A；工单 API 可注入失败。
- **故障注入**：TC-07 前两次 500、第三次成功；TC-07b 始终 500。
- **预期数据库状态**：
  - TC-07：`decision=AFFECTED`，`executionStatus=SUCCEEDED`，工单恰好 1 张。
  - TC-07b：`decision=AFFECTED`，`executionStatus=FAILED_PERMANENT`，工单 0 张，`lastError` 非空。
- **预期外部副作用**：TC-07 创建请求 3 次；TC-07b 告警 1 次、人工队列通知 1 次。
- **通过/失败判定**：
  - `assertAffectedHasTicket(rows, tickets)` 通过；
  - `assertNoDuplicateTickets(tickets)` 通过。

### 6.3 TC-08 / TC-08b：配额与排队（重写）

- **前置条件**：repo-E（50 个受影响包，脚本生成）；`MAX_OPEN_TICKETS = 10`（未关闭工单总量上限）。
- **故障注入**：TC-08 无；TC-08b 关闭 5 张工单模拟槽位释放。
- **预期数据库状态**：
  - TC-08：10 条 `SUCCEEDED`；40 条 `PENDING` + `RATE_LIMIT` + `decision=null`。
  - TC-08b：5 条原 `PENDING` 转 `SUCCEEDED`，工单增至 15。
- **预期外部副作用**：TC-08 建单 10 次；TC-08b 建单 5 次。
- **通过/失败判定**：
  - `assertDeferredWellFormed(rows)` 通过；
  - 40 条 deferred 均可被 backlog 查询（按 `executionStatus=PENDING` 检索非空）；
  - `assertNoStarvation([snapshotTC08, snapshotTC08b])` 通过。

## 7. 配置项与默认值

| 配置 | 默认 | 说明 |
|------|------|------|
| `RETRY_MAX` | 3 | 外部调用总尝试次数（含首次）；失败重试次数为 2 |
| `RETRY_BASE_MS` | 200 | 指数退避基数，带抖动 |
| `MAX_OPEN_TICKETS` | 10 | 未关闭工单总量上限（WIP 限制），超出部分排队 |
| `RUNNING_TIMEOUT_MS` | 600000 | `RUNNING` 超时回收阈值（10 分钟） |
| `MAX_ROUNDS` | 10 | Agent 单条分析循环上限 |
| `CIRCUIT_BREAKER_THRESHOLD` | 5 | 连续失败触发熔断的次数 |
| `CIRCUIT_BREAKER_RESET_MS` | 30000 | 熔断打开后进入 HALF_OPEN 试探的冷却时间 |

熔断器按**数据源整体**共享一个实例，不为单条漏洞独立熔断。

## 8. Fixture 说明

- `tests/fixtures/osv/*.json`：2026-11-20 从 `api.osv.dev` 拉取的真实快照，**禁止在测试期实时请求**。
- `tests/fixtures/repos/repo-{A,B,C,D}`：最小仓库，`package-lock.json` 中的 integrity 取自真实 npm registry。
- `tests/fixtures/manifest.json`：每个仓库的期望结论与理由，是测试断言的唯一期望来源。
- 版本事实（来自真实快照）：
  - `4.17.20` 命中 4 条：`29mw`(ReDoS)、`35jh`(template 命令注入)、`r5fr`(template imports)、`xxjr`(unset/omit/pullAt 原型污染)
  - `4.17.21` 只剩 2 条：`r5fr`（修复于 4.18.0）、`xxjr`（修复于 4.17.23）

## 9. 未决项的默认处理

以下不阻塞开工，均已有默认值，实际运行后再调整：

| 项 | 默认处理 |
|----|---------|
| 跨表不变式（AFFECTED 必须有工单） | 应用层保证 + 每日对账脚本，不引入分布式事务 |
| `RUNNING` 超时回收 | 10 分钟 |
| 熔断器范围 | 数据源整体共享 |
| EPSS 与冻结冲突 | EPSS 只写入 `priorityScore`，不参与 `decision` 计算；拉取失败降级为仅 CVSS 排序 |
| deferred 重入触发 | 槽位释放事件 + 每日定时兜底，优先级中含等待时长以防饥饿 |
| `FAILED_PERMANENT` 重试 | 3 次指数退避后转人工队列并告警，不无限重试 |
