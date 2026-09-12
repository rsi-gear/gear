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
| A04 | 跨轮历史 specialist | 已验证：历史未晋升 specialist 保留在下一轮并成为真实代码/证据父代，未重新生成该版本；见 search-history.spec.ts。 |
| A05 | 低 outcome、高 process | 已验证：低 outcome / 高 process 的版本获得独立过程前沿概率，默认发布仍因 outcome 回归拒绝，见 search-metrics.spec.ts。 |
| A06 | 同 tree 不同 commit/评分 | 已验证：相同 tree 不同 commit 保留原证据与 lineage，不按幸运分挑代表；按实际完成时间比较不同时区的时间戳。执行缓存仍要求 exact commit/manifest。 |
| A07 | archive 容量与冠军保活 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| A08 | exploration guard 与 bootstrap | 已验证：完整 baseline 与探索门在候选生成前生效；不合格版本不占前沿。 |
| A09 | 候选只完成 15/100 全局任务 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| A10 | 不同组难度、范围或规模不同 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| A11 | 同一候选多跑额外任务 | 已验证：额外评测不扩权；等价 scope 合并证据；伪造 equivalence、缩短计划被拒绝。 |
| A12 | scope epoch 更新 | 已验证：配置周期、冻结共享清单/历史截止点/参与者、缓存差集费用和下一轮激活；预算不足或 baseline 不完整/失败时保留旧 epoch，准备中断恢复原操作，见 search-epochs.spec.ts。 |
| D01 | 同一父代 3 类有效失败、上限 4 | 已验证：三个支持类别实际生成三个不同 workplans，最大槽位四，不补凑。 |
| D02 | 多父代 / 重复抽中同父代 | 已验证：重复抽中同一历史父代与两个不同历史父代同时参与均覆盖；各子代的代码身份、dossier 引用和 findings 绑定各自实际父代，不凑无证据的工作槽位。 |
| D03 | 分类未知、只有 total score、基础设施 invalid | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| D04 | 共享诊断与候选读取 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| D05 | 零个可执行类别、生成重试或超预算 | 未完成：零诊断预算、零 actionable workplans、真实 Skill 截止停止与超时只读恢复已验证；跨重启的剩余生成尝试边界还需完整核对。 |
| D06 | 扩大 scope 的 baseline 推翻假设 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| D07 | 独立 sibling 生成与越界修改 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E01 | 比例配置下 N=100 / 1,000，4→2→1 候选扩评 | 已验证：原完整 100/1,000 任务 fixture，170/1,700 candidate seed cells；本轮回归仍通过。 |
| E02 | 跨组 bridge 比较 | 已验证：bridge 所有参与者与 anchor 使用同一清单、uniform 任务权重，费用按缓存差集；任务自带权重和不同重复次数均不改变这项宏平均规则。 |
| E03 | bridge 并集或 guards 超上限 | 已验证：scope 并集/guards 超容量减少参与者；容量与费用分别记录原因。 |
| E04 | global/held-out 失败或预算不足 | 已验证：cell/时间预算不足及 provider 确认的终态失败保留局部研究；未知状态不提交、不换 finalist，恢复原操作。专项覆盖 local/bridge/global/held-out 四阶段。 |
| E05 | 局部平均退步但有独特改善 | 已验证：局部加权均分低于父代的版本仍保留单题专长并在下一轮被实际抽到；研究资格没有成为全局通过结论。 |
| E06 | 缺 subset/reuse 能力 | 已验证：provider 不具备 subset/reuse/idempotency 时，在任何生成或评测前拒绝。 |
| E07 | 互补候选 A/B | 已验证：互补 A/B 同时保留；无单题第一的 C 仍按自己的证据独立提名，拼接 A/B 原始 cells 冒充 C 被拒绝。 |
| E08 | 比例取整与可选限额 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E09 | 小全集、空任务池、任务重叠 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E10 | 非法比例/限额、空 seed、关闭某桶 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| E11 | bridge 按比例不足以容纳并集/guards | 已验证：按冻结比例限制 bridge；所有 guards 必须容纳，不临时增容或删题。 |
| E12 | 规模解析后 resume / 新全集版本 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| P01 | 子代优于研究父代、弱于 champion | 已验证：相对历史父代生成并改善局部任务，bridge 仍使用独立 anchor，拒绝弱于 champion 的发布路径。 |
| P02 | 宏平均最优但没有任务第一 | 已验证：宏平均 C 没有任务第一且被研究剪枝，仍可由独立排名提名，并通过自己的完整 seed/held-out 证据晋升。 |
| P03 | outcome 持平、过程改善 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| P04 | outcome 改善、过程回归 | 已验证：结果改善时过程下界仍可拒绝，独立于 outcome 均分。 |
| P05 | protected task / assertion 退步 | 已验证：单任务/单 assertion 退步不能被总体增益抵消，缺 assertion 为不足证据，重复 assertion 身份被拒绝。 |
| P06 | outcome-only 严格改善 / 完全中性 | 已验证：outcome-only 严格改善与中性拒绝、legacy 分支保留均有既有回归。 |
| P07 | seed 与 held-out 同集或同内容不同路径 | 已验证：内容重叠的独立验证拒绝；shared-set 模式 advisory 且不写 champion。 |
| M01 | 不支持 process / dataset-aggregate | 已验证：dataset-aggregate 过程合同走合法 outcome 路径，不尝试逐任务 process 投影；原生无过程 fixture 的完整流程保持。 |
| M01b | trial scalar、detail_status=aggregate-only | 已验证：无 assertion 的 trial scalar 仍可进入过程前沿并支持 outcome 持平时的晋升。 |
| M02 | 混合 benchmark process 适用范围 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| M03 | process=0 / missing / invalid | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| M04 | process 部分缺失、candidate 子集不同 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| M05 | direction/range/scorer/quantum 改变 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| M06 | projection / repair 后不能聚合 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| M07 | 不同重复次数、retry 与有效零分 | 已验证：支持每任务不同逻辑 slots，先任务内再任务间平均；统计分母、阶段费用、配对一致，duplicate/retry 不加权，有效零分不可替换。 |
| M08 | 新旧 observation schema、promotion process off | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| M09 | 多过程量纲的 outcome 并列 | 已验证：异构组要求显式各组阈值，分别检查下界；outcome 并列时不合成过程均分，按 canonical ID 排名，minimize 增益方向正确。 |
| M10 | 局部不适用 process，全局部分适用 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| R01 | restart / resume / repair | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| R02 | archive CAS 后 crash、champion CAS 后 crash | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| R03 | champion 并发变更 | 待完整核对：现有实现/测试不能直接作为该行全部要求的证明。 |
| R04 | held-out 执行故障 | 已验证：明确失败保留 seed archive，使用独立执行原因码；未知状态保持原 handle，超时后仅查询原操作。实际 Git/Skill 手动恢复与重启路径也已通过。 |
| R05 | Skill 模式空 checkpoint | 部分验证：历史 findings 被实际传入生成输入且诊断绑定父代；真实 Skill 空 checkpoint 的跨轮组合还需核对。 |
| R06 | seed 已封存后的 held-out repair | 已验证：held-out 补评只运行一个原无效 cell；research digest、finalist 与 seed 执行不变。 |
| R07 | 历史 pending completion | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| R08 | diagnosis/workplan/各 rung 后崩溃 | 未完成：已覆盖 cell/diagnosis 落盘、workplan 消费、未解决 round 与 CAS 中断；各 rung 的中断窗口尚未覆盖完。 |
| R09 | n_local/n_local 完整，bridge n_local/n_bridge 未完 | 已验证：local 范围完整、bridge 仅部分完成时保留原局部资格；冻结不足证据的 bridge 决定，不临时改提名另一候选，状态分别报告两个计划的覆盖率。 |
| R10 | stage 决策已消费后收到补证据 | 未完成：已加入显式消费记录和 diagnosis/workplans 中断测试；还需与各 rung/历史 completion 全链路组合核对。 |
| G01 | 在线失败只有 prompt | 已验证：只有 prompt 的在线失败保留 needs-fixture，不能物化评分；基础设施 invalid 进入执行修复分支。 |
| G02 | 提案重复、含凭证、超上限 | 已验证：按语义/fixture/grader 去重，过滤凭证与个人信息、限制提案容量；同 prompt 不同 grader 不错误合并。 |
| G03 | suite 新版本 | 已验证：完整 suite manifest 和 provider 证明在新 admission 校验；protected guards 封存并强制执行、development 不隐式加门，换版本拒绝继续旧 evolution，新 evolution 重新取得成对证据。真实控制面 admission 不修改运行参数或源数据。 |
| G04 | held-out 失败 | 已验证：held-out 来源不生成提案，已知 regression suite 不能作为 held-out；收集在 seed research 封存过程中完成。 |
| C01 | 历史 spec / round / component v1 | 部分验证：新增验收测试覆盖部分行为，需继续核对该行其余要求。 |
| C02 | 案例 shadow replay | 未完成：案例只读 shadow replay 工具及字节不变证明尚未完成；不能把合成测试当作案例回放。 |

## 矩阵之外仍需核对的正文要求

- 各个持久化协议对象的运行时结构与语义验证；现有 JSON schema 与生成脚本需保持一致。
- scope sampler 已加入子模式、模块、历史难度/成本、成功反例及 cross 共享模块优先规则；正在验证与所有阶段和恢复组合的兼容性。
- local/bridge 的显式决定与运行中 seed coverage 已接入；继续核对阶段消费边界的全部中断组合。
- 统一时间/生成/诊断/rollout/repair 预算的中断与恢复，不能因新的阶段或请求标签刷新。
- regression suite 的角色、保护规则与新 evolution 接入已验证；真实 provider 的物化证明仍由接入方负责。
- old component identities 与既有规范同步；最终构建、打包和兼容回归。

这些是原文已有要求的核对清单，不是新增需求。未验证、证据不足或已发现实现缺口时，目标保持进行中。

## 下一批实现优先级

1. 已补齐阶段终态失败/未知中断/时间耗尽的区分和恢复入口，继续核对各消费边界与生成重试的组合窗口。
2. 周期 scope preparation 已实现并验证；sampler 的模块/子模式/历史难度分层和成功反例已实现，专项 11 项通过，继续全流程回归。
3. 历史 specialist 重复抽中、真实生成输入/findings 与独立 champion 已通过；两个不同历史父代同时参与也已验证；继续核对真实 Skill 跨轮空 checkpoint。
4. global task weights、异构 repetitions、运行中 seed 状态、显式 StageDecision 和回归 suite 保护规则传递已补齐；继续复核协议对象和消费链。
5. 继续覆盖尚未验证的数值/采样/约束/恢复场景，并实现只读案例 shadow replay。最终再按全部 65 行和正文复核。

2026-09-12 阶段决策/回归集修复后，8 个搜索测试文件共 105 项通过（最多两个 worker）；实际 Git/Skill 接入专项另有 6 项通过。类型检查和构建 TypeScript 编译通过。测试集合与历史记录有重叠，不累加宣称总数。

Sampler 全流程验证：9 个搜索测试文件共 108 项通过。成功反例特征与 dossier 交付的最后调整另行运行 4 文件 16 项测试，实际 Git/Skill 的 6 项也再次通过；类型检查和构建编译通过。
