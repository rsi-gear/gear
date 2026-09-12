# Candidate 晋升案例只读回放

日期：2026-09-12。所有分析与建议均为 **advisory**。没有执行新评测，也没有更新 champion、archive 或实验状态。

回放文档引用的第 4 / 5 轮历史 cache：`8b651c5` → `59e4892`。工具按旧 `unified-evaluator.mjs` 的 `JSON.stringify` SHA-256 规则校验 evidenceHash，再核对代码、条件、任务清单和单次观测身份。原适配器只被读取，没有导入或执行。

| 指标 | 第 4 轮 | 第 5 轮 |
| --- | ---: | ---: |
| 结果宏平均 | 36% | 34% |
| 历史过程标量均分 | 81.1944% | 82.2979% |

配对任务 100 个，其中 8 个结果改善、10 个退步。改善可作为后续专长研究的线索，不能替代未来冻结 scope 上的证据或抵消其他任务的退步。

工具仅接受旧版 standardized、每任务一次有效观测的 cache。分析固定精度为 0.000001，任务等权；过程方向显式假设为越高越好。不把历史标量解释为新指标合同或硬约束证明。没有独立 held-out，未认证可复用的 v2 cells，发布结论为 `no-release-decision`。

两份输入在回放前后逐字节比较一致：

| Commit | 文件 bytes | SHA-256 |
| --- | ---: | --- |
| `8b651c5` | 51629 | `c763257b7b8ec18f958ddd246b8816f28b95e05d06094597857010dabebdbdf0` |
| `59e4892` | 51703 | `8e9944c25e4e8693ef08bf7afcf0a55860b5d60a2dfbe1a60d6f665b3e6b7f99` |

CLI 用独占创建方式写入新输出文件，拒绝覆盖已有文件或 symlink；读库 API 本身不包含写入函数：

```sh
node scripts/search-shadow-replay.mjs BASELINE_CACHE CANDIDATE_CACHE NEW_OUTPUT_JSON
```

本机完整 JSON 报告：[candidate-promotion-shadow-20260912.json](/private/tmp/gear-candidate-promotion-20260912/artifacts/candidate-promotion-shadow-20260912.json)。这些本地历史缓存不是构建或自动化测试的依赖。
