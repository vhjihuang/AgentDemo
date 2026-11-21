# 分诊设计说明

本文说明 `src/triage/` 的当前实现与关键取舍。验收口径以 `tests/SPEC.md` 为唯一权威来源，本文只解释代码为什么这样写。

## 1. 判定顺序

`src/triage/decide-stage.ts` 中的 `decide` 是纯函数，不读盘、不写库、不发网络请求。它按固定优先级返回结论：

1. 分析轮次超限 → `NEED_MANUAL` / `MAX_ROUNDS_EXCEEDED`
2. 分析未产出结果 → `NEED_MANUAL` / `EVIDENCE_MISSING`
3. 存在不可解析的动态引入 → `NEED_MANUAL` / `DYN_IMPORT_UNRESOLVABLE`
4. 未静态引用该包 → `NOT_AFFECTED` / `NOT_CALLED`
5. 引用且调用了受影响函数 → `AFFECTED` / `CALLED`，附 `evidence`
6. 引用了但没有调用 → `NOT_AFFECTED` / `NOT_CALLED`

这样排序的原因：

- **失败优先于业务结论。** `max_rounds` 和 `missing` 都表示「分析没有给出可用结果」。这类情况不能落到任何业务判定上，必须先转人工。`src/triage/analyze-stage.ts` 刻意让分析返回三种带语义的状态，而不是直接返回 `UsageResult`，就是因为「没跑出结果」和「跑出结果但没引用」是两件事。
- **动态引入会污染「未调用」的证据。** 只要出现 `import(变量)` 或 `require(变量)`，静态扫描就无法确认包里到底有没有被引用。此时即使没有找到调用点，也不能判 `NOT_CALLED`，必须升级人工。
- **未引用是比「调用与否」更前置的事实。** 只有确认存在静态 `import` / `require`（或字面量动态导入）之后，讨论「调用了哪些函数」才有意义。
- **调用判定只对静态可解析的引用生效。** 命中 `advisory.affectedFunctions` 才判 `AFFECTED`，否则判 `NOT_CALLED`。这两种 `NOT_AFFECTED` 都仍然只是使用面过滤，不代表运行时可触达。

`decide` 返回的基线 `executionStatus` 是 `SUCCEEDED`：能走到判定阶段，说明分析本身执行完了。失败状态的改写只发生在数据源与建单两处，见下一节。

## 2. 失败语义

核心原则：数据源或副作用失败时，绝不降级为 `NOT_AFFECTED`。只有真正完成静态检查并确认未引用，才允许出现 `NOT_AFFECTED`。

### 2.1 数据源失败

`src/triage/engine.ts` 对每个已安装包先查询 OSV。查询经过「熔断在外、重试在内」的两层保护，重试耗尽后按包落一条失败记录：

- `cveId = OSV_QUERY_FAILED`，与包名组成唯一键
- `decision = null`
- `executionStatus = FAILED_PERMANENT`
- `reason = SOURCE_UNAVAILABLE`
- `retryCount = 总尝试次数 - 1`
- `lastError` 非空，并触发一次 `osv_failure` 告警

这里不按 advisory 逐条落库，是因为查询失败时根本不知道有哪些 advisory。用一条包级失败记录表达「这个包本轮没查成」，避免伪造任何业务结论。

TC-05b 的负面断言优先于其他字段：只要该漏洞出现 `NOT_AFFECTED`，即判失败。`tests/helpers/assertions.ts` 的 `assertNoSilentDowngrade` 就是这条规则的执行者。

### 2.2 分析侧失败

`missing` 与 `max_rounds` 都转 `NEED_MANUAL`，带枚举内原因码，且不建单。它们不是系统崩溃，而是「分析已执行但结论不可得」，因此保留 `SUCCEEDED` 并把不确定性放在 `decision` 上。

### 2.3 建单失败

`src/triage/emit-stage.ts` 对建单调用使用同一套重试策略。重试耗尽后：

- `decision` 保持 `AFFECTED`
- `executionStatus` 改为 `FAILED_PERMANENT`
- `retryCount` 累加重试次数，`lastError` 记录最后一次错误
- 写入 `ticket_create_failed` 事件并触发一次 `ticket_failure` 告警
- 不产生工单

这样不会出现「已完成但没工单」的记录。`decision = AFFECTED` 搭配 `FAILED_PERMANENT` 是合法的：业务上确认受影响，但系统没能完成建单。这正是三个维度必须正交的原因之一。

## 3. 幂等与人工覆盖

数据契约要求 `vulnerability_decisions` 与 `tickets` 都对 `(cveId, package)` 唯一。内存实现 `src/triage/store.ts` 与文件实现 `src/triage/store-file.ts` 都用 `${cveId}|${package}` 作为 Map 键，读写之间不 `await`，避免同一进程内并发插入产生重复。文件实现每次写入都落一份全量快照，重启后重新加载。

一次运行开始时的处理顺序：

1. **回收超时 `RUNNING`。** `reclaimStaleRunning` 把 `now - updatedAt >= RUNNING_TIMEOUT_MS` 的 `RUNNING` 记录改为 `PENDING` / `BACKLOG`，并清空 `decision`、`reason`、`evidence`。否则上次崩溃遗留的记录会永久卡住。
2. **预检查。** `precheckDecision` 读取已有记录：
   - `manuallyOverridden = true` → 跳过，原样返回该行
   - `executionStatus = SUCCEEDED` 且 `decision != null` → 跳过，视为终态
   - 其余情况（`PENDING`、`FAILED_PERMANENT`、未超时的 `RUNNING`）→ 继续重算
3. **写入保护。** `saveDecision` 再次检查 `existing.manuallyOverridden`，命中时直接返回原记录，不写入。这是预检查之外的第二道防线。
4. **建单幂等。** `emitDecision` 先 `getTicket(cveId, package)`，已存在则完全不调用下游。`insertTicketOnce` 在插入时再做一次唯一性判断，并发运行中只有真正插入成功的一轮把工单计入本次结果（TC-14）。

因此「判定可以重算，写入不能重放」：重复运行同一仓库不会重复建单，也不会重复写终态。人工覆盖的记录会跳过本轮，也不再触发建单等副作用。

`FAILED_PERMANENT` 不属于终态，后续运行仍会重新进入判定与建单流程；单次运行内的重试次数由 `RETRY_MAX` 封顶。

当前引擎不会主动写入 `RUNNING`。该状态用于识别上次运行中途退出遗留的记录；`RETRYING` 是契约取值，实际的退避重试在 `withRetry` 内部完成，成功后由 `retryCount` 反映失败次数，而非逐次落库。

## 4. 熔断器为什么在重试层之外

`engine.ts` 的组合顺序固定为：

```ts
circuitBreaker.execute(() => withRetry(() => osvSource.query(name, version), retry))
```

两层解决的是不同问题：

- 重试处理「这次调用可能瞬时失败」。
- 熔断处理「下游已经明确不可用，别再打它」。

如果顺序反转，把重试放在外层，熔断打开后重试层仍会按退避节奏空打 `RETRY_MAX` 次；每次都在触达下游前被 `CircuitOpenError` 立即拒绝，既没有恢复正常的机会，又拖长了失败返回时间，等于没有熔断。把熔断放在外层，`OPEN` 状态下整个操作直接快速失败，退避重试只在熔断仍允许调用时发生。

熔断器的几个行为：

- 连续失败达到 `CIRCUIT_BREAKER_THRESHOLD` 后进入 `OPEN`，冷却 `CIRCUIT_BREAKER_RESET_MS` 后转 `HALF_OPEN`。
- `HALF_OPEN` 只放行一个试探请求（`halfOpenTrialInFlight`），失败立即重新 `OPEN`，成功则清零计数回到 `CLOSED`。
- 阈值统计的是 `execute` 级别的连续失败，不是单次 HTTP 尝试次数。因为重试在熔断内部，一次重试耗尽只计一次失败。
- 实例按数据源整体共享一个，不为单条漏洞独立熔断。

## 5. 配额语义

`MAX_OPEN_TICKETS` 是**未关闭工单总量上限**（WIP 限制），不是单轮建单数，也不是「每轮可以新建多少张」。

`emitDecision` 在建单前调用 `store.countOpenTickets()`，统计 `status = open` 的工单：

- 未达上限：正常建单。
- 达到上限：不建单、不丢弃。该行被改写为 `decision = null`、`executionStatus = PENDING`、`deferReason = RATE_LIMIT`，同时清空 `reason` 与 `evidence`，因为排队中的记录不得提前携带结论。
- 排队记录可被 `listBacklog()` 取回，按 `priorityScore` 降序、`createdAt` 升序排列，不会丢失。
- 槽位释放（`closeTicket`）后，下一次运行重新计算并通过 `emit` 补位。TC-08b 中关闭 5 张工单，对应 5 条 `PENDING` 转为 `SUCCEEDED` 并新建 5 张工单。

因此一次运行的新建数量取决于「上限减去当前未关闭数」，而不是每轮重置的配额。`priorityScore` 只参与排队排序，不参与 `decision` 计算。

## 6. 已知边界

- **单进程存储。** 提供两种实现：`createInMemoryStore` 用 `Map` 保存决策、工单与事件流，进程退出后状态不保留；`createFileStore` 把三张表写成单个 JSON 快照，先写 `.tmp` 再 `rename` 覆盖，重启后可重新加载，文件损坏时直接抛错而不是以空库启动。两种实现都要求单进程独占，文件实现没有文件锁，不支持多进程并发写。并发安全依赖单线程事件循环以及读改写之间不 `await`；跨进程并发不在覆盖范围，生产环境需要由存储实现提供与契约一致的 `UNIQUE(cveId, package)` 约束。
- **仅支持 npm 生态。** 只读 `package-lock.json` 中根包的 `dependencies` 与对应 `node_modules/<name>` 的 `version`，只覆盖根依赖，不展开传递依赖。版本比较只解析 `X.Y.Z[-prerelease]`，不支持 build metadata、通配符与范围表达式；OSV 区间只取首个 `introduced` / `fixed`，忽略 `last_affected` 与其他 range 类型。
- **只做同文件调用面判定。** `src/triage/usage.ts` 只扫描仓库 `src/` 目录下的源码，识别静态 `import` / `require`、字面量动态 `import()`，以及同一文件内默认导入别名的属性调用与具名导入的直接调用。不解析跨文件调用链、变量形式的动态引入、反射与依赖注入。字面量动态 `import()` 只计入「已引用」，不产生调用点。
- **受影响函数映射是本地知识。** OSV 数据不提供结构化的受影响函数列表，`src/triage/advisory-functions.ts` 负责维护。版本命中但缺少映射时，`matchAdvisories` 直接抛错，经重试后落 `FAILED_PERMANENT` 并告警，不静默跳过。
- **默认分析器为单轮静态扫描。** `createDefaultAnalyzer` 返回 `rounds = 1`。注入的分析器返回 `null` 或 `rounds > MAX_ROUNDS` 时，一律转 `NEED_MANUAL`，不给出业务结论。

以上边界意味着：本文与 `README.md` 中的结论都只描述使用面过滤。系统不声称、也不实现可达性分析。
