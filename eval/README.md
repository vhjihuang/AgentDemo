# 离线评测脚本

在**冻结 fixture** 上运行 `triage()`，把实际判定结果与 `tests/fixtures/manifest.json` 的人工期望逐条比对，输出指标并生成 `eval/report.json`。

## 运行

```bash
npx tsx eval/run.ts
```

- 全程离线，只读取 `tests/fixtures/osv/` 下的冻结快照，不会请求 `api.osv.dev`。
- 全部条目通过且不变式无误时退出码为 `0`；任何失败退出码为 `1`，可直接接入 CI。
- 每次运行会覆盖写入 `eval/report.json`。

## 指标含义

| 指标 | 含义 |
|------|------|
| 总条目数 | manifest 中所有仓库的 `expected` 条数之和 |
| 判定正确数 | `decision` 与期望一致的条目数 |
| 原因码正确数 | `reason` 与期望一致的条目数 |
| 漏判 | 期望 `AFFECTED`、实际未判 `AFFECTED`，即应修未修 |
| 误判 | 期望非 `AFFECTED`、实际判成 `AFFECTED`，即不该修却建单 |
| 意外条目 | 结果中出现但 manifest 未声明的漏洞 |
| 不变式失败 | `tests/helpers/assertions.ts` 中任一条结构不变式未通过 |

除逐条比对外，脚本还会复用不变式断言校验结构性约束（禁止静默降级、`AFFECTED` 必须有工单与证据、`NEED_MANUAL` 必须有原因码、工单不得重复、排队记录格式正确）。

## 边界说明

**这是冻结 fixture 上的回归评测，不是线上准确率。** 指标只反映实现相对这 4 个最小仓库与固定 OSV 快照的行为是否发生回归，不能外推为真实项目的检出率或误报率；上游漏洞数据变化也不在评测范围内。

同时，被测系统的调用面判定是 **usage-based filtering（使用面过滤）**：只识别单文件内的显式调用与一层静态 `import`/`require`，不覆盖跨文件调用链、动态 `import()`、反射与运行时拼接。本系统**没有做 reachability analysis（可达性分析）**，评测结果也不代表运行时真实可达性。
