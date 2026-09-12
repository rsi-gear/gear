# Candidate 晋升策略验收跟踪

原始范围以 [规范第 13 节](candidate-promotion-and-specialist-archive-spec.zh-CN.md#13-验收矩阵) 及正文 MUST/MUST NOT 为准。此表用于持续核对，不缩减完成条件，也不以测试名称或测试数量代替行为证明。

工作目录始终为 `/private/tmp/gear-candidate-promotion-20260912`，分支 `codex/candidate-promotion`。主实验工作树仍在 `dev`；没有切换分支、重建其运行产物或改写实验状态。

## 当前结论

完整验收尚未完成。已交付主流程并继续补齐细节；已修复 scope 身份/完整性、证据一致性、过程覆盖率、bridge 差集费用、跨轮冻结身份、执行缓存与读取消费边界。本轮继续补齐外部未知状态、终态失败和超时恢复，新增专项位于 `search-recovery.spec.ts`。新增证据主要在 [search-acceptance.spec.ts](../tests/unit/search-acceptance.spec.ts)，原核心回归在 [search.spec.ts](../tests/unit/search.spec.ts)，实际 Git/Skill 接入在 [refine-service.spec.ts](../tests/unit/refine-service.spec.ts)。

内置 Hitch 未声明所需 subset/cell reuse 合同时明确拒绝启用，这是 E06 要求。真实 provider 接入和案例收益没有被合成 fixture 证明；当前没有向运行中实验启用该模式。

2026-09-12 本轮最终验证：`search.spec.ts`、`search-acceptance.spec.ts` 与 `refine-service.spec.ts` 共 143 项通过（最多两个 worker），含 1,000 任务完整路径与真实 Git/Skill 接入。补充回归曾运行 6 文件共 172 项通过，两组有重叠，不相加统计。类型检查、构建 TypeScript 编译、SDK 导入和 JSON schema 重建一致性检查通过。

本轮恢复专项检查：`search.spec.ts`、`search-acceptance.spec.ts`、`search-recovery.spec.ts` 和 `refine-service.spec.ts` 共 167 项通过；测试之间与前次记录有重叠。新增内容包含普通传输异常的原操作恢复、各阶段终态失败、超时只读查询、真实 Skill 停止与手动/重启恢复。

## 逐项核对

“已验证”仅指该行要求的已检查行为；不表示整个特性已经验收。其余条目保留为后续工作，不能据此把规范状态改成 Implemented。

| ID | 场景 | 当前结论与证据 |
| --- | --- | --- |
| A01 | A/B/C 三任务示例 | 已验证：原 search.spec.ts 的 A/B/C 前沿与 2/3、1/3 概率断言。 |
| A02 | 并列第一、联合冗余覆盖 | 已验证：联合覆盖剪枝、membership 归一化和可重建顺序均有针对性断言。 |
| A03 | 全 0、全 1 或全同分 | 已验证：全 0/1/同分、固定精度 fallback、无合格父代拒绝均已验证。 |
| A04 | 跨轮历史 specialist | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| A05 | 低 outcome、高 process | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| A06 | 同 tree 不同 commit/评分 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| A07 | archive 容量与冠军保活 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| A08 | exploration guard 与 bootstrap | 已验证：完整 baseline 与探索门在候选生成前生效；不合格版本不占前沿。 |
| A09 | 候选只完成 15/100 全局任务 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| A10 | 不同组难度、范围或规模不同 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| A11 | 同一候选多跑额外任务 | 已验证：额外评测不扩权；等价 scope 合并证据；伪造 equivalence、缩短计划被拒绝。 |
| A12 | scope epoch 更新 | 未完成：archive 的 epoch 资格切换已验证；确定周期更新与受预算约束的 scope preparation API 尚需补齐。 |
| D01 | 同一父代 3 类有效失败、上限 4 | 已验证：三个支持类别实际生成三个不同 workplans，最大槽位四，不补凑。 |
| D02 | 多父代 / 重复抽中同父代 | 未完成：需要历史 specialist 真正成为下一轮代码父代的端到端验收，覆盖重复抽中父代。 |
| D03 | 分类未知、只有 total score、基础设施 invalid | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| D04 | 共享诊断与候选读取 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| D05 | 零个可执行类别、生成重试或超预算 | 未完成：零诊断预算、零 actionable workplans、真实 Skill 截止停止与超时只读恢复已验证；跨重启的剩余生成尝试边界还需完整核对。 |
| D06 | 扩大 scope 的 baseline 推翻假设 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| D07 | 独立 sibling 生成与越界修改 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E01 | 比例配置下 N=100 / 1,000，4→2→1 候选扩评 | 已验证：原完整 100/1,000 任务 fixture，170/1,700 candidate seed cells；本轮回归仍通过。 |
| E02 | 跨组 bridge 比较 | 未完成：共同计划与准确差集预算已验证；globalTaskWeights 的配置语义仍需完整核对。 |
| E03 | bridge 并集或 guards 超上限 | 已验证：scope 并集/guards 超容量减少参与者；容量与费用分别记录原因。 |
| E04 | global/held-out 失败或预算不足 | 已验证：cell/时间预算不足及 provider 确认的终态失败保留局部研究；未知状态不提交、不换 finalist，恢复原操作。专项覆盖 local/bridge/global/held-out 四阶段。 |
| E05 | 局部平均退步但有独特改善 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E06 | 缺 subset/reuse 能力 | 已验证：provider 不具备 subset/reuse/idempotency 时，在任何生成或评测前拒绝。 |
| E07 | 互补候选 A/B | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E08 | 比例取整与可选限额 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E09 | 小全集、空任务池、任务重叠 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E10 | 非法比例/限额、空 seed、关闭某桶 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E11 | bridge 按比例不足以容纳并集/guards | 已验证：按冻结比例限制 bridge；所有 guards 必须容纳，不临时增容或删题。 |
| E12 | 规模解析后 resume / 新全集版本 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| P01 | 子代优于研究父代、弱于 champion | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| P02 | 宏平均最优但没有任务第一 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| P03 | outcome 持平、过程改善 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| P04 | outcome 改善、过程回归 | 已验证：结果改善时过程下界仍可拒绝，独立于 outcome 均分。 |
| P05 | protected task / assertion 退步 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| P06 | outcome-only 严格改善 / 完全中性 | 已验证：outcome-only 严格改善与中性拒绝、legacy 分支保留均有既有回归。 |
| P07 | seed 与 held-out 同集或同内容不同路径 | 已验证：内容重叠的独立验证拒绝；shared-set 模式 advisory 且不写 champion。 |
| M01 | 不支持 process / dataset-aggregate | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| M01b | trial scalar、detail_status=aggregate-only | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| M02 | 混合 benchmark process 适用范围 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| M03 | process=0 / missing / invalid | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| M04 | process 部分缺失、candidate 子集不同 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| M05 | direction/range/scorer/quantum 改变 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| M06 | projection / repair 后不能聚合 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| M07 | 不同重复次数、retry 与有效零分 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| M08 | 新旧 observation schema、promotion process off | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| M09 | 多过程量纲的 outcome 并列 | 未完成：需要异构过程组的独立下界与 outcome 并列测试，不以合成均分代替。 |
| M10 | 局部不适用 process，全局部分适用 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| R01 | restart / resume / repair | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| R02 | archive CAS 后 crash、champion CAS 后 crash | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| R03 | champion 并发变更 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| R04 | held-out 执行故障 | 已验证：明确失败保留 seed archive，使用独立执行原因码；未知状态保持原 handle，超时后仅查询原操作。实际 Git/Skill 手动恢复与重启路径也已通过。 |
| R05 | Skill 模式空 checkpoint | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| R06 | seed 已封存后的 held-out repair | 已验证：held-out 补评只运行一个原无效 cell；research digest、finalist 与 seed 执行不变。 |
| R07 | 历史 pending completion | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| R08 | diagnosis/workplan/各 rung 后崩溃 | 未完成：已覆盖 cell/diagnosis 落盘、workplan 消费、未解决 round 与 CAS 中断；各 rung 的中断窗口尚未覆盖完。 |
| R09 | n_local/n_local 完整，bridge n_local/n_bridge 未完 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| R10 | stage 决策已消费后收到补证据 | 未完成：已加入显式消费记录和 diagnosis/workplans 中断测试；还需与各 rung/历史 completion 全链路组合核对。 |
| G01 | 在线失败只有 prompt | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| G02 | 提案重复、含凭证、超上限 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| G03 | suite 新版本 | 未完成：suite materializer 与 provider 验证接口存在，需核对 protected 规则传递和真实新 admission 集成。 |
| G04 | held-out 失败 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| C01 | 历史 spec / round / component v1 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| C02 | 案例 shadow replay | 未完成：案例只读 shadow replay 工具及字节不变证明尚未完成；不能把合成测试当作案例回放。 |

## 矩阵之外仍需核对的正文要求

- 各个持久化协议对象的运行时结构与语义验证；现有 JSON schema 与生成脚本需保持一致。
- scope sampler 的子模式、模块、历史难度/成本与共享反例规则；确定周期 epoch 更新入口。
- 各 stage 的可观察决定、coverage、未评/待补/未扩评/发布决定，以及运行中的状态展示。
- 统一时间/生成/诊断/rollout/repair 预算的中断与恢复，不能因新的阶段或请求标签刷新。
- regression suite 的角色、保护规则、可复现输入与新 evolution 接入，不改原数据集。
- old component identities 与既有规范同步；最终构建、打包和兼容回归。

这些是原文已有要求的核对清单，不是新增需求。未验证、证据不足或已发现实现缺口时，目标保持进行中。

## 下一批实现优先级

1. 已补齐阶段终态失败/未知中断/时间耗尽的区分和恢复入口，继续核对各消费边界与生成重试的组合窗口。
2. `scopeSampling.epochPolicy` 当前仅支持 `stable`。补齐确定周期的 scope preparation / 差集预算与激活入口，并保持旧视图不变。
3. 增加未晋升历史 specialist 实际被抽中、相对该父代生成并消费真实 findings、相对独立 champion 晋升的完整测试。
4. 补齐运行中阶段状态、显式 StageDecision、global task weights 语义及回归 suite 的保护规则传递。
5. 继续覆盖尚未验证的数值/采样/约束/恢复场景，并实现只读案例 shadow replay。最终再按全部 65 行和正文复核。
