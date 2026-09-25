# Gear 算法作者 SDK v4 收尾复审（R2）

**结论：方案层面无阻塞意见、无待修改的实质设计意见，可进入 A0。** 这表示两份规范性文档已足够一致，可以据此实现和验证；不表示新 SDK 已实现或 PoC 已通过。异步重放、复合前沿的成本、真实 Hitch 接线、历史制品和外部作者体验仍须按既定阶段门槛实测，失败时应修订方案。

本轮审阅的准确版本：

| 文档 | SHA256 |
| --- | --- |
| [v4 主方案](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md) | `a8ac94afcc7fec09eea7c4303fe81d59b6f2290757d2b7d740308fe31b57face` |
| [v4 作者合同](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md) | `56bd464f8bfef0f8e6e2fd27c3ddbbe62aa98782c0a23b29a24baec8c4b5379b` |

源码 HEAD 仍为 `a5011e879e11586c9b62da2ba894944d61fb7541`。本轮对照 [R1 审查](/private/tmp/gear-author-sdk-v4-review-r1-sol-xhigh.zh-CN.md)，重点重读主方案 §3.3–3.5、§6.4、§7 和作者合同 §1–3 的配置、执行、checkpoint 与示例段落，并静态搜索旧字段；源码行为与科学范式采用前两轮已核对的范围，本轮未重跑实验、未重读论文原文。没有修改两份文档、源码或服务器状态。

## R1 修正核验

| R1 意见 | R2 结果与证据 |
| --- | --- |
| 历史输入示例使用另一套 RunSpec 字段 | **关闭。** [主方案 §6.4:296–315](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:296) 与[作者合同 §3:99–114](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:99) 现在同为 RunSpec v2，历史示例仅将 `inputs.initialAgent` 换为精确历史候选 selector；`ctx.initial_agent` 是 Python SDK 命名，不改变 wire 的 camelCase。旧 `algorithm: ./algorithm.py:search` 仅出现在运行说明示意图，不是第二份 YAML 合同。 |
| A0 可仅测内置复合调用，绕开作者自定义 workflow | **关闭。** [主方案 A0:343](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:343) 与[作者合同 §1:26](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:26) 同时要求 Python `@workflow` 和 TS `workflow(fn)` 的作者定义分支、至少两个 managed await、嵌套 parallel、构造无副作用、冻结参数/只读捕获、分支独立、强停后逻辑地址/原 key 稳定；空 parallel 和重复消费也有负例。 |
| 同名 checkpoint 的版本和终态指向未定义 | **关闭。** [主方案 §3.3:126](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:126) 与[作者合同 §3:186](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:186) 一致：同一调用作用域内每个新逻辑步骤产生不可变版本，同一步重放复用 ref，并行子作用域隔离；inspect 从 journal 派生全部/最近版本，终态 outputs 封存显式值/ref，不动态查询 latest。两轮同名与重放进入 A0。 |

这些补充未与惰性 ManagedCall、逐波原子意图/全组 join、`collect` 业务失败和基础设施 `unknown` 分界冲突。[主方案 §3.5.1:155–169](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:155) 的逻辑路径由作用域/步骤/分支序号确定，checkpoint 同名多版本正可落在不同步骤地址。现有内核的全组终态后推进是可用的承载点，尚不能替代两语言 driver 的 A0 验证。

## 前七项与三条建议的收尾状态

| v3 审查主题 | R2 方案状态 | 仍需实施证明 |
| --- | --- | --- |
| 复合 parallel 前沿与恢复 | **closed**：惰性 ManagedCall、路径、逐波 join、collect/unknown/cancel、作者自定义包装器验收均定义。 | A0 双语言嵌套/不等长分支、业务失败、强停及原 key。 |
| 随机、时间、IO 与有状态库边界 | **closed**：作者合同规定 observe、冻结来源、直接外部 IO 和 finally 边界，承认不能发现任意隐藏 IO。 | A0 两语言正反例及诊断覆盖范围。 |
| 200 frontier 与复合成本 | **closed**：F/O/J 各有口径；200 仅是试验候选；代表性完整轨迹决定发布默认值。 | A0 10 task×3 round×4 candidate 和 RHO 轨迹、冷恢复及完整链读取实测。 |
| 最小作者路径与 propose/evaluate 结果 | **closed**：完整项目、唯一 RunSpec、ProposalBatch/Evaluation 状态及配置责任可审查。 | A1 安装后真实小任务与外部作者计时。 |
| Python/TS provider 低层出口 | **closed**：两语言装载、权限/预算和 typed `ctx.operation` 已规定，未将科研扩展锁死在核心注册表。 | A1 外部 provider 跨语言 smoke。 |
| 旧 Gear/Hitch 历史与制品闭包 | **closed**：分项查看/经验/可运行资产，Hitch 用标准读取接口，导入报告给出不可复用原因。 | A0 盘点、A1 真实非 winner、A2 多年代/失败/训练样本分项验收。 |
| 试用被完整迁移阻挡 | **closed**：A1 先提供窄竖切和非实现者试用，A2/A3 后续扩展。 | A1/A3 外部试用者实际完成；缺席不得宣称易用性已通过。 |

前三轮的三条非阻塞建议也维持 **closed**：explain/inspect 暴露权限、目的地、展开和成本；默认 archive 有 typed-ref 边与自定义 schema 出口；历史报告有稳定 reason code。R1 的 checkpoint 建议已由本轮第三项正式解决。没有发现新增的必须修改项。

## 三项判断与进入 A0 后的门槛

**可实现性：有条件可实施。** 稳定路径与逐波合并同现有 Campaign 意图/结果及组终态机制相容；不能由此断言 Python coroutine、TS thenable 在构造、暂停、异常清理和冷重放时已经正确。A0 必须以作者自定义复合 workflow、真实展开的 evaluate/propose 轨迹、强停和 F/O/J 成本作停止门；若这些核心语义失败，应先改方案，不把失败下放给作者避开。

**扩展性：方案层面良好。** Proposal/Evaluation、独立任务/环境/评价器 refs、archive 和双语言 provider/typed operation 为 Harness 演化、训练及混合优化保留入口；固定 Harness 训练的实际新权重路由与资源释放仍属于 A5，交替优化未被承诺为首期成果。未把未承诺的科学策略列为首期缺陷。

**易用性：合同完整，但需 A1 证实。** 管理员 profile 与普通作者五文件项目的责任清楚，模板、manifest、schema 和 digest 的生成责任明确。30 分钟目标从已通过 profile check 的安装开始；A1 必须记录外部作者遇到的文件、诊断、管理员交互和是否改动核心，不能用静态示例代替试用。

进入 A0 后不可跳过：两语言自定义及内置复合调用的故障矩阵；空 parallel、重复消费、同名 checkpoint 版本；历史 key/预算对账；代表性 F/O/J、内存和冷恢复成本，并在测量前冻结标准。随后 A1 的 Hitch 小任务和外部作者试用、A2 的真实历史读取与制品可用性、A5 的训练新权重/GPU/释放验证、A6 的 FCS 差分与历史回归仍各有独立门槛。旧 journal 不需由新 runtime 原地 resume，Hitch 继续作为正式依赖使用其标准读接口。
