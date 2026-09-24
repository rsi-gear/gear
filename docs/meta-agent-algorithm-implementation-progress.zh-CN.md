# Gear 算法框架实施进度与审计

实施依据：[V3 实现方案](meta-agent-algorithm-implementation-plan-v3.zh-CN.md)。起点 `f715748dad576d3055e4a9eaab21b36015348aee`，分支 `codex/meta-agent-algorithm-plan`。实现由 GPT-6 Sol / xhigh 负责，主 agent 独立审计和提交。

## 阶段状态

| 阶段 | 状态 | 提交与验证 |
| --- | --- | --- |
| S0 方案/基线 | 已提交 `e5dfeb2` | V3、离线精确重建、source/build/parent/package 身份；6 文件 95 测试通过；重复捕获匹配，漂移期望拒绝 |
| S1 合同/内核 | 已提交；预算观察与取消恢复修补完成 | 内核/预算观察 20 项；旧 search/identity 95 项；阶段 typecheck 通过 |
| S2 Python/作者入口 | SDK、类型化错误、provider 准入已提交；默认宿主开发中 | 独立快照跨语言 23 项、Python 20 项；动态能力与真实 Optuna 3 项 |
| S3 历史/任务/执行 | 历史/fresh 数据、Hitch、DSH 角色已提交；反馈/编辑接线中 | 数据层 14 项、Hitch 7 项、角色/执行边界 15 项；均有独立复验 |
| S4 非 GEPA recipes/Optuna | Python recipes、证据授权、Git Skill helper 已提交 | Python 20 项、跨语言 3 项；Skill 9 项；Evo 实际 rollout 接线待审 |
| S5 训练接入 | 已提交 `9f65b79` | CPU 合同 44 项联合回归、2 项 workflow；真实 GPU 未验证 |
| S6 GEPA/包发布验证 | GEPA 公共决策 `c9703f7` 已提交；补全/默认宿主/正式包待审 | 主审 GEPA 10 项；包外作者和旧包跨进程恢复由实现者验证，待主审 |
| S7 真实运行/稳定性决定 | 已检查本机条件；尚无新路径真实运行证据 | Hitch daemon 未运行、无本机 GPU/Slime 配置；SDK 继续 experimental |

## S0 已确认的基线约束

- 旧 `src/search/identity.ts` 按固定源码/构建文件字节计算身份；新目录不在直接闭包。
- 默认 parent policy 还哈希整个 `package.json`。新增 exports/scripts 也会改变其身份；正式 manifest 修改必须与原 runtime 制品保留和恢复验证一起交付。
- 首批保持 `package.json`、lock 和旧 search/evolution 文件不变。新 CLI 先独立入口；正式包导出放到兼容阶段。
- worktree 的 `node_modules` 链接到原仓库已有依赖（被 git 忽略），两处原 manifest 相同；Node v26.5.1。
- 系统 Python 3.9 不满足原训练包要求；实现/测试选 `/opt/homebrew/bin/python3.11`（3.11.16）。新作者 SDK 保持轻量；训练包依赖单独处理。

## 报告规则

只登记实际执行的命令和结果；toy、CPU合同、仓库外安装、真实provider、GPU运行、科学效果分别记录。既有2026-09-10 GPU归档不认证新adapter。本文件初始版本没有新增测试通过或实现完成的声明。

## S0 验证记录

实现者在精确旧版快照执行六个 search 恢复/身份测试文件，95 tests passed；完整命令与首次离线构建失败的处置见 [基线说明](algorithm-baselines/f715748/README.md)。主 agent 独立比对当前 worktree 的全部旧 source/package/lock 闭包文件、临时基线 built 闭包与完整 tgz 摘要，均与 manifest 一致。capture 脚本仅允许新 output，并验证固定 ToolFs 输入；第二次独立捕获匹配，篡改 expected 明确拒绝。

原 checkout 的预存 lib 身份与本次精确 HEAD 重建不同；未将其冒充该基线，也未修改它。已将核验过的旧 tgz、ToolFs 输入和 manifest 保留在 worktree 被忽略的 `.evolve-lab/algorithm-baselines/f715748/`，供 S6 兼容路径使用；生成制品不进入源码 commit。其他历史 identity 仍须提供各自匹配制品。

## 训练改造前的补充基线

主 agent 在训练源码未修改时独立执行：

- `PATH=/private/tmp/gear-algorithm-training-test-env/bin:$PATH GEAR_TRAINING_TEST_PYTHON=/private/tmp/gear-algorithm-training-test-env/bin/python node node_modules/vitest/vitest.mjs run tests/unit/training --maxWorkers=2`：17 文件、127 项通过。首次沙箱执行有 23 项失败，原因是本机 `sysctl kern.boottime` 被拒绝；获准以本地测试权限重跑后全部通过。
- `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python /private/tmp/gear-algorithm-training-test-env/bin/python -m unittest discover -s python/tests -v`：180 项中 175 通过、3 项因未安装 CPU Torch 跳过、2 项本地 CPU inference fixture 启动超时；单独重跑两项仍失败。失败项为 `test_lost_start_reply_reconnect_and_idempotent_stop` 与 `test_supervisor_loss_retains_engine_ownership_until_recovery`，不是 GPU 验证。
- 独立临时环境：Python 3.11.16、psutil 7.2.2、aiohttp 3.14.3；Optuna 4.9.0 已成功安装，供 S4 真实库适配测试使用。未修改原 Python 环境，未安装 Torch/CUDA。
- 构建范围 `tsc -p tsconfig.build.json --noEmit` 曾通过；完整测试范围 typecheck 仍缺原依赖中的两个开发包声明：`@deepseek-ai/dsh-skill-filesystem` 和 `@deepseek-ai/dsh-tool-skill`。最终阶段验收另行记录。

## 主审确定的实施修订

- 预算回执支持 operation 作用域：provider 报告本操作累计用量，内核按 producer/source 与 operation 去重汇总。
- 本地持久操作在执行前记录 started；缺少完成回执时恢复为 unknown，不从缺失结果推断尚未执行。
- 当前 journal writer 由 Python 3 标准库 `fcntl` 持锁进程提交；锁持有者退出后旧调用不能写 HEAD。此为 POSIX 本地宿主依赖，作者说明和 CLI preflight 必须明确展示，尚不声称 Windows 支持。
- 内核和内置 provider 记录实际 source/build 文件闭包身份，不能仅靠同名版本常量恢复修改后的实现。

## S1 验收

主 agent 独立执行最终 `node node_modules/vitest/vitest.mjs run tests/unit/algorithm/kernel.spec.ts --maxWorkers=2`：16/16 通过；`node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit` 通过。此前同一工作树联合执行 15 项内核与 95 项旧 search/identity 测试，7 文件 110 项通过；之后仅修改新内核合同并重跑最终 16 项，未重复运行未改动的旧测试。

本阶段交付公开 JSON/schema/ref、artifact/binding、命名步骤、provider SPI/testkit 和持久内核。主审核对并补测：显式/默认绑定、不可变 slot、实际并行 dispatch、丢回包、started/unknown、锁持有进程死亡、同进程争抢、内容破坏、提供者及内核身份漂移、坏回执不污染其他完成结果、最终零用量、硬预算单操作限制和取消未释放。单 writer 的提交由持锁 helper 执行，提交回包不明立即终止该 tick，由下一次 load/inspect 恢复。

边界：仅 trusted-local；Python 3/fcntl 为 POSIX 宿主依赖。同步 helper 在副作用后没有完成记录时保持 unknown，需要外部确认；不提供任意程序的自动重复执行。stop 预算如实记录超额并阻止后续准入；hard 依赖 provider 的实际强制能力并拒绝越界回执。直接 API 调用者须提供全局唯一 campaignId，普通作者由 CLI 模板生成。公共 package exports 尚待 S6，与历史运行身份兼容同时交付。

## S1 取消恢复修补

S5 接入审计发现：持久化 cancel-intent 后、发送取消命令前崩溃，原恢复路径只 inspect，无法确保取消命令送达。现对 cancel-pending 和尚未释放的 cancelled 操作反复调用同一幂等 cancel；收到释放确认与最终用量后才结算。主 agent 独立执行内核 17/17 通过，完整 typecheck 通过。此为单独修复提交，Slime 接口另在 S5 验证相同窗口。

## S2 验收

主 agent 独立运行 `GEAR_ALGORITHM_TEST_PYTHON=/opt/homebrew/bin/python3.11 node node_modules/vitest/vitest.mjs run tests/unit/algorithm-python.spec.ts --maxWorkers=2`：20/20 通过；轻量 Python SDK unittest 5/5 通过；完整 `tsc -p tsconfig.json --noEmit` 通过。为恢复完整类型检查，工作树 node_modules 改指独立临时副本，补充两项缺失开发包，并验证下载内容与既有 lock 的 sha512 完全相符；原 checkout 依赖、manifest 和 lock 均未改动。

本阶段提供轻量 wheel 源码、Python worker/IPC、公开 provider/组件协议和 testkit、Python/TS CLI 模板、check/run/resume、跨语言 hooks。源码、安装模块、解释器和 TS 宿主桥接字节进入身份；同进程 ESM 缓存与修改后源码不一致时拒绝执行，要求新进程。未封存 TS workflow 可省略 implementationDigest，loader 自动封存；直接 Runtime 仍拒绝缺失身份。测试覆盖 Python stdout 噪声、缺依赖、类型错误、丢回包、started/unknown、并行 artifact RPC、实现漂移和重复恢复。

实现者另构建约 14 KB wheel，安装到无 Torch/Optuna 的干净环境，并在仓库外完成候选 npm 包的公开 helper→Python hook→check/run/resume。候选包仅在临时目录添加出口；正式 manifest/兼容恢复以及 root 独立包外验收留到 S6。本阶段不声称论文算法或 GPU 训练已经验收。

## S3a 数据层验收

主 agent 独立执行 `node node_modules/vitest/vitest.mjs run tests/unit/algorithm-data.spec.ts tests/unit/algorithm-data-providers.spec.ts --maxWorkers=2`：2 文件 11/11 通过；完整 typecheck 通过。本阶段交付封存 ExperienceView、带授权/分页/用途投影的 evidence.query/read、受管理 TaskView 选择/发布/消费、测量条件与严格比较、执行版本回执校验边界。

主审纠正两项语义错误：旧 SeedExperienceRecord 仅输出 proposal summary，不合成任务 prompt，也不将文件变更清单当作真实轨迹；tasks.select 拒绝 summary-only 条目。新选择/派生 TaskView 由宿主 authority 签名，consume 根据已授权 ExperienceView 根验证，算法不必手动登记新 digest；同 Campaign 两个 decision 已验证闭环。密钥复制后封存，避免调用者修改原缓冲区造成摘要与实际签名漂移。

实现身份按实际本地依赖和已安装外部包封存，不依赖消费项目 package-lock；无 lock 的构建包有回归测试。旧经验摘要只保留显式允许的 proposer claims，无 reward/effect 投影；不承诺自由文本绝无评价信息。API 授权不等于 OS 沙箱。

本提交仅含数据层和 VerifiedExecutionAdapter 校验边界。真实 seed dataset 快照、Hitch trajectory 读取、物理 rollout/role/workspace-edit 适配在 S3b 继续，不以测试 port 冒充实际服务。完整 SDK 仍为 experimental。

## S1/S2 本地取消完成记录修补

主审独立执行 TS 内核 18/18 与 Python SDK 7/7 通过。两个语言的本地 provider 在开始执行和取消之间使用互斥的持久记录；取消先完成时，重启和延迟 submit 都不会执行用户函数。未确认完成的 started 状态仍保持 unknown。取消返回操作作用域的最终零用量；Python metered provider 必须明确提供实际完成用量。此提交不包含仍在验收的论文 recipes、物理桥或训练适配。

## S5 训练接入验收

主 agent 独立执行 `tests/unit/algorithm-training.spec.ts`、`tests/unit/algorithm/kernel.spec.ts` 和 `tests/unit/training/coordinator.spec.ts`：3 文件 44/44 通过；`tests/unit/algorithm/workflow.spec.ts`：2/2 通过；完整 `tsc -p tsconfig.json --noEmit` 通过。共享校验抽取后，主 agent 此前还运行完整旧 TS training suite：17 文件 127/127 通过；之后只调整新增 provider 和 workflow helper，没有继续修改旧 coordinator。

独立 `training.slime` 从显式冻结的 learner BindingSet 构造请求，不读取旧 champion；训练、候选 BindingSet 派生、dev/held-out 评测和接受决定分别进入持久步骤。固定 Harness GRPO 复用旧训练/checkpoint/export/batch 校验与模型选择函数。命名 workflow 支持有界推进纯步骤，dev gate 失败保留 rejected、不会发出 held-out 查询。

恢复验证包括丢 submit 回包、实际 backend key lookup、V2 node generation/runtime 校验、顺序 pause 重放、显式评测资源释放、取消先于 submit 的持久完成记录，以及旧周期单 run 的独占计费归属。旧 cycle adapter 保留旧 coordinator 作为其 champion 的唯一写入者，独立 recipe 不触碰它。

真实 Slime/Hitch/GPU 作业未执行。当前实测为 CPU 合同与恢复语义，训练使用前仍须旧 Python bridge/runtime lock 和真实设备/数据校验；2026-09-10 的旧 GPU 归档不能替代新路径验收。

## S3b1 历史输入与结构化结果验收

主 agent 独立执行数据层、provider 和历史源三个测试文件：14/14 通过。HistoricalSeedExperienceSource 校验旧 registry、round、seed dataset 与任务内容摘要，从真实 instruction 构造授权 task-report；可读取已保存 seed evaluation 的 Hitch 轨迹，限定 run、canonical digest、分页和字段下钻，并记录投影删减。测试使用真实本地 registry/dataset 与受控 Hitch reader，没有连接运行中的 Hitch 服务。

执行适配边界新增至多 16 KiB 的结构化结果、独立封存 artifact 与 receipt digest 校验，使 reducer 可消费角色 JSON，同时保留独立的 Harness 产物。安装包身份解析允许仅声明 module type 的子目录 package.json，继续定位带 name/version 的实际依赖包根。

本提交为后续 recipes 的数据依赖；Hitch/DSH/workspace-edit 物理端、新 rollout 证据读取与 fresh Campaign 装配继续独立验收。另在只含已提交 HEAD 的临时归档中复测 S5 training：13/13 通过，确认训练提交不依赖本阶段未提交文件。

## S4a Python recipes 与 Optuna 验收

主 agent 独立运行轻量 Python SDK/recipe/Optuna unittest：19/19 通过；使用 Python 3.11 与 Optuna 4.9.0 执行 RHO、AHE、Optuna 三项 TS Campaign 集成：3/3 通过。Optuna 测试明确设置 `GEAR_ALGORITHM_OPTUNA_TEST_PYTHON`；只设置通用 Python 变量的一次尝试跳过了它，未计作通过。

RHO/AHE/Evo 各只有一个 Python 科学实现，TS 仅提供装配描述；命名 workflow 能有界推进纯决策步骤。RHO 的难度角色读取真实授权报告/轨迹，AHE 区分已测版本与下一候选，并对当前执行版本归因；Evo 固定批内技能绑定并原子提交任务 cursor 与技能更新。每种 operation 的配置预约必须匹配 provider 声明的预算维度。Optuna ask/tell 使用真实 4.9.0 库、独立 study 副本和有 HMAC 的受信 provider checkpoint，跨进程恢复复用封存结果。

实现者另构建独立 wheel，并用安装的 wheel 完成仓库外两次 Optuna trial、check/run/resume；正式 npm 发布包与 root 的包外复验仍归 S6。本次 CPU 验证不能代替真实模型效果或人类作者使用验收。RHO/AHE 新 rollout 证据读取、Evo 真实技能注入、默认 host profile 仍在后续接线阶段，示例当前明确标为 host 模板。

## S1 预算观察接口补充

GEPA 接入审计要求科学策略使用实际剩余预算。initialize/reduce 现收到通用预算快照，含 spent、尚未释放的 reserved 和扣除两者后的 remaining；这是账本副本，修改它不会改动内核预算。stop 能力发生超额时如实保留 spent，remaining 归零，允许完成结算但不准入新增有成本操作。主 agent 独立运行内核与预算视图测试：20/20 通过；未为 GEPA 在内核添加算法分支。

## S4b 本轮 rollout 证据授权

RHO/AHE/Evo 角色输入现携带 evidenceRef 与 producer receiptRef 配对。新增窄工具验证同一 Campaign 的 Hitch 完成 journal、输入/实现/绑定摘要及封存结果，再读取实际 run 的有界轨迹；默认不暴露测量分数，只有宿主明确授权的测量角色可读取。读取只接受该操作已授权投影的内容摘要；单角色实例缓存投影并返回用量统计。

主 agent 独立执行记录的 Hitch 协议证据测试与 RHO/AHE 跨语言集成：3 文件 5/5 通过。此处是受控协议验证；DSH 工具注册、角色最终回执中的持久用量与真实服务运行在物理角色阶段继续验收。

## S3b2 Hitch daemon 物理接线

主 agent 独立执行物理 Hitch 与角色 rollout 证据两个测试文件：9/9 通过。测试以实际 HitchCliEvaluator 类驱动本地录制 CLI 协议，覆盖真实 Git Harness、编译任务投影、提交后返回运行句柄、完成证据与版本回执、恢复不重复提交，以及取消前后故障窗口。它验证协议接线，没有启动真实容器或付费模型。

取消恢复使用只读 eval list/inspect 查找已提交的幂等键，不调用可能创建作业的 recoverReservation 重放；整个查找有 15 秒截止、单命令至多 5 秒和 256 条限制，超限或无法确认保留 unknown。取消先于提交时持久记录零用量，延迟 submit 被拒绝；已提交作业取得停止确认后才释放。`rollout.trials` 计已接受的单任务逻辑提交，包括失败/取消，不能解读为执行时长或成功 trial 数。

本端当前验证 Harness 绑定与已授权 seed TaskView。Evo 动态技能注入、新 Campaign 初始化及 DSH 角色/workspace-edit 接线继续独立交付；未把缺少这些能力的模板标为可直接运行的完整物理流程。

## S2/S6 跨语言错误与能力准入补充

主 agent 用仅包含已提交 HEAD 与本次冻结文件的独立快照验证，排除了仍在开发的 CLI/package/physical-host 改动：跨语言和 required-kind 两个测试文件 23/23、Python SDK/recipes/Optuna 20/20（无跳过），完整 typecheck 通过。

AlgorithmManifest 可声明 requiredOperationKinds，运行时在创建 Campaign 前验证 provider catalog，含内建 bindings.derive。Python hook 明确返回的远端业务异常封存为类型化完成错误；超时/连接丢失仍与业务异常区分。Python DurableLocalProvider 支持显式 error outcome 并在恢复时复用；任意 execute 抛出异常不会被一律伪装成已完成。

本提交不包含正式 package exports、CLI factory 或旧 runtime 分派，它们须与兼容验证一起交付。

## S3b3 新 Campaign 的任务输入

FreshSeedExperienceSource 可从宿主指定的已编译 seed dataset 创建任务快照，不需要先运行旧 GEPA 或准备旧 round；保存任务与数据集摘要、真实指令的授权投影及 Campaign cursor，不合成轨迹。主 agent 独立运行合成数据测试：2/2 通过，覆盖封存、修改后拒绝和任务数量上限。

该通用代码最初被自动审批误判为实际数据披露；经确认仅定义库类、未读取用户任务且没有网络/模型调用后，同动作复核放行。只使用生成的本地测试数据。本提交不执行真实模型任务，Hitch fresh evaluation context 与默认 host profile 在后续装配阶段接入。

## S2/S6 配置指定的 provider 准入

AlgorithmManifest 新增通用 requiredOperationKindsFromConfig，由冻结配置的顶层自有字符串字段指定所需 operation kind；Optuna 的 evaluationKind 使用此合同。缺字段、非字符串和未注册 provider 都在创建 Campaign 前拒绝，避免运行到第一个 trial 才发现缺能力。

主 agent 在仅含 HEAD 与本次六个冻结文件的独立快照中复验：准入测试 2/2、真实 Optuna 跨语言测试 1/1、Python SDK/recipes/Optuna 20/20，完整 typecheck 通过。Optuna 首次执行受沙箱限制无法监听本地 IPC 端口；获准运行本地测试后通过，没有外部模型或训练调用。

## S6A GEPA 公共决策与持久操作

主 agent 在只包含已提交 HEAD 与本次五个冻结文件的独立快照验证：GEPA 10/10、完整 typecheck 通过。一个 Campaign 执行一轮，nextGepaRound 传递封存 archive、当前绑定、同 epoch 的共享任务抽样与累计用量；复用原父代、cluster、scope、bridge、archive 和 promotion 规则。两候选与跨轮 stable/periodic epoch 使用旧引擎做差分对照，另覆盖不匹配绑定、零预算、实际超额和丢回包恢复。

主审发现并修复两项问题：同阶段重叠 cell 原先可能并发重复评估，现通过持久队列逐项执行并复用已验证缓存；同一 epoch 的 shared tasks 原先会跨轮重采样，现沿 lineage 固定。此版本 GEPA 操作串行发出；通用内核的并行能力保留。

本提交为公共策略和操作合同，尚非完整生产迁移：实际 workspace-edit/generation 接线、原始 rollout 的 process/raw-metric 补全、旧额外 finding handoff 及正式包导出继续审计。有效 outcome 的缺失 process 不当作科学成功或失败，但当前不提供原旧接口的全部补全能力。测试使用受控物理 provider，不能据此声称真实模型运行或论文效果已经验证。

## S3b4 DSH 角色与持久证据计量

主 agent 在独立冻结快照中执行角色与 execution/data provider 两个测试文件：15/15，完整 typecheck 通过。DSH 角色有独立 operation/session 记录、原意图恢复、实际模型用量与持久证据用量，返回封存结构化 JSON；开始前取消会阻止延迟 submit。角色仅验证宿主绑定，receipt 明确标记 host-admission-only，不把独立角色推理冒充 Harness 的实际执行。

模型请求数可硬限制；token 用量按实际报告以 stop 能力结算，不宣称严格硬上限。主审追加的超时测试证明 AbortSignal 到达挂起的离线模型适配器；已开始但用量无法确认时保持 unknown、无伪造最终回执且不重新请求。请求前已确认停止可返回类型化错误与零用量。异步证据读取逐 session 排队，防止并发累计计数重复相加；恢复后的最终回执包括已持久计数。

此接口当前是有截止时间的同步角色调用，Campaign writer 在调用期间持锁；不宣称另一个 CLI 可即时中断。测试使用真实 DSH 会话/工具机制和离线 LLM fixture，无外部模型。fresh 默认宿主、可信测量反馈与 workspace-edit 在后续阶段继续。

## S4b2 Evo 的 Git 技能产物

主 agent 在独立冻结快照中验证 Skill overlay：8/8、完整 typecheck 通过。helper 验证所选 Skill 属于当前绑定的库，将封存 Markdown 写入独立 Git 工作区的 skills/<name>/SKILL.md，经 HarnessBuilder 检查与运行时 discovery/read 回执校验后封存新 commit。它同时验证固定基础 Harness 和技能库绑定；复用 operationId 时输入变化会拒绝。

测试实际创建 Git 工作区、读写技能文件和候选 ref，运行时检查器为离线 fixture。覆盖库成员/绑定错误、运行时未确认读取、重启复用、符号链接拒绝、损坏 workspace sidecar，以及 finalization 成功但回包丢失。最后一种状态保持 unknown、不会生成第二个候选；此版本没有自动对账该 Git 完成窗口。Evo→Hitch 的最终调用接线仍在后续阶段，不将 helper 验证等同于真实模型消费技能。

## S3b5 新 Campaign 的 Hitch 执行上下文

主 agent 在独立冻结快照中运行 fresh 与既有 Hitch 物理接线测试：7/7、完整 typecheck 通过。宿主可从 EvolutionSpec 和实际编译任务创建确定性的只读评估上下文，不写旧 registry/round，也不依赖旧 candidate lease；初始化检查任务摘要与算法所需 repetition 数，运行沿用已验证的 daemon 协议、绑定回执及恢复。

本路径当前接受冻结的无显式 seed/temperature 覆盖的 repetition 计划，不将无法兑现的采样条件伪装成已支持。测试使用合成任务、真实 HitchCliEvaluator 类和录制 CLI fixture；没有启动真实 Hitch 容器或调用模型。

## Skill 预检查无副作用补充

公开 validateSkillOverlaySelection 只读当前绑定、库成员与封存 Skill 内容，不创建工作区或 operation 记录；实际物化仍在持久开始意图后执行。返回注入摘要采用名称排序，不能将检索器的排序直接当作物理执行顺序。主 agent 独立快照验证 Skill suite 9/9，完整 typecheck 通过。

## S6A 原始运行的证据补全

主 agent 在只含已提交 HEAD 与三个冻结文件的独立快照中验证：GEPA 16/16、完整 typecheck 通过。每个评估操作冻结 search/promotion 的 process mode，先持久保存原始 rollout cells，再以固定 key 请求该次运行的 process/raw-metric 投影；丢回包后先查询同一 key，不能用新 rollout 替换已有有效 outcome。缺少所需补全能力或仍缺证据时返回类型化执行错误并结算已发生用量。

主审发现并修复了两类证据降级：恢复时原始回包覆盖已补全缓存，以及跨轮 archive 与本地旧缓存的顺序影响。合并现在只接受不改变有效字段的单调补全；两个 archive 顺序都验证零新增 rollout/投影。测试覆盖固定投影 key、unknown/running 恢复、原始 raw metrics、拒绝改写 outcome 与阶段 process mode。实际物理 generation bridge 和正式包入口仍在后续阶段；未据此声称真实模型或论文效果已验证。

## S4b3 Evo 技能版本的实际 Hitch 提交

主 agent 在独立冻结快照执行新增技能测试 4/4、既有 physical/fresh 两个测试文件 7/7，完整 typecheck 通过。Hitch rollout 对 Evo 验证固定基础 Harness、批内 Skill BindingSet 及库成员；预检只验证，持久开始意图后才物化派生 Git 版本。daemon request 使用该派生 commit，完成回执封存实际执行 commit、Skill overlay receipt 与规范排序的注入摘要。

测试使用真实 Git/HarnessBuilder、离线 runtime checker 和录制 Hitch CLI，验证派生 commit 的技能字节、request/evidence/receipt 一致、恢复仅提交一次、伪造 Skill 拒绝、开始前取消不建工作区，以及 Git finalization 回包丢失保持 unknown 且不退回基础 Harness。此为物理协议接线验证，没有调用真实模型。测量反馈和默认作者宿主继续分开交付。
