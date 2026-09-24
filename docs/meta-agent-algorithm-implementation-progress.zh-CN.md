# Gear 算法框架实施进度与审计

实施依据：[V3 实现方案](meta-agent-algorithm-implementation-plan-v3.zh-CN.md)。起点 `f715748dad576d3055e4a9eaab21b36015348aee`，分支 `codex/meta-agent-algorithm-plan`。实现由 GPT-6 Sol / xhigh 负责，主 agent 独立审计和提交。

## 阶段状态

| 阶段 | 状态 | 提交与验证 |
| --- | --- | --- |
| S0 方案/基线 | 已提交 `e5dfeb2` | V3、离线精确重建、source/build/parent/package 身份；6 文件 95 测试通过；重复捕获匹配，漂移期望拒绝 |
| S1 合同/内核 | 已提交；预算观察与取消恢复修补完成 | 内核/预算观察 20 项；旧 search/identity 95 项；阶段 typecheck 通过 |
| S2 Python/作者入口 | SDK、类型化错误、provider 准入已提交；默认宿主开发中 | 独立快照跨语言 23 项、Python 20 项；动态能力与真实 Optuna 3 项 |
| S3 历史/任务/执行 | 历史/fresh 数据、Hitch、DSH 角色及可信反馈已提交；编辑接线中 | 数据层 14 项、Hitch 7 项、角色/执行边界 15 项；均有独立复验 |
| S4 非 GEPA recipes/Optuna | Python recipes、证据授权、Git Skill 与 Hitch 注入已提交 | Python 20 项、跨语言 3 项；Skill 9 项；Evo/Hitch 11 项，可信反馈 6 项 |
| S5 训练接入 | 已提交 `9f65b79` | CPU 合同 44 项联合回归、2 项 workflow；真实 GPU 未验证 |
| S6 GEPA/包发布验证 | GEPA 公共决策与补全已提交；编辑桥/默认宿主/正式包待审 | 主审 GEPA 16 项；包外作者和旧包跨进程恢复由实现者验证，待主审 |
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

## S2/S3 宿主研究视图与物理证据绑定

主 agent 在已提交 HEAD 加冻结研究/反馈文件的独立快照联合验证 12/12，完整 typecheck 通过；本提交的 research profile 与 rollout evidence 两个文件为其中 7/7，反馈实现单独审查提交。宿主可从授权来源封存首个研究视图，以原子完整记录固定选择；来源后续追加历史不会在 resume 时改变 Campaign 输入。稳定密钥和 policy identity 绑定 Campaign、任务授权、视图和实现闭包；tasks.select 与 tasks.consume 都执行同样任务范围约束。

新增窄 producer 验证 helper 只接受同 Campaign 已完成 Hitch operation 的 evidence/receipt 配对，并返回冻结的生产条件供宿主反馈计算。Evo 额外核对基础 Harness/Skill 库、实际选择、规范排序的 overlay receipt 和物理执行 commit；拒绝把逻辑绑定当作技能实际执行证明。此处输入/结果均为合成或录制协议 fixture，默认宿主装配和真实服务仍另行验收。

## S3b6 宿主可信测量反馈

主 agent 在只含已提交 HEAD 与两个冻结文件的独立快照复测：可信反馈 6/6、完整 typecheck 通过。AHE 反馈仅聚合相同 task/view/binding/sampling/environment 的固定 repetition slots；从已完成、standard normalized 的物理 trial 计算均值和宿主阈值判定。Evo 仅接受该批固定技能绑定的实际 overlay 证据，检索顺序与物理规范排序按同一选择集合核对，反馈仍保留原请求选择。

测试覆盖重复/缺失次数、错误任务/绑定/Campaign、非标准或不完整分数、阈值配置被调用者后续修改、两个技能反序选择及错误 commit。审计追加拒绝不同 producer operation 指向相同 evalId 或同一 (runId, attempt)，防止一次物理执行被计算为两次独立实验；同一 runId 的不同 attempt 不误判。此阶段使用合成完成 journal，真实完整算法和默认宿主仍在后续验收。

## S4b4 Evo 宿主技能读取与库产物

主 agent 在只含已提交 HEAD 与三个冻结文件的独立快照中运行 Evo capabilities、既有 DSH roles 和 Skill overlay：3 文件 24/24、完整 typecheck 通过。宿主通过窄 skills_list/skills_read 工具授权读取当前绑定库；每次核验角色/session、宿主 policy 和成员，交付前计入持久 evidence 用量并执行 hard limit。普通算法无需自行拼装 CAS ref 或发布库。

内置 publisher 验证 retriever 的成员/数量，curator 的 ADD、REVISE、MERGE、SKIP；生成封存单文件 Skill 与名称排序的新库，保留未修改成员的原 ref。测试覆盖未授权成员、错误角色、policy 变化、硬交付预算和库继承。这里只注册通用能力并使用合成数据测试，没有读取实际用户技能库或调用模型；默认宿主装配以及已知模型输出校验失败的终态处理继续审计。

## S3b7 独立 DSH 工作区编辑

主 agent 在只含已提交 HEAD 与三个冻结文件的独立快照中验证：workspace edit 8/8、完整 typecheck 通过。每个操作拥有独立 Git 工作区和 DSH session，公开受限 tree/read/write/edit/remove/check 工具，不依赖旧 candidate lease。检查通过后封存真实 Harness commit、变更清单、模型科学输出和验证回执；仅宣称实际编辑的 Harness 绑定。模型请求与 token 用量由持久 generation 状态及会话事件交叉核验。

主审修复：精确宿主输入在任何工作区/模型副作用前只计算一次，验证后把 prompt 和摘要写入 intent；resume 不重新生成。builder/workspace 来源必须一致，具体配置进入身份；实际 check/finalize 使用冻结截止时间。无变更或固定 compiler 拒绝有明确 no-result 和最终用量，科学 JSON 格式错误是执行错误；finalization 回包不明保留 unknown、禁止重做。

测试使用真实 DSH/Git 机制、离线模型及 compiler fixture，覆盖产物字节、计量、预启动取消、无变更、检查失败、科学输出独立封存、过大输入和不确定 finalization。开始后的取消确认、精确版本回滚及 GEPA production bridge 继续增量交付；未调用实际模型或容器。

## S3b8 已知模型输出失败的终态

主 agent 在只含已提交 HEAD 与四个冻结文件的独立快照运行 DSH role 与 Evo capabilities：21/21，完整 typecheck 通过。模型完成且最终用量可核验时，非法 JSON、schema 错误和确定性的 curator 校验失败现封存为类型化执行错误；恢复复用原结果，不再次请求模型。缺少最终用量或 publisher 存储结果不明时仍保留 unknown，不伪造零用量。

主审追加要求把库容量等纯校验放在写入任何 Skill body 之前；负例验证超限不发布产物。测试使用实际 DSH 会话机制和离线模型，没有调用外部模型。

## S4c 预测与回滚来源

主 agent 在独立冻结快照运行 Python SDK/recipes/真实 Optuna unittest：21/21，无跳过；RHO/AHE 跨语言 Campaign 测试 2/2 通过。AHE 的已变更版本必须给出非空、无重复且属于测量 cohort 的可检验预测；回滚明确引用先前实际测量的 BindingSet，并保留当前执行版本作为编辑基底。Evo 同时声明固定 Harness 与可更新技能库。

本提交验证科学意图与绑定协议；逐文件 Git 恢复和默认宿主的完整多轮算法测试分开验收。

## S3b9 精确 Git 恢复与取消边界

主 agent 在只含 HEAD 与两份冻结文件的独立快照验证 workspace suite 13/13，完整 typecheck 通过。通用 restore role 从指定封存 Git BindingSet 恢复列出的文件，不启动模型；测试验证修改恢复、新增文件删除、已删文件重建，以及未列文件保留。非法路径、保护文件和异 schema 来源在创建工作区前拒绝。

挂起模型请求收到取消后，若最终用量仍无法确认，保留 unknown 且不再次请求；已确认终态可以复用原回执。未消费必需 workplan 的编辑返回执行错误和实际用量，不算科学无改进。恢复角色通过公共配置使用，没有在内核添加 AHE 分支。Git finalization 结果不明仍需对账；本测试没有外部模型调用。

## S6B CLI 宿主装配与旧闭包核验

主 agent 在只含 HEAD 与四份冻结文件的独立快照验证 CLI host profile、legacy verifier 和既有 Python 桥：28/28，完整 typecheck 通过。host profile 可在创建 Campaign 前准备受管理 refs、provider 和冻结配置；TS provider 保留其物理实现身份，作者源码身份另外纳入 Campaign components。check/run/resume 都关闭宿主资源，准入失败也清理；未知能力和不支持的 CommonJS 导入明确拒绝。

verifyPinnedLegacySearchClosure 核验已归档 f715748 的 search/parent/package 字节，并拒绝缺失或漂移制品；该单测实际读取保存的旧 tgz，没有跳过。此 helper 不是整个 CLI/环境认证，也不隐式迁移历史状态。正式 npm 出口、包外 wheel/TS 使用及旧 runtime 跨进程恢复仍由后续发布包验收负责。

## S4d Fresh 与历史轨迹能力区分

主 agent 在独立冻结快照运行 Python SDK/recipe/Optuna unittest：22/22，无跳过。RHO/AHE 增加宿主明确指定的 historyTraceAvailable；false 时跳过不存在的历史 trace 查询，历史配置默认保留原下钻流程。FreshSeed 仍只授权真实任务内容，没有生成假轨迹或扩宽源权限；新 rollout 的轨迹继续用 producer 配对授权访问。

## S2/S3 默认物理宿主装配

主 agent 在已提交 HEAD 加冻结文件的独立快照验证 fresh/default profile：5/5，完整 typecheck 通过；同快照的 Python SDK 22/22 单独提交。默认宿主组合真实 seed TaskView、Hitch、DSH 角色、编辑、可信反馈和 Evo Skill 能力；宿主配置预算/模型目的地/角色，算法配置只保留科学参数。初始产物和任务 refs 由宿主创建，拒绝作者覆盖宿主管理字段。

配置在创建时复制，运行前检查身份漂移；角色 catalog 错误和装配失败会清理宿主且仅一次。AHE restore 使用既有 Git 恢复能力，并核验来源的实际完成 rollout。restricted DSH helper 可用于独立宿主，但不保存任意 DSH 会话；已封存 operation 可恢复，进程在未封存 turn 中退出仍需 unknown 对账。

这 5 项测试证明宿主装配、真实 Git/Hitch 录制协议及反馈接线，不等同于完整 Python 论文 recipe 的多轮运行。完整 RHO/AHE/Evo 流程、公开安装包构造示例和模型/GPU 实测继续各自验收。

## S6A 物理 GEPA 编辑桥

主 agent 在只含已提交 HEAD 与五份冻结代码/测试文件的独立快照复验：GEPA recipe、workspace edit 与物理 bridge 共 38/38，完整 typecheck 通过。物理 hook 通过独立 DSH 编辑操作生成并检查真实 Git Harness，验证实际 workplan/diagnosis 工具消费后封存证明；inner 的实际 model.requests/tokens 只映射到外层 GEPA operation 结算一次。

主审核对并修正：inspect 只读，不能在取消查询中偷偷启动编辑；只有确认 not-started 才允许同 key 重发，取消先写持久墓碑。冻结工作计划的截止时间限制实际编辑；已有不明副作用不能仅因过期伪造零用量。已确认完成但证明缺失、格式非法或为 null，返回类型化错误及实际用量，不能当作科学无改进或永久 pending。

测试使用离线模型、真实 DSH 工具/Git 和检查 fixture；重建 provider 不增加模型请求。公开装配示例说明旧 SearchJournal 的额外 finding handoff、standalone repair 与 pending import 尚未迁移，需冻结显式 findings 或继续原 runtime。正式包导出另行验收；没有验证真实模型质量。

## S4e 完整 Python Evo 两批验收

主 agent 在独立冻结快照执行完整 Evo 测试 1/1，完整 typecheck 通过。实际 Python recipe 经默认 DSH 宿主运行两批：首批失败后 proposer 查询并读取物理 tool-result trace、确认真实错误内容，再由 curator ADD 非空技能；第二批 retriever 通过 skills_list/read 读取新增内容，真实 Git overlay 的 commit/技能字节与 Hitch request、证据和回执一致。第二批 SKIP 保留原库。

两个批次有独立的原始 key、evalId 和 runId。重建 Python worker 与 Campaign runtime 后恢复完成，模型请求和 Hitch submit 次数不增加。测试使用真实 DSH/Git 与多运行录制 CLI，模型、runtime checker 和任务反馈为离线 fixture；验证完整接线和恢复，不证明模型实际学习效果。

## S3b10 并发任务投影与执行环境身份

主 agent 在仅含 HEAD 与两份冻结文件的独立快照运行 Hitch 四套测试及完整 Python Evo：13/13，完整 typecheck 通过。RHO 并行重复测量暴露同一投影目录的原子发布竞争；新适配层仅在 EEXIST/ENOTEMPTY 时重新进入原投影验证一次，验证已发布内容后复用，不增加评测提交。并发 12 次预检通过；投影内容损坏仍拒绝。旧 search/dataset-projection 和 Hitch evaluator 源码未改。

物理身份现在包含 Hitch CLI 实际继承的整个子进程环境摘要（覆盖 PYTHONDONTWRITEBYTECODE=1），并在操作准备时重新核对 evaluator/builder 配置。未列入 passEnv 的变量、评测配置或 builder 配置变化都拒绝；不保存或打印环境值。该策略保守要求恢复时保持相同环境，不能把配置中仅供运行容器转发的 passEnv 当作 CLI 自身全部环境。

## S4f 完整 Python AHE 三轮验收

主 agent 在独立冻结快照执行 AHE 完整流程 1/1，完整 typecheck 通过。实际 Python recipe/default host 在三个执行版本上完成 12 次独立任务测量；evolver 返回非空预测，attributor 查询并读取已授权 rollout 的失败 trace。第二轮任务退化触发指定文件的精确 Git 恢复，未列出的 marker 保留；下一候选进一步编辑 marker，第三轮实际测量该新 commit，未把未测候选当成测量结果。

重建 Python worker/Campaign runtime 后恢复完成，模型调用与 Hitch submit 次数均不增加。测试使用真实 DSH/Git、按实际提交 commit 内容取值的录制 Hitch 与离线模型，证明预测、归因、选择性回滚、后续测量和持久恢复的接线；没有外部模型或科学效果认证。

## S2/S3 管理员配置宿主

主 agent 在只含 HEAD 与两个冻结文件的独立快照运行配置/default/fresh 宿主 6/6，完整 typecheck 通过。createConfiguredFreshHostProfile 读取封闭源目录中的 JSON 配置，构造实际 HarnessBuilder/SubprocessHarnessCompiler/Hitch/workspace 与受限 DSH。管理员一次性提供模型注册和运行资源，普通算法继续仅接触科学参数与宿主封存 refs。

审计发现仅返回 destinationId 不能证明 adapter 可用，现验证实际 DSH provider 路由并解析 model info；未注册明确拒绝。配置、模型模块、执行文件、显式 runtimeResources 与实际继承环境进入身份；模型/资源源码变化在角色准入前拒绝。环境仅记录摘要。runtimeResources 的传递依赖仍由可信管理员完整声明，不提供自动闭包发现；路由与声明校验不证明远端模型权重身份。公开 CLI/安装包的宿主加载另行验收。
