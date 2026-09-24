# Gear 可扩展算法框架：实施方案 V3

- 日期：2026-09-24；状态：进入分阶段实施，公共 SDK 为 experimental。
- 工作树：`/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear`；分支：`codex/meta-agent-algorithm-plan`；起始代码：`f715748dad576d3055e4a9eaab21b36015348aee`。
- 本文是当前统一实施入口，合并并取代 [V2](meta-agent-algorithm-implementation-plan-v2.zh-CN.md) 与[训练补充](gear-rsi-model-training-architecture-assessment.zh-CN.md)中的实施安排。原文保留，供[独立 ultra 审查](meta-agent-unified-architecture-ultra-review.zh-CN.md)的引用与身份核对。
- 用户授权 GPT-6 Sol / xhigh 负责实现，主 agent 负责架构修订、审计、review 和阶段 commit。实现者不自行提交；主 agent 审核通过后提交。本轮没有 GPU 资源/凭据可用时不伪造实机认证。

## 1. 目标、交付和范围

框架承载“经验与反馈 → 算法决策 → 版本化对象更新 → 后续测量”的共同控制过程。GEPA、RHO、AHE、Evo-Harness 和固定 Harness 的 Slime agent-GRPO 分别拥有自己的流程；内核不增加唯一冠军、严格增分或固定四阶段评测。

Campaign 是一次持久实验运行；recipe 定义算法；operation 执行有副作用的具体工作；provider 实现物理能力；artifact/绑定记录实际执行对象。Meta Agent 是算法调用的角色服务，梯度循环由 Trainer 执行。

首版目标包括：公开 TS/Python 作者入口、运行/检查/恢复、持久内核、历史快照、角色证据接口、单份实现的 recipe、已有 Slime 的兼容周期与独立训练操作、仓库外打包验证。科学效果和论文完整复现分别报告，不由 toy 或接线测试代替。

首版暂不实现：任意 Python 调用栈恢复、通用 managed-children、不可重放实时队列、自动自修改 continuation、全套 SFT/DPO/蒸馏/编辑器训练、完整评价器共同进化。新方法能保存版本化产物不表示相应数值能力已经交付。

## 2. 对独立审查的处理

| 审查发现 | 本版决定 | 验收位置 |
| --- | --- | --- |
| F1：SDK 冻结过早 | 所有阶段保持 experimental；完整 SDK v1 必须经过仓库外 Harness 和真实独立 GRPO 路径。toy 后只可稳定已经验证的最小 wire 子集 | S6/S7 |
| F2：训练请求映射缺失 | 公开 frozen input→TrainingRequest 的字段映射；提取旧准入/产物验证，共用相同校验；legacy champion 与新绑定分离 | §8，S5 |
| F3：算法历史输入缺失 | ExperienceView 封存来源命名空间、快照、投影与暴露；recipe 和角色共用受管理查询 | §5，S3 |
| F4：在线流边界不清 | Evo 首版只消费已封存、可重放 TaskView；不声称支持任意实时源 | §5，S4 |
| F5：跨语言 hook 装配缺失 | component manifest、明确调用入口、类型化参数/结果/错误、环境身份；host 负责通信 | §6，S2 |
| F6：Python provider 作者面缺失 | 公开 provider SPI、加载器、artifact helper、幂等/用量回执与独立测试工具 | §6，S2/S6 |
| F7：评价器比较合同不足 | 先保存完整测量条件并提供严格比较 helper；完整 epoch/anchor 策略后续实现 | §7，S3 |

## 3. 三条作者路径与语言边界

1. **改现成算法**：安装 CLI/SDK/recipe，生成配置，改一个合法策略函数，check/run/resume；不编写 RPC、journal、digest 或租约代码。
2. **编写新循环**：命名 task/decision 步骤、业务状态、稳定 parallel key。副作用全部经 operation；SDK 管理激活身份、输出保存、汇合和恢复。
3. **新增物理能力/接研究库**：实现 provider 或库 adapter；SDK 提供注册、存储、恢复和用量测试工具。新 loss、样本格式和 token credit 的科学校验仍由作者实现。

TS/Python 共用版本化 JSON 协议；一个算法只维护一份科学实现。Python RHO 可被 TS 配置/调用；TS recipe 可使用 Python hook；训练后端继续是 Python。轻量 Python 作者包与 `python/gear_training` 分开，不默认依赖 Torch/CUDA。Python CLI/host 依赖明确展示，不谎称安装 wheel 即安装 Node 宿主。

默认教模板与步骤接口，低层 reducer 保留为进阶入口。合法 hooks 由 recipe manifest 列出，不接受静默忽略的覆盖。simple algorithm 的日志/错误展示步骤名称和可定位源码，不要求用户理解底层 journal 才能排查。

## 4. 公共协议、绑定与持久执行

实现落点：`src/algorithm/`，公共入口 `rsi-gear/algorithm` 与 `rsi-gear/algorithm/testing`；Python 分发和 import 名暂沿用 `gear-algorithm` / `gear_algorithm`。

算法接口包括 `describe/initialize/reduce`；纯决策返回 nextState、操作意图、可选 bindingTransition 与终态。worker 的内存缓存不作为恢复依据。状态仅保存规范化 JSON 和有 schema 的 refs；大文件和 checkpoint 存 artifact。

operation 至少包含稳定 localKey、kind、input、可选显式 bindingSetRef、limits；envelope 保存实际实现身份、输入摘要和权限/预算。schema 校验必须实际执行，不以 TypeScript 类型或任意 JSON 代替运行时验证。错误、取消、unknown 和科学上的零分/无改进分别表达。

**绑定优先级明确如下：** operation 显式指定的不可变 BindingSetRef 优先；省略时使用该 decision transition 后的默认绑定。旧 pending operation 永远保留原快照。显式候选绑定须通过同样的 schema/来源/权限检查，不能改变可修改范围。

因此同一 decision 可以同时评价 H0 与 H1，而不改变 active binding。`bindings.derive` 是受管理的组合封存操作，接受 baseRef 与获准 slot replacements，返回新 BindingSetRef；普通作者通过 helper 使用它，不写 CAS。独立 train operation 返回模型候选，采用结果时再提交 transition。

固定角色定义/职责/权限上限/provider 实现，动态更新获准模型、Harness、技能、环境、课程等 slot。角色 bindingMap 将局部模型名指向 slot；共享权重只需一个 shared slot。实际 materialization、模型/tokenizer/template/采样条件进入回执；可变 endpoint 名不能代替模型身份。

Campaign 保存不可变对象与单 writer journal head；状态、绑定、outbox、预算 reservation 在同一提交推进。写入对象后 fsync，再原子替换 head；验证锁、损坏和内容摘要。旧 operation 重启先 inspect，同 key 不同输入必须拒绝；仅确定 not-started 才重交。unknown 不当失败，不重置预算，不假定已释放外部资源。

支持 managed-steps 与 opaque-job。opaque provider 可拥有内部 checkpoint 和精确恢复能力，但不由此获得任意 Gear 子调度权限。默认并行 join 等待终态，结果按稳定 key 合并；结束或取消须处理未结算操作。

资源每维度注明单位、来源与限制能力。硬上限只适用于可实际执行的能力；GPU 停止阈值与最终用量分开，异步释放期间继续计费。累计 receipts 按来源身份和 cursor 只计增量，父子账本不重复计算。科学选择不得绕过已声明预算/权限。

## 5. 历史输入与任务视图

`ExperienceView` 至少封存：source namespace（部署/旧 evolution/campaign/import）、来源快照/cursor、条目内容 refs、允许 projection、用途/标签暴露、索引/schema 身份。每个 source 的 cursor 有自己的命名空间；不能把多个 journal 的整数游标当作同一时间线。

首版 import 接受封存清单及可核验来源；不默认赋予任意目录读取权限。跨旧实验的 importer 只导出授权投影；未知来源标注 imported/unverified，不能伪造原始执行 provenance。视图构建必须发生在 admission/受管理操作内，而不是决策步骤读取可变路径。

公共 `evidence.query/read` operation 供 recipe 使用；角色工具调用共用授权、分页与 receipt 实现。query 固定 view/asOf、scope、projection、稳定排序与页 token；token 绑定整个查询。结果和查询用量可恢复，追加外部轨迹不改变旧视图。overview→task report→trace chunk 支持按需取证；持有 digest 不等于有读取权。

RHO 的第一条路径必须从旧经验视图选 coreset，而不是在配置中手塞最终任务。研究输入不提供真实标签，独立评价资源由 provider 掌握。API、交付工作区、OS 隔离分别报告；可信本地 worker 不自动是恶意代码沙箱。

TaskView 包含封存、有稳定 ID 和顺序的任务集合。Evo 首版按其 cursor 消费；批次内技能绑定不变，批次完成时 skills 与 cursor 原子推进。自生成任务由 `tasks.publish` 继承来源、用途和暴露；不能改名成未见 final test。实时 queue 的 fetch/ack/replay 不在首版承诺。

## 6. Hook、provider 与 Python 的公开扩展面

component manifest 明确 id、apiVersion、实现/环境身份、language、entrypoint、input/output schema、能力与失败语义。配置中的 Python 入口为 interpreter + module/export；TS 为已构建 ESM module/export。不通过 wire 传函数、Python 对象或 pickle。

除算法调用外，worker 协议新增独立的 `component.describe/invoke` 和 provider 方法分发；功能由 manifest 能力发现，不把 hook 假扮成完整算法。hook 使用 `policy.decide` operation，参数和结果封存；恢复复用已提交结果，不再次调用已完成选择。跨语言 recipe facade 仅做装配，不复制算法。

provider SPI 统一 describe/preflight/submit/inspect/cancel/collect 的类型化请求与结果；同步本地操作可使用 SDK 提供的 durable operation helper。handle 与幂等 key 范围、输入摘要、结果保留期、检查点/用量/取消能力要明确。科学结果采用 union，区分 result/no-result/inconclusive 与执行错误；不凭零分推断错误。

provider 作者包声明自身 schema/codec。宿主验证 envelope/schema/refs/权限，provider 校验具体 mask、reward、optimizer 等语义。artifact helper 负责内容封存/读取、大小限制和引用；可信 Python codec 只在其 provider 环境反序列化已验证自有 checkpoint。

Python worker 使用专用本机连接、随机一次性凭据、消息长度限制和 request ID；stdout/stderr 只作日志。错误输出保留可定位信息且遵守秘密/数据投影。退出、迟到响应与实现漂移明确报错。只监听 loopback；本地受信任执行不宣称 OS sandbox。

公开 testkit 至少覆盖：同 key 重复 submit、输入漂移、submit 回包丢失、inspect 重启、结果重复、no-candidate、用量重复和取消未释放。仓库外 provider 不能依赖私有 registry。先用轻量 deterministic provider 验证作者工具链，再接真实 Slime/Optuna。

## 7. 测量、算法 recipes 与公共执行能力

measurement 必须关联 subject bindings、任务视图、provider/evaluator/rubric、采样/环境/预算条件、指标 schema 与原始 evidence。comparison key 定义直接可比较的条件；helper 对不兼容记录拒绝合并，不能把不同 judge 的分数直接算净增分。

完整 RQGM 的 epoch/anchor/选择策略是后续 recipe。首版只提供不可变测量条件、重评产生新记录的规则和基本兼容检查，不建设通用评价器演化引擎。

| 首版 recipe | 应有科学行为 | 首版输入边界 |
| --- | --- | --- |
| RHO（Python 单实现） | 历史 coreset、固定 baseline 重复 rollout、目录提案、成对软偏好、S>0 才替换 | 研究视图不提供真实标签；缩小 toy 与真实小规模配置分别标注 |
| AHE | 本轮先测上轮版本、核验预测、调查证据/回滚、生成下一版本 | executedRevision 与 best measured 分离，raw trace 可下钻 |
| Evo-Harness | 批内旧技能快照、检索并实际注入、逐题反馈、批末整理 | 封存 TaskView；技能与 cursor 同时提交 |
| GEPA | 保留父代/scope、failure cluster、任务阶段、archive/选择与预算语义 | 最终使用公共操作；旧 wrapper 仅作过渡 |
| Slime agent-GRPO | 固定 Harness、在线精确采样、权重更新、独立评价与算法选择 | 现有 runtime/样本/checkpoint 合同；不自动等于 Harness-R1 或 DPO |

rollout/feedback/角色编辑/provider 接线复用已有 Hitch/DSH 能力，但公共操作不依赖旧 candidate lease。新 job lease 与旧协议分离，workspace-edit 经 builder check/seal 返回实际版本，structured-result 不制造假 candidate。

## 8. 独立训练操作的具体接入

`training.legacy_cycle` 保留旧 coordinator 的完整实验语义，旧 champion 只有旧 coordinator 写。其结果按 outcome 返回实际存在的模型/checkpoint/评估/成本；no-update 不伪造候选。

独立 `training.slime` 只完成合法训练与候选产物校验，评测和选择由外围 recipe 编排。现有 `ModelTrainer` 与 Python driver/ledger/gateway 复用；从 coordinator 提取必要的请求准备、兼容性、产物与释放校验，共享实现，避免两套规则渐行渐远。

| 现有请求字段 | 新操作来源与约束 |
| --- | --- |
| experimentId | 从 campaign 身份导出的稳定 adapter namespace；不创建/借用旧 champion 来确定 parent |
| trainingRunId / idempotencyKey | 从 operation 身份派生并持久化，一次意图只有一个 run/key；重启复用 |
| parentModelRef / parentModel | operation 冻结 BindingSet 中 learnerBinding 所指的 ModelVersion，校验内容身份 |
| resumeCheckpointRef / coldStart | 由冻结 parent 与请求的明确续训状态决定；已有 trained model 不允许偷偷清空 optimizer |
| fixedHarness | frozen training plan 与操作绑定中的 Harness；必须满足当前 training-tool 合同 |
| referenceModelRef | 冻结训练计划明确提供；与 actor 的架构/tokenizer/template 兼容 |
| trainDataset / datasetSplitDigest | 来源明确的冻结训练 partition 与 split manifest；worker 只得到允许的训练投影，digest 保持旧含义 |
| trainer / rollout / recipeDigest | 冻结 provider schema 和 runtime lock，沿用旧 digest 计算字段；不能在一次恢复中改 recipe |
| budgets / devices / deployment | 由 operation reservation 与冻结运行配置生成；实际用量独立回执，节点/设备身份验证不省略 |
| trainingCompatibilityDigest | 共享旧计算器与准入检查，验证 weights、optimizer、runtime 和配置组合 |

提交顺序：封存输入/请求映射及意图 → preflight/兼容校验 → 按同一 key submit/inspect → 取得候选或 no-candidate → 验证 checkpoint/update ledger/HF 导出/资源释放 → 结算 → 外部评测 → recipe 选择并更新绑定。未知提交只 reconcile 原 key，不能创建新的 run。

当前 Slime 的候选成功分支必须有完整 checkpoint；训练模型 parser 的要求不被弱化。HF-only 后端属于另一个有完整来源的 schema/能力版本。已有单卡认证只覆盖历史冻结配置，新代码/接线不能借用其证明。

核心验收：Campaign learner=W0 而旧 champion=Wold 时，独立操作仍用 W0；恢复保留 run/handle/requestDigest；篡改 recipe/data/checkpoint 关联拒绝；同一真实/受控返回值在新旧验证器得到相同判定；no-candidate 不改绑定、不双计费。

## 9. Optuna 与库复用

沿用已选定的 Optuna ask/tell 适配试验，实施时核对实际可用的锁定版本与官方接口。若计划版本不可获取则公开记录并选取可验证的固定版本，不伪称安装成功。

adapter 管理不可变 study/sampler checkpoint，ask/tell 操作在副本上计算，输出封存后报告。两个 trial 的 Gear eval 在外层完成；恢复不重新 ask 已完成 trial，不只凭 RDB 宣称 sampler 状态保存。序列化只在可信 provider 自己的匹配环境内使用。

闭合 optimize/callback 库可以作为 opaque-job 接入，并明确恢复粒度；任意 callback 内部 Gear 子调度继续拒绝。相同算法无需 TS/Python 双写。

## 10. 阶段、审计与 commit

所有阶段先由 GPT-6 Sol / xhigh 实现，主 agent 独立检查 diff、执行适当测试、核对负例和文档，修复后才 commit。禁止把阶段编号或 toy 通过当作科学效果证明。阶段提交仅包含本阶段明确文件；不混入用户的其他工作。

| 阶段 | 交付 | 主审退出条件 |
| --- | --- | --- |
| S0：方案与基线 | 本文、原研究/评审归档、旧身份/构建/测试基线记录 | 确认旧代码闭包、依赖与测试入口；记录真实限制 |
| S1：公共合同与持久最小内核 | TS typed refs/schema、artifact/binding helper、provider SPI、journal/outbox、预算、步骤/testkit | 并行候选独立绑定；恢复不重做已完成副作用；身份/损坏/预算/取消反例；旧 search 通过 |
| S2：双语言作者与入口 | Python SDK/IPC、component hook/provider、独立开发 CLI init/check/run/resume、toy 项目 | 干净项目新循环与单 hook；stdout 噪声、错误类型、依赖缺失、跨语言恢复；轻量 Python provider 公开接入 |
| S3：历史/任务/测量与执行接线 | ExperienceView、recipe/角色查询、TaskView、比较条件、Hitch/role builders adapters | 旧历史快照稳定且无标签投影；角色下钻；实际版本回执；兼容分数检查 |
| S4：非 GEPA recipes 与库试验 | Python RHO、AHE、Evo、Optuna adapter/示例 | 用公共操作完成原流程；持久故障注入；技能真实注入；仓库外入口，不只 toy 公式 |
| S5：现有训练接入 | legacy_cycle 与独立 Slime adapter、公共固定 Harness GRPO recipe | 共享准入/产物校验、稳定身份映射、无双 writer/双计费、现有训练回归 |
| S6：GEPA 公共路径与发布包 | GEPA 公共 recipe、旧运行兼容、独立 tgz/wheel 使用、教程与能力报告 | 科学选择/预算/恢复对照；旧运行无隐式迁移；公共入口无内部 import |
| S7：真实运行与 SDK 稳定性决定 | 有界真实 Harness 与真实独立 GRPO 接线、独立作者走通 | 有真实凭据/运行条件才执行；无条件则明确未验收，SDK 继续 experimental |

S1 合同明确后 S2/S3 可在不共享文件的条件下并行，S4/S5 同理；commit 仍按依赖与审查顺序。若某阶段暴露接口错误，先修合同和现有消费者，不通过新增论文专属 core 分支绕过。

旧默认 parent policy 额外哈希整个 `package.json`，因此 S1/S2 暂不修改 manifest/lock，包导出统一在 S6 与旧运行兼容一起交付。新 CLI 可先用独立开发入口。S0/S1 不修改旧 search identity 的实现闭包。后续确需修改时，保存受支持旧实现与环境，并由匹配身份的旧 runtime 继续历史实验；不存在匹配制品时明确拒绝，不放松身份校验。旧到新导入是新实验，有 lineage，不能冒充 resume。新 CLI/package exports 的身份影响在 S0 审计并回归。

## 11. 验证与进度事实

优先运行针对改变语义的负例/恢复测试及 typecheck/build；阶段通过后不无故反复全套。最终运行受影响 search/training 与包外检查。GPU/真实模型效果验证只使用已有授权与实际可用环境，不自动创建付费云资源。

安装/包验证记录 Python/Node/依赖身份；Node 宿主与轻量 Python SDK 分开验证。独立开发者可用性验收未完成时如实列出，不以代码行数或 agent 自测冒充人工使用证据。

实施状态与命令结果记录到 `docs/meta-agent-algorithm-implementation-progress.zh-CN.md`，每个阶段写 commit、验证范围、未通过/未执行项。本文创建时 S1–S7 尚未实施；旧 GPU 验收仍仅为原冻结训练路径的归档证据。
