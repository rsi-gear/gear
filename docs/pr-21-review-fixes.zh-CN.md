# PR #21 审查问题核验

核验日期：2026-09-17。审查对象为 [PR #21](https://github.com/rsi-gear/gear/pull/21)，远端 head 为 `e172456672414bfe0a14c8b94fd1b640b6493c30`。该 head 的 CI 通过，但三条行内问题均未解决；CI 通过不能替代这三条问题的定向验证。

以下修复已提交到 `codex/candidate-promotion`，并在合并 `dev` 时保留。未修改 GitHub review thread 的状态。

| 审查意见 | 修复 | 回归验证 |
| --- | --- | --- |
| [P1：实际评测配置未绑定可复用 cell](https://github.com/rsi-gear/gear/pull/21#discussion_r4003033068) | 直接模式将完整数据集请求的实际身份合入 universe/cell 条件摘要，并持续核验。daemon 从已有提交记录取得实际配置，冻结跨 seed/held-out 的共享 cohort，逐批核验后才接受证据。无法证明身份的结果不接纳。 | `search-evaluation-adapter.spec.ts`：直接模式 runtime-A → runtime-B 拒绝复用；daemon 保留原配置证据，拒绝新配置与其配对；同配置正常运行、中断恢复不重复提交。`hitch-cli-evaluator.spec.ts`：验证现有 `eval inspect` 可提供一致身份，策略漂移改变摘要，身份查询不新增提交。 |
| [P1：生成中断后的原 Meta attempt 无法恢复](https://github.com/rsi-gear/gear/pull/21#discussion_r4003033072) | 自动重启和显式 resume 共用原 execution 检查，接入原 handoff、workspace、父代 checkpoint 和截止时间；不可恢复或到期的执行需确认取消或确认不存在后写终态。不再将持久化 session ID 当作存活证明。 | `refine-service.spec.ts`：自动恢复、显式恢复、到期、不可恢复、恢复操作失败、取消不确定；检查原 attempt 不增生、工作计划不变、恢复保留未提交文件、终态重放不新增评测。`meta-session.spec.ts`：仅在 host 确认缺失时完成停止处理。 |
| [P2：搜索 token/request 预算未被 Meta 强制执行](https://github.com/rsi-gear/gear/pull/21#discussion_r4003033076) | 显式限额要求实际适配器具备累计执行能力，在创建 evolution 前检查。DSH 的独立计量无需 context offloading；启用 offloading 时压缩请求也计费。Skill 可省略可选限额运行，但不会静默忽略已配置的限额。 | `refine-service.spec.ts`：真实 Skill 完成搜索、工作区投递和恢复，未知用量不伪报为零；显式不支持的限额仍拒绝接纳。`search-optional-budgets.spec.ts`：省略、单层限额、显式零、缺少计量与重放。`meta-offloading.spec.ts`：普通 DSH 的 token/request 限额、实际结算、输出上限收紧的归因、模型漂移拒绝，以及原压缩预算测试。 |

本次进一步优化取消了“只允许直接 Hitch + DSH context offloading”的组合限制。改动全部位于 Gear，包括 Gear 的 Hitch 适配层；没有修改外部 Hitch CLI，也没有新增 CLI 命令、参数或协议。daemon 的实际配置由已有 `submission.execution` 证明；普通 DSH 只做累计计量和持久化，不触发摘要或上下文切换。

Skill 仍无法在 Gear 侧强制控制外部 harness 的累计模型用量。使用时需显式省略 round/evolution 的 `maxGenerationTokens`、`maxGenerationRequests` 以及 `candidateGeneration.budget` 中的 `maxTokens`、`maxModelRequests`；评测、诊断、修复、候选数、尝试次数与时间限制继续生效。未配置的生成资源在 `remainingBudget` 中为 `null`，生成结果的相应 `usage` 字段缺失，表示未知。完整控制面测试已改回真实 Skill 适配器。

验证命令：

```sh
npm run typecheck
npm run build
node scripts/check-search-package.mjs
./node_modules/.bin/vitest run tests/unit/search*.spec.ts tests/unit/refine-service.spec.ts tests/unit/meta-session.spec.ts tests/unit/meta-offloading.spec.ts tests/unit/skill-meta.spec.ts tests/unit/hitch-cli-evaluator.spec.ts tests/unit/evolution-components.spec.ts tests/unit/config.spec.ts tests/unit/meta-isolation.spec.ts --maxWorkers=2
git diff --check
```

最终验证：扩大回归一次运行通过 25 个文件、488 项测试（326 秒），覆盖 Hitch 适配层、真实 Skill 控制面、DSH 普通与 offloading 预算、生成恢复和搜索包合同。类型检查、构建、真实 npm 包外部消费以及 `git diff --check` 均通过。外部包示例完成自定义父代策略运行、中断恢复与终态重放，未新增重复评测。
