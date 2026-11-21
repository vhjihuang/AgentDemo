# 依赖漏洞影响面分诊

输入一个 npm 仓库（`package.json` + `package-lock.json` + 源码）和一份冻结的 OSV 查询结果，输出每条命中漏洞的处置结论；结论为 `AFFECTED` 时创建修复工单。

项目要解决的问题不是「扫出多少条告警」，而是「几百条告警里哪些真的需要修」。

## 能力边界（先读）

本系统的调用面判定是 **usage-based filtering（使用面过滤）**，**不是 reachability analysis（可达性分析）**。

| 覆盖 | 不覆盖 |
|------|--------|
| 单文件内的显式调用 | 跨文件调用链 |
| 一层 `import` / `require` 声明 | 动态 `import()`、`require(变量)` |
| 静态可解析的函数引用 | 反射、依赖注入、运行时拼接 |
| `lodash/x` 子路径导入 | 打包器 tree-shaking 后的真实运行时 |

判定回答的是「源码里是否显式导入并调用了漏洞涉及的函数」，不回答「运行时攻击者能否真正触达」。任何文档、演示与对外材料都不得声称本系统做了可达性分析。

## 状态模型

`decision`、`executionStatus`、`deferReason` 是三个正交维度，不能合并成一个枚举。

| 维度 | 取值 | 语义 |
|------|------|------|
| `decision` | `AFFECTED` / `NOT_AFFECTED` / `NEED_MANUAL` / `null` | 业务结论，`null` 表示未得出结论 |
| `executionStatus` | `PENDING` / `RUNNING` / `RETRYING` / `SUCCEEDED` / `FAILED_PERMANENT` | 系统执行到哪一步 |
| `deferReason` | `RATE_LIMIT` / `BACKLOG` / `null` | 尚未开始的原因，仅 `PENDING` 时允许非空 |

合并会丢掉关键区分：同样是 `FAILED_PERMANENT`，数据源持续失败时 `decision` 必须为 `null`，建单持续失败时 `decision` 仍是 `AFFECTED`；`NOT_AFFECTED` 只允许出现在 `SUCCEEDED` 上。把「系统故障」和「业务结论」压进一个字段，就无法表达这些组合，也会让失败被误读成「不受影响」。

关键不变式：

- `NOT_AFFECTED` 只能出现在 `executionStatus = SUCCEEDED`。
- `decision != null` 必须伴随 `executionStatus ∈ {SUCCEEDED, FAILED_PERMANENT}`。
- `AFFECTED` 必须带非空 `evidence`，`NEED_MANUAL` 必须带非空 `reason`。
- `AFFECTED` 且 `SUCCEEDED` 的记录必须有对应工单；同一 `(cveId, package)` 不得有多张工单。
- `manuallyOverridden = true` 的记录不被自动流程改写。

## 一次运行的五个阶段

| 阶段 | 实现 | 做什么 |
|------|------|--------|
| load | `src/triage/lockfile.ts` | 从 `package-lock.json` 的根依赖读取已安装版本，不读版本范围声明 |
| analyze | `src/triage/analyze-stage.ts`、`src/triage/usage.ts` | 先经重试与熔断查询冻结 OSV 快照，再对每个包做静态引用与调用扫描，收敛为 `ok` / `missing` / `max_rounds` |
| decide | `src/triage/decide-stage.ts` | 纯函数判定，按固定优先级产出 `decision`、`reason` 与 `evidence` |
| persist | `src/triage/persist-stage.ts` | 终态与人工覆盖的记录不重跑；启动时回收超时 `RUNNING` |
| emit | `src/triage/emit-stage.ts` | 仅对 `AFFECTED` + `SUCCEEDED` 建单，受未关闭工单总量配额约束，失败时落终态并告警 |

一次运行的状态流：`PENDING` 排队 → `SUCCEEDED` 或 `FAILED_PERMANENT`；未完成条目可被下一次运行继续处理。

## Agent 调查层（只处理 NEED_MANUAL）

确定性链路判定不了的条目不会被强行下结论。`src/agent/` 提供一层只读调查：有界 ReAct 循环 + 四个只读工具（列文件、按行读源码、使用面分析、查冻结漏洞），产出「建议结论 + 证据」。

它不写决策表：`NEED_MANUAL` 条目仍由人工复核，Agent 只负责把复核所需的证据准备好。轮次耗尽、输出不可解析、证据为空时一律回落 `NEED_MANUAL`，分别对应 `MAX_ROUNDS_EXCEEDED` / `EVIDENCE_MISSING`。

## 配置

配置键名保持 UPPER_SNAKE，字段名在 `src/triage/config.ts` 中为 camelCase。

| 配置 | 默认 | 必须显式提供 | 说明 |
|------|------|--------------|------|
| `RETRY_MAX` | 3 | 是 | 外部调用总尝试次数（含首次）；失败重试次数为 2 |
| `RETRY_BASE_MS` | 200 | 否 | 指数退避基数，带抖动 |
| `MAX_OPEN_TICKETS` | 10 | 是 | 未关闭工单总量上限（WIP 限制），超出部分排队 |
| `RUNNING_TIMEOUT_MS` | 600000 | 否 | `RUNNING` 超时回收阈值（10 分钟） |
| `MAX_ROUNDS` | 10 | 否 | 单条分析循环上限 |
| `CIRCUIT_BREAKER_THRESHOLD` | 5 | 是 | 连续失败触发熔断的次数 |
| `CIRCUIT_BREAKER_RESET_MS` | 30000 | 否 | 熔断打开后进入 `HALF_OPEN` 试探的冷却时间 |

`RETRY_MAX`、`MAX_OPEN_TICKETS`、`CIRCUIT_BREAKER_THRESHOLD` 缺失、为空或不是满足下限的整数时，`loadConfig` 抛出 `ConfigError`，启动失败并指明具体键名，不做静默兜底。其余键在缺省时取上表默认值。

`createDefaultConfig()` 只用于测试与本地运行；生产入口必须走 `loadConfig` 的启动校验。

## 如何运行

```bash
pnpm test           # 运行全部测试：10 个测试文件、48 个用例
pnpm eval           # 在冻结 fixture 上跑回归评测，输出指标与 eval/report.json
npx tsc --noEmit    # 类型检查
```

测试只读取 `tests/fixtures/` 下冻结的 OSV 快照与最小仓库，不实时请求 `api.osv.dev`。验收口径以 `tests/SPEC.md` 为唯一权威来源；更详细的设计说明见 `docs/TRIAGE.md`。
