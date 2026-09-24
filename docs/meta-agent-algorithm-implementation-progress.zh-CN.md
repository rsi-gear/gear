# Gear 算法框架实施进度与审计

实施依据：[V3 实现方案](meta-agent-algorithm-implementation-plan-v3.zh-CN.md)。起点 `f715748dad576d3055e4a9eaab21b36015348aee`，分支 `codex/meta-agent-algorithm-plan`。实现由 GPT-6 Sol / xhigh 负责，主 agent 独立审计和提交。

## 阶段状态

| 阶段 | 状态 | 提交与验证 |
| --- | --- | --- |
| S0 方案/基线 | 已提交 `e5dfeb2` | V3、离线精确重建、source/build/parent/package 身份；6 文件 95 测试通过；重复捕获匹配，漂移期望拒绝 |
| S1 合同/内核 | 已提交 `f1ac3ef`；恢复修补 `e8979eb` | 最终 17 项内核测试；旧 search/identity 95 项；完整 typecheck 通过 |
| S2 Python/作者入口 | 主审通过，阶段提交 | 20 项跨语言、5 项 Python SDK；完整 typecheck；正式 package exports 待 S6 |
| S3 历史/任务/执行 | S3a、S3b1 主审通过，阶段提交；物理桥实现中 | 数据层与历史源 14 项通过；真实 Hitch 与角色桥待独立验收 |
| S4 非 GEPA recipes/Optuna | S4a 主审通过，阶段提交；物理接线继续 | Python 19 项、RHO/AHE/Optuna 跨语言 3 项通过；真实技能注入与 host profile 待验收 |
| S5 训练接入 | 主审通过，阶段提交 | 独立训练/评测/GRPO；44 项联合回归、2 项纯步骤测试与完整 typecheck 通过 |
| S6 GEPA/包发布验证 | 实现中 | 公共 GEPA recipe 与外部作者入口分开推进 |
| S7 真实运行/稳定性决定 | 未开始 | 无运行证据前 SDK 保持 experimental |

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
