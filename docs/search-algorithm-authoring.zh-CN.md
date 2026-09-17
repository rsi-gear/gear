# 编写和验证搜索算法策略

Gear 将搜索分为算法流程、决策策略和执行层。当前内置流程是 failure-cluster GEPA；父代选择提供公开策略接口。local/bridge/global/held-out 的阶段顺序、任务 scope 构造和最终晋级规则仍属于该内置算法。

## 从哪里开始

| 入口 | 用途 |
| --- | --- |
| `rsi-gear/search/api` | 组件注册、父代策略合同、随机源、journal 和 provider 类型 |
| `rsi-gear/search/presets/failure-cluster-gepa` | 内置搜索流程、默认配置、两种父代策略 |
| `rsi-gear/search/testing` | toy 数据、内存 provider/journal、策略合同检查 |

原 `rsi-gear/search` 入口继续兼容，包括已有的低层工具。新扩展应优先使用上表入口；`runtime.ts` 等内部模块不作为策略插件的调用接口。

可运行示例在 [`examples/parent-policy`](../examples/parent-policy)。它是第三种父代策略：先均匀选择有效 scope，再均匀选择其中已通过证据和探索约束的父代。它只依赖公开入口。

仓库中运行：

```sh
npm ci
npm run test:search:package
```

这个命令构建真实 tgz，在临时外部项目安装它，对示例执行 TypeScript 检查，再运行完整 toy round、中断恢复和终态重放。示例不需要模型密钥、Hitch 或 Docker。

独立使用时复制示例目录，在其中安装 `rsi-gear` 的构建产物，然后执行 `npm start`。

## 算法流程

```text
读取并验证冻结的配置、实现、seed/held-out 数据身份
建立或读取 seed archive
根据父代策略所需能力准备只读 seed 视图
调用 ParentSelectionPolicy，校验并冻结父代分配
为每个父代诊断失败 family，分配候选工作计划
生成候选并验证精确代码版本、工作计划消费凭据
local：在指定 scope 中检查候选
bridge：扩大共同评测范围，选择唯一全局提名
global-seed：与固定 champion 做全量 seed 比较
held-out：对同一个提名执行最终晋级检查
提交研究档案和经过校验的 champion 更新
```

`engine.ts` 表达上述阶段安排；`runtime.ts` 执行评测、诊断、生成、证据修复、预算结算、恢复和提交。`SearchJournal` 将这些操作与文件存储分开。生产 `SearchStore` 和测试 `MemorySearchStore` 共用 journal 与预算账本逻辑，生产写入仍要求 evolution 的单写者锁。

## 父代策略合同

策略由 `{ ref, requiresChampion, select }` 组成。

- `ref` 使用现有 `ComponentRef`：组件种类为 `parent-selection`，记录包名、版本、实现摘要和配置摘要。
- `requiresChampion` 为 true 时，框架在选择前合入已提交的 seed 补全证据，并准备合格 champion 的只读视图。它不允许策略绕过证据完整性或探索约束。
- `select(input, random)` 是同步纯决策函数，返回 `allocations`、`parentProbabilities` 和 `reasonCodes`。

输入是分离并递归冻结的 seed 投影：archive 摘要、round ID、候选配额、随机种子，以及每个 scope 的合格父代。它不包含原始轨迹、held-out 数据、store 或 champion 写入函数。

scope/parent 的 `probability` 是内置 GEPA 的参考权重。合格父代的参考权重可以为零；自定义策略可以探索这些父代。最终概率必须与返回分配相容，涉及的 parent/scope 必须来自输入。

框架会检查正整数配额、总候选上限、父代与 scope 对应关系、有效且归一化的概率、随机索引和解释。所有检查通过后，才分配 batch ID 并冻结结果。策略可以显式返回空分配、空概率及弃权理由。

使用 `random.float(index)` 或 `random.weighted(weights, index)` 获取确定性随机数。索引由策略明确分配，没有共享的可变随机游标。不要使用 `Math.random()`、当前时间或未冻结的全局配置参与决策。

## 注册与配置

参考示例中的完整配置校验。最小注册形式为：

```js
const components = new ComponentRegistry()
components.registerParentSelectionPolicy(ref.id, implementation, factory)
settings.search.parentPolicy = ref
const search = new FailureClusterSearch(store, provider, diagnosis, hooks, components)
```

在 DSH 插件中，向 `ctx.evolutionComponents` 注册相同组件，并设置 `search.parentPolicy`。`RefineService` 会将这个 registry 传给搜索流程和修复入口。注册返回卸载函数。

`parentPolicy` 覆盖旧的父代采样预设。新策略参数写入它自己的 `ref.config`，由策略工厂验证；不需要扩充 Gear 的枚举或公共证据 schema。其余 `SearchConfig` 字段仍配置 GEPA 流程。

省略 `parentPolicy` 时保留已有行为：

| 原配置 | 内置策略 |
| --- | --- |
| `scoped-frontier-membership-v1` + `parentBatchCount` | 按 scope/frontier 权重选父代并分配批次 |
| `epsilon-greedy-gepa-v1` + `championProbability` | champion 与 GEPA 混合，每个候选独立抽样 |

现有 archive 的 `parentMixture` 保留兼容；新策略的身份、输入摘要、实际概率和理由记录在 `research.parents.policy`，无需向 archive 添加策略专用字段。`archive.parentProbabilities` 仍是档案的内置投影，不能用于替代自定义策略的实际选择概率。

## 哪些规则由框架保证

父代策略不负责评测执行、证据真伪、缓存复用、generation receipt、预算结算、恢复或 CAS。更换策略不会解除 seed/held-out 隔离、固定提名、保护任务和显式晋级授权。

`CandidateGenerator`、`CandidateAssessor`、`CandidateSelector`、`Judge` 和旧 `PromotionPolicy` 属于旧搜索路径。staged GEPA 使用自己的候选计划、指标和晋级逻辑，不再解析不使用的这些注册组件。`TaskSampler` 和 `RolloutProvider` 仍用于共享的任务计划与运行适配，`parent-selection` 则用于 staged GEPA。

## 测试、身份与恢复

生产接入必须满足执行层合同：

- 默认评测适配器用完整数据集的固定请求解析 `evaluationIdentity`，将实际 `provider`、`effectiveConfigDigest` 及可用的 `invocationFingerprint` 合入 task universe 的条件身份。首次执行前持久化 cohort；同一实例和重启后的新实例都会重新解析配置。旧 cell、已完成 batch 和待执行 batch 都必须通过当前配置核验，不能混用不同配置下的成对证据。
- Meta 的 seed 证据可能汇总多个物理评测，汇总摘要不能与 Hitch 的 `parent.evalId` 直接比较。默认适配器通过 `resolveVerifierRun` 从已验证的 cell 来源恢复原始 eval、trial 和 attempt；独立重复评测中的物理 attempt 通常仍为 1。提供自定义汇总证据的轨迹读取器也应实现此解析，并验证 run 属于指定 seed 投影，不能直接信任待验证 verifier 自报的 parent。
- 对提交前无法解析身份的适配器，可以实现 Gear 的 `submittedEvaluationIdentity`：从已有 reservation 只读取得实际 `effectiveConfigDigest` 和不含候选、子集的 `cohortDigest`。Gear 在接纳结果前核验并冻结共享配置，后续 seed/held-out 的提交必须属于同一 cohort。Hitch daemon 复用已有 `eval inspect` 的 `submission.execution` 和 `submission.request`，共同身份还包含 setup timeout、agent 参数及 Gear 的执行限制；数据集投影、候选 commit 和重复次数由各自的请求身份核验。没有新增 CLI 命令、参数或协议。旧 cohort 的证据仍有效；新提交配置改变时拒绝配对并取消该 reservation。两种身份机制都不可用时才拒绝接纳。
- `inspectEvaluation` 可以返回 `partially-complete` 和已持久化的 `cells`，前提是剩余批次均确定未启动，且不存在未决提交。到期恢复保留这些结果并结算时间预算终态；未到期时允许通过原操作继续剩余批次。存在运行中或状态不明的批次时仍须返回 `running` 或 `unknown`，不能将它们当作未启动。
- 首次 baseline 因预算或执行失败结束时，round 保存证据和失败终态，但不将不完整 baseline 安装为父代 archive。下一轮可复用有效 cells 并补齐缺失结果。历史证据补评在预留前耗尽预算时同样保存终态，不修改已提交的 archive，也不阻塞后续补评 ID。
- 仅当搜索或 `candidateGeneration.budget` 显式配置 token/request 限额时，要求 `MetaSessionController.capabilities.aggregateGenerationBudget` 为 true。DSH 有独立累计计量，不要求 context offloading；开启 offloading 时，压缩请求也计入预算。Skill 没有对应的累计用量执行能力，可以省略这两个限额运行；显式限额仍在创建 evolution 前被拒绝，不会自动降级。
- `budgets.round` 与 `budgets.evolution` 的 `maxGenerationTokens`、`maxGenerationRequests` 分别可选，任一层配置即生效，显式 `0` 表示耗尽。省略字段不生成 workplan 限额，`remainingBudget` 对应字段为 `null`。其它评测、诊断、修复与时间预算仍为必填。
- 对已配置的生成资源，账本保守扣除完整、可强制执行的 reservation；该数值是费用上界，不是实测用量。重试共享该额度，不通过重建 session 重新获得预算。`GeneratedCandidate.usage` 字段缺失表示未计量；有硬限额时必须提供计费值。无该限额时账本对应资源不计费，不能将内部零值解释成模型零消耗。
- 普通 DSH 在请求前持久化 reservation，按模型反馈的实际用量结算；缺失反馈时保留保守预留。必要时缩小单次输出上限，归因记录保留该实际值，只有控制器确实施加的上限调整被允许，其它模型、采样或工具配置漂移仍会拒绝。
- 生成期间中断后，`initialize` 和 `resumeSearchRound` 均检查原 attempt 的 `MetaExecutionState`。可恢复 handoff 保留原 execution ID、attempt、父代 checkpoint、workspace 和截止时间；其它执行必须先确认取消或确认 session 不存在，再记录终态。取消无法确认时保留可见的未决状态，不能仅凭旧 session ID 报告仍在运行。

`checkParentSelectionPolicy(policy, input)` 使用相同输入和随机种子重复执行，检查确定性、输入不变、合法输出与解释。用 `createToyUniverse`、`createToyScope`、`createToyEvidence` 构造边界案例，用 `createToySearch` 和 `MemorySearchStore` 验证完整运行。

同一个 round 的父代决定一旦持久化，恢复不再调用策略重新抽样。示例会在写入父代决定后模拟中断，通过 `checkpoint()` 建立新的内存 journal，验证继续执行与终态重放。

`implementationFromFiles` 对实际发布文件字节计算摘要；应传入策略模块、所有本地实现依赖和包 manifest，不能只对版本字符串做 hash。内置搜索另外记录协议版本和实现文件摘要，策略引用进入冻结的 evolution 身份。

实现或配置变化必须创建新 evolution。历史终态仍可以读取；尚未完成的旧实现不会悄悄采用新规则继续执行。TypeScript 源文件运行与编译产物运行的字节身份也不同，不应混用恢复环境。

新增策略的验收标准：只新增策略实现、配置和测试，不修改 `engine.ts`、恢复代码或公共证据结构；安装真实包后，仅依靠公开入口即可通过合同检查、完整 round 与中断恢复。
