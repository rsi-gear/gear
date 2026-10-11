# A1.1 DTO / replay slice 独立审计

状态：**A1.1 本片段无剩余 functional blocker，可以提交。** 仅审阅本片段：TS `src/algorithm/author/{index,a1-contract}.ts`、A1 合同/类型/跨语言测试，Python `gear_algorithm.author.{__init__,dto}`、A1 测试与 36 个共享向量。`src/history/`、v2 Campaign adapter、真实 host/profile/CLI 均不在此片段结论内。未修改仓库。

## 已核对的修订

- v2 replay 输入键精确检查、selected Agent 校验、`tasks.sample` 返回数量校验、ProposalBatch 分数组内按 ordinal 升序以及 ArtifactRef 可选 schema 的 TS/Python 对齐，均已在当前源码中看到。
- TS 的 `AuthorRoleResult` / `AuthorTaskSelection` 深只读返回和普通 `interface SearchConfig` 作者示例已进入源码；类型 fixture 将冻结 DTO 直接传给 checkpoint/operation/result，并用 `@ts-expect-error` 覆盖修改请求输入、role 输出及选中任务数组。
- 36 个共享 DTO 向量覆盖 Agent、capabilities、TaskSelection、role physical result、ProposalBatch、Evaluation 的典型接受/拒绝路径及 safe-integral / bool 数字边界；TS/Python 均读取同一 JSON 文件。跨语言三次 replay 测试将 role→sample→终态前沿与 typed result 逐次对比。

## 已闭合问题

1. **已修：TS v2 `ctx.result` 的无效 selected 原可被作者捕获并继续产生新意图。** 原 [TS `index.ts:161`](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/author/index.ts:161) 校验抛普通 Error，实测 `try { ctx.result({selected:null}) } catch {}; return await ctx.operation('safe',{})` 曾返回 `waiting` 和 `safe` frontier；Python 已用 sticky `AuthorError`。TS 现在将该失败写入 runner.fatal，新增捕获后仍拒绝 replay 的回归。独立聚焦重测 A1 合同测试 **39/39 通过**。

2. **已修：积分形式浮点数的双语言判定。** 原来 TS 接受 JSON `1.0` 为整数，Python `dto.py` / schema 拒绝。现在 Python [安全整数 helper](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/packages/python-sdk/src/gear_algorithm/protocol.py:18)、[DTO 校验](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/packages/python-sdk/src/gear_algorithm/author/dto.py:126) 和 [v2 作者可见值归一化](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/packages/python-sdk/src/gear_algorithm/author/__init__.py:79) 已对齐；共享向量含 `schemaVersion:1.0`、`cursor.nextIndex:0.0`、bool 负例，Python v2 config `rounds:2.0` 可用于 `range`，`temperature:0.4` 保持小数。A0 旧版本入口仍独立。

## 验证记录与最终门禁

- 独立执行 `npm test -- tests/unit/algorithm-author-a1-contract.spec.ts tests/unit/algorithm-author-a1-parity.spec.ts`：**2 files / 40 tests 全通过**，含已授权的本机 Python worker loopback、三次 v2 replay parity；之前默认沙箱的 `EPERM` 已排除。
- 独立执行 Python 3.11 `test_author_a1.py`：**8/8 通过**。独立 `npm run typecheck` 通过，普通 `interface SearchConfig`、只读 DTO 直接进入 checkpoint/operation/result/workflow 的编译样例通过。
- TS 实现者报告 fresh build/typecheck/59 tests 通过；主审另外执行了受 Python protocol 影响的 4 files/47 tests，以及仓库外 npm/wheel/跨语言包回归。这些分别属于实现者与主审记录，不冒充本独立复测。
- 性能基准及 A1 后续 host/CLI/真实 provider 门禁不得在此记为已完成。上述两个问题均已修复并聚焦复测；本片段可提交。
