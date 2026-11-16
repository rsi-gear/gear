# 可组合算法算子实现与验收记录

本记录对应[完整 spec](composable-algorithm-operators-spec.zh-CN.md)的 P1/P2。P3 的真正 unscored/Score 生命周期仍是条件能力，不在本次开放。

## 工作区与交付边界

- 分支：`codex/composable-algorithm-operators`。
- 基线：2026-11-16 创建分支时拉取的最新 `origin/dev`，`38730cde7fbfa53689b3aeca7d24f4a675f4dd62`。
- 独立工作树：`/Users/tangyehui/.codex/worktrees/composable-algorithm-operators/gear`。
- 原工作树的未提交修改没有迁入，也没有修改 Hitch 核心。
- 作者用法和条件限制见[算子指南](algorithm-operators.zh-CN.md)；公开示例在 [examples/algorithms/operators](../examples/algorithms/operators)。

## 实现

Python 新增 `gear.ops`：递归 Module/Function 描述、配置 clone、显式 StateTree、Call/Result codec、纯编辑与精确 patch、证据选择和共同范围比较、学习库 delta、Sequential、ScreenedEvaluate。新增算法的提示词、选择公式和阶段流程留在 Python。

SDK 支持 v2 算法、独立筛查策略、访问策略和显式跨 run 导入。源码、嵌套组件、schema、资源真实字节和声明安装包进入冻结身份；依赖检查覆盖预载模块和普通 import。托管虚拟环境采用解释器实际标准库位置，避免安装路径别名被误判为外部依赖。普通 import 检查不是独立于 OS 沙箱的安全边界。

TS 的 v2 interpreter 在原 journal 中保存独立状态与调用账本，原子预约整批调用和预算；稳定请求键映射到原 provider submit/inspect/cancel。版本化存储上限在准入时冻结。精确候选经过 staging、mutation policy、harness check、fsync 和原子封存；恢复复用已有 manifest。

样本区分 plan/sample/attempt/assessment。ensure 固定槽复用，fresh 新键新计划，reuse 显式引用集合，retry 不增加统计样本；已有指标补投影接入作者样本命名空间。有效目标文件、学习资产版本和 exposure 进入执行身份。最终 gate 使用独立冻结的 seed/held-out 计划。

Hitch adapter 读取目标执行记录、目标消息轨迹和声明输出文件。blind 的 scored_private 结果不含评分、评分失败、verifier 或私有 locator；目标状态独立取得，评分失败不重跑目标。输出和轨迹可用于 ReadArtifact 和 Meta 的只读材料。

库快照不可变，发布使用 expected revision 的 CAS 和稳定 commit ID；即使丢 receipt 后 head 再次推进，仍恢复原结果。TargetFiles 快照可叠加到真实封存目标，冲突路径与不支持的资产拒绝执行。CompleteTask 独占 Decision，由运行层验证 sample/输出/任务/revision 并原子推进有限任务流。

历史与 research/report 接入 generated、screened、evaluated、内部选择、nomination、发布、库和任务完成事件。运行事实与作者解释区分 provenance。v2 Meta 使用显式历史/材料引用；未自动注入 v1 的隐式经验上下文。跨 run 导入按材料和评分分别授权，候选复制到当前 run，证据检查数据、执行及 objective 身份，导入不改变最终 gate。

## 对照 spec 第 15 节

| 验收项 | 实现与证据 |
| --- | --- |
| 可调用、组合、参数与状态 | `test_ops.py`、`test_ops_flows.py`、`operator-worker.spec.ts`：离线算子、clone、嵌套替换、配置冻结、重建与状态版本 |
| 冻结与隐藏依赖 | 源码/资源捕获测试、`test_operator_imports.py`：资源变更不改已捕获内容，普通未声明导入在模块执行前拒绝 |
| 决策及 Meta 恢复 | `operator-project.spec.ts`、`operator-runtime.spec.ts`：真实 worker，丢 Meta 回执后 inspect，不重跑已提交 Decision |
| 候选封存恢复 | `operator-storage.spec.ts`：原子编辑、harness 拒绝、rename 后 manifest 丢失、冲突重放 |
| 调用键及批次 | `operator-runtime.spec.ts`：相同调用复用、同键冲突、预算与结果容量整批预约 |
| 多来源和材料授权 | `operator-imports.spec.ts`、Codex generic operator Meta 测试：冻结副本、原材料漂移、只读 donor、私有路径隔离 |
| 分页和证据绑定 | storage/Python flow 测试：cursor 绑定、连续覆盖、混页/缺页/重复拒绝、原始字节 digest、EvidenceSet 页面完整性 |
| ACE/局部回滚 | 纯 delta/patch 测试与 `operator-examples.spec.ts` 的实际精确构造 |
| 筛查与强制前置 | 公开 RRSI 数据流的通过/拒绝/材料不足；独立 worker 判定拒绝全局变量绕过和伪造 receipt |
| Meta/critic 计量 | generation budget 回归与真实 Codex adapter：用量不完整保持 unknown；不把 turn 数当模型请求数 |
| ensure/reuse/fresh/retry/projection | runtime 与 evaluation-repair 测试：旧集合不污染、不同 fresh 计划、独立补投影、不重复物理执行 |
| 固定计划和比较 | 原 GEPA/RandomSearch 阶段回归；共同任务/权重/槽/objective；失败保持 incomplete，约束失败单列 |
| blind 隔离 | `operator-learning.spec.ts`、Hitch artifact/runtime 测试：评分 canary、Meta、研究导出、历史、读取；私有评分失败不改变目标状态 |
| 学习版本、任务推进 | 真实 TargetFiles 文件与身份验证；CompleteTask 丢 receipt、Python cursor 绕过拒绝、未来任务不开放 |
| 库发布恢复 | library 单元测试及真实学习流程：竞争 CAS、回执丢失、head 后继推进、稳定 commit 记录 |
| 发布语义和报告 | 内部结果/库发布/任务选择与 champion gate 独立保存和报告 |
| v1/v2 与身份兼容 | 旧 worker/runtime/controller 回归，独立 v2 handshake，取消不改已提交事实；身份不匹配明确拒绝，不重算旧身份 |
| 包装 | 外部 npm 安装与 wheel 的公开导入、托管 worker 的 v2 精确编辑、旧协议完整项目流程及取消恢复 |
| 条件能力 | 未支持能力在收费调用前拒绝；不静默互换 scored_private/unscored |

## 检查结果

- Python 相关算子、公开页解码器和旧算法回归：81 项通过；严格 mypy 检查 20 个文件通过。
- `typecheck`、全量 runtime ESLint、严格 mypy、`check:contracts`、`check:boundaries`、`git diff --check` 已通过。
- Node 26 + Python 3.12 的 `test:project:package` 已通过，涵盖外部 npm/wheel 安装和真实 OS 沙箱 worker。
- Node 26 的最终受影响 TypeScript 回归：18 个文件、200 项通过。Codex adapter 全套此前 37 项通过；新增多来源测试按真实 unknown 用量口径修正后单独复核通过。

## 明确的条件能力与适配差异

- GEPA/RandomSearch 保留 v1 六策略和 staged flow，提供兼容示例；没有静默切换为 v2 或宣称身份相同。新示例显式使用 v2。
- P2 blind 仅 scored_private，Hitch 内部确实运行 verifier 并计费。P3 unscored/Score 不支持。
- provider 随机性可用；当前 controlled/paired seed、额外 sampling parameters、blind target-usage 白名单明确 unsupported，不伪造计量。
- target-messages-v1 是允许的目标消息投影。摘录或不支持的多模态内容标为不完整；不宣称提供完整原始多模态轨迹。
- 支持 Meta 的知识上下文及目标 TargetFiles；可执行 improvement harness 未开放，属于 Harness² 完整复现缺口。
- 跨 run 导入限同一项目。blind 禁止 scored 来源，并按源 run 的准入任务范围保守拒绝未来任务材料。历史证据不会自动纳入当前 gate 或授予旧 sample 执行权。
- 示例验证框架机制，未做论文模型效果、真实付费调用或 Docker benchmark 复现实验。
