# 编写 Gear Campaign 算法（实验性）

Gear 的 Campaign 把**算法决策**与**受管理操作**分开：算法返回下一批 `OperationIntent`，宿主验证权限、绑定和预算，执行 provider，再把已提交的结果交给下一次决策。恢复从已提交的决策与操作状态继续，不恢复 Python 或 JavaScript 的调用栈。接口尚属 experimental；离线合同测试不能证明真实模型质量或论文复现。

## 选择一条作者路径

| 路径 | 编写内容 | 入口与示例 |
| --- | --- | --- |
| 纯 TypeScript | 一个构建后的 ESM 算法；需要自定义策略时，同样用 ESM 写 hook/provider | `rsi-gear/algorithm`；[`ts-toy`](../examples/algorithms/ts-toy) |
| 纯 Python | 一个 `gear-algorithm` 算法模块；必要时用同一 SDK 写 provider | [`python-toy`](../examples/algorithms/python-toy)、[`python-provider`](../examples/algorithms/python-provider) |
| 内置科学 recipe | 配置科学参数，或在对应语言修改**一份**算法；宿主管理员配置物理能力 | RHO/AHE/Evo 在 `gear_algorithm.recipes`，GEPA 在 `rsi-gear/algorithm/gepa`，固定 Harness GRPO 在 `rsi-gear/algorithm/training` |

TypeScript 和 Python 是可选的算法语言，不要求双写。`algorithm init DIRECTORY typescript` 当前生成的 toy 模板额外带一个 Python `choose` hook 以展示跨语言调用；若要纯 TypeScript，直接参考 [`ts-toy`](../examples/algorithms/ts-toy) 的 `choose.mjs`。Python 内置 RHO/AHE/Evo 的 `rsi-gear/algorithm/recipes` 导出只是模块位置与操作种类声明，科学状态机仅在 Python wheel 中实现。GEPA 和固定 Harness GRPO 则是 TypeScript recipe。

一个算法实现 `describe()`、`initialize(context)`、`reduce(context)`；步骤 SDK 的 `task`、`defineWorkflow` 和 Python `@task`/`@decision` 帮助生成稳定操作键。算法可以决定研究策略，不能通过在输入里填写路径、角色或权限标志自行取得数据权限。`evidence.query/read`、`tasks.select/consume`、`execution.rollout/role/feedback/workspace-edit` 由宿主安装并核验。TypeScript 只从公开 `rsi-gear/algorithm` 及其 `harness`、`recipes`、`gepa`、`training` 子入口导入，不依赖仓库内部路径。

## 从模板运行到恢复

Node 宿主与 Python wheel 分别安装。**即使使用纯 TypeScript 算法**，当前 Campaign 单写者锁也要求 POSIX 环境中可用的 Python 3 与 `fcntl`（可用 `GEAR_ALGORITHM_LOCK_PYTHON` 指向解释器）；Python 算法 wheel 另要求 Python ≥3.11。wheel **不会**安装 Node、Gear、Hitch 或训练依赖。先按 [Python SDK 的本地 wheel 构建与安装](../packages/python-sdk/README.md)安装到所选解释器，再安装对应版本的 Gear npm 包及宿主所需 DSH peers。可使用包提供的 CLI：

```sh
gear-refine algorithm init ./my-campaign python
gear-refine algorithm check ./my-campaign/gear.algorithm.json
gear-refine algorithm run ./my-campaign/gear.algorithm.json
gear-refine algorithm resume ./my-campaign/gear.algorithm.json
```

构建仓库时也可用 `node lib/cli.js algorithm ...`；直接调用 `node lib/algorithm/cli.js` 时省略 `algorithm` 这个子命令。`check` 会加载可信作者代码和宿主配置、验证准入，不提交 Campaign 操作；模型适配器注册和 `resolveModelInfo` 可能查询服务元数据，因此不能把任意生产适配器的 `check` 视为完全离线。它也不是运行不可信代码的沙箱。`run` 只创建新 Campaign，已有状态使用 `resume`。每个新 Campaign 使用新的全局唯一 `campaignId` 和独立 `.gear/` 状态目录；恢复保持算法文件、配置、依赖和物理执行环境身份一致。已开始但结果不明的外部操作保留 `unknown`，不能换一个键重发。

`gear.algorithm.json` 指向**一份**算法入口；内置 Python RHO 例如 `{"language":"python","interpreter":"python3.11","module":"gear_algorithm.recipes.rho","export":"algorithm"}`。已有宿主能力通过独立 `hostProfile` ESM 入口提供，普通算法作者的 `config` 只写 coreset、重复次数、批量等科学参数。宿主配置、权限、预算来源和真实模型目的地由管理员维护。完整物理宿主路径见[宿主配置](../examples/algorithms/host-setup/README.md)。

## 数据、物理执行与计量

Fresh seed 接入读取已编译数据集和精确 Git Harness，不要求先跑旧 GEPA round。它封存真实任务 prompt 的 `overview`/`task-report`，并明确设置 `historyTraceAvailable=false`；它没有历史轨迹，不能编造 `trace-chunk`。已有 evolution 若保存了可核验的 seed evaluation，可用 `HistoricalSeedExperienceSource` 导入真实任务与有界 Hitch events；旧 `LegacyEvolutionExperienceSource` 仅导入 seed summary，不能把它当可运行任务或完整轨迹。[历史输入说明](../examples/algorithms/history-input/README.md)列出区别。新 rollout 的证据必须通过同 Campaign 已完成的 producer journal、`evidenceRef`/`receiptRef` 精确配对后，才能由角色工具读取脱敏报告和轨迹。

新 Campaign 的 Hitch daemon rollout 验证任务内容、实际 Git commit、采样、环境和用量；Evo 的选中 Skill 从绑定库物化到受限 Git 工作区，封存后由 Hitch 执行该 commit。AHE/Evo 的 score 来自受信物理 rollout 证据，模型不能自行填写计分。DSH 角色、workspace editor、证据读取和模型请求按实际回执计量。`operationLimits` 按操作种类预留 Campaign budget 中相同来源的维度；`model.tokens` 等不能严格预知的消耗使用 stop 能力，不能宣称硬上限。新 rollout 会把**完整 Hitch 子进程环境**（含 evaluator 固定覆盖的变量）摘要纳入执行身份，恢复时环境变化会拒绝；摘要不公开环境值。

合入通用存储后的算法 Hitch adapter 仍只接收 schema v1 的编译数据集；schema v2 资源数据集需要完整的 resource preflight、执行计划身份与 retention 协议，目前请使用原 Search 路径。算法投影位于 Campaign 状态目录的 `hitch-storage/search`，真实工作区锁保护发布，并在释放锁前保存持久引用。可对 `hitch-storage` 运行 `gear-refine storage inspect --state-root PATH`；引用随 Campaign 保留，普通清理不会删除仍被引用的投影。

配置宿主工厂校验 `host.settings.json`、声明的 `runtimeResources`、编译器/Hitch 可执行文件、Node 版本、模型模块与已注册的 DSH provider/模型路由。管理员必须完整列出传递的脚本及本地运行时依赖；这些字段的摘要不自动证明所有未列依赖。模型模块与路由核验也**不能证明远端模型权重未变**，真实服务的身份与准入仍由宿主负责。配置的 provider 只能在管理员认可的数据目的地运行，不由 recipe 输入扩大授权。

默认受限 DSH 宿主不持久化任意模型会话。已封存的 operation 可重放；进程在未封存的模型 turn 中退出，或 Git finalization 回包不明时，当前路径保留 `unknown`，需要外部对账，不能保证自动接续或自动重做。已有持久 DSH 宿主可由管理员通过低层接口接入。

旧搜索的 pending 运行必须继续由其**原封存的 runtime、包与依赖**恢复；新 Campaign、配置变更或 GEPA recipe 不接管旧不确定 journal。旧运行兼容基线见[封存制品](algorithm-baselines/f715748/README.md)。

## 宿主持久投影

接入既有日志或进度视图的宿主，可让算法返回 `AlgorithmDecision.projections`，并在 manifest 的 `requiredProjectionSchemas` 声明所需 artifact schema。TypeScript 与 Python 使用同一合同；Python SDK 对应 `AlgorithmManifest` 和 `AlgorithmDecision` 的同名字段。普通算法继续返回 operations，无需配置投影。

投影只物化已经封存的决定，例如 GEPA 的科学检查点和 archive 视图。宿主先持久化 artifact 与 Campaign 决定，再按顺序完成投影，之后才进入下一步或执行物理操作。重启时会重放投影，因此投影实现必须幂等；宿主实现身份变化会拒绝恢复。模型请求、rollout、训练和需要计量或对账的外部操作仍使用 `OperationProvider`。

此能力目前由定制的 journal 宿主接入；默认文件 Campaign store 和普通 CLI host profile 没有配置投影宿主。缺少所声明的能力会在准入时拒绝，不能只在 Python 或 TypeScript 算法中添加字段就启用它。

## 训练与验证边界

固定 Harness GRPO 从 `rsi-gear/algorithm/training` 使用 `fixedHarnessGrpoRecipe`，独立训练模型绑定、实际 Slime job lookup 与 Hitch 模型评测 provider；它不会替换旧 champion。训练入口是可选物理集成，Python 作者 wheel 不带 Torch/CUDA。[训练示例](../examples/algorithms/slime-grpo/README.md)说明真实后端要求。

`npm run test:algorithm:package` 构建并在外部项目安装 npm 包和干净 Python wheel，执行公开入口及 toy `check/run/resume`，检查旧搜索封存制品的恢复。其包外 [`host-setup/recorded-check.mjs`](../examples/algorithms/host-setup/recorded-check.mjs) 还生成合成 Git/编译数据集、闭合宿主设置与 `host.mjs`/`model.mjs`，通过**已安装** npm CLI 和独立 wheel 运行配置宿主的 `algorithm check`；它是离线准入测试，不发送模型请求或 Hitch evaluation。仓库单测另以真实 Python recipe、Git workspace、离线 DSH 模型和录制 Hitch CLI 验证 RHO/AHE/Evo 流程与恢复。这些测试没有使用付费模型、真实 GPU 或人工作者实验；SDK 仍为 experimental。
