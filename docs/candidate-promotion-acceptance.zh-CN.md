# Candidate 晋升策略验收跟踪

原始范围以 [规范第 13 节](candidate-promotion-and-specialist-archive-spec.zh-CN.md#13-验收矩阵) 及正文 MUST/MUST NOT 为准。此表用于持续核对，不缩减完成条件，也不以测试名称或测试数量代替行为证明。

工作目录始终为 `/private/tmp/gear-candidate-promotion-20260912`，分支 `codex/candidate-promotion`。主实验工作树仍在 `dev`；没有切换分支、重建其运行产物或改写实验状态。

## 当前结论

规范 65 行及相关正文已逐项核对完成。核心路径、真实 Git/Skill 接入、持久化中断恢复和数值边界均由自包含 fixture 验证；真实案例另有只读 shadow replay，不作为 CI 依赖。

默认 evaluator 的任务子集、逐题复用与阶段调度由 Gear 内部适配，Hitch 无需新增能力声明。当前没有向运行中实验启用新模式，没有把合成 fixture 或历史回放解释为真实新实验收益。

## 逐项核对

下表记录各行对应的行为证据；最终验证批次和外部接入限制见文末。

| ID | 场景 | 当前结论与证据 |
| --- | --- | --- |
| A01 | A/B/C 三任务示例 | 已验证：原 search.spec.ts 的 A/B/C 前沿与 2/3、1/3 概率断言。 |
| A02 | 并列第一、联合冗余覆盖 | 已验证：联合覆盖剪枝、membership 归一化和可重建顺序均有针对性断言。 |
| A03 | 全 0、全 1 或全同分 | 已验证：全 0/1/同分、固定精度 fallback、无合格父代拒绝均已验证。 |
| A04 | 跨轮历史 specialist | 已验证：历史未晋升 specialist 保留在下一轮并成为真实代码/证据父代，未重新生成该版本；见 search-history.spec.ts。 |
| A05 | 低 outcome、高 process | 已验证：低 outcome / 高 process 的版本获得独立过程前沿概率，默认发布仍因 outcome 回归拒绝，见 search-metrics.spec.ts。 |
| A06 | 同 tree 不同 commit/评分 | 已验证：相同 tree 不同 commit 保留原证据与 lineage，不按幸运分挑代表；按实际完成时间比较不同时区的时间戳。执行缓存仍要求 exact commit/manifest。 |
| A07 | archive 容量与冠军保活 | 已验证：生成上限 4 不裁掉 16 个唯一专长；champion 被研究剪枝后仍保留不可变 snapshot，并可从持久化 archive 恢复。 |
| A08 | exploration guard 与 bootstrap | 已验证：完整 baseline 与探索门在候选生成前生效；不合格版本不占前沿。 |
| A09 | 候选只完成 15/100 全局任务 | 已验证：15/15 局部 outcome 完整的候选获得父代资格；其余 85 道报告 notEvaluated，既不计零也不阻塞。见 search-contracts-final.spec.ts。 |
| A10 | 不同组难度、范围或规模不同 | 已验证：不同 scope 的难度、规模与额外评测不改变外层 family 权重；组内排名与 bridge 共同比较独立。见 search-acceptance.spec.ts。 |
| A11 | 同一候选多跑额外任务 | 已验证：额外评测不扩权；等价 scope 合并证据；伪造 equivalence、缩短计划被拒绝。 |
| A12 | scope epoch 更新 | 已验证：配置周期、冻结共享清单/历史截止点/参与者、缓存差集费用和下一轮激活；预算不足或 baseline 不完整/失败时保留旧 epoch，准备中断恢复原操作，见 search-epochs.spec.ts。 |
| D01 | 同一父代 3 类有效失败、上限 4 | 已验证：三个支持类别实际生成三个不同 workplans，最大槽位四，不补凑。 |
| D02 | 多父代 / 重复抽中同父代 | 已验证：重复抽中同一历史父代与两个不同历史父代同时参与均覆盖；各子代的代码身份、dossier 引用和 findings 绑定各自实际父代，不凑无证据的工作槽位。 |
| D03 | 分类未知、只有 total score、基础设施 invalid | 已验证：无支持机制时保留 unresolved 且 K=0，不造 process 或共同根因；invalid 不形成业务假设，证据引用必须匹配父代实际任务。合法 outcome-only 路径和执行修复分别覆盖。 |
| D04 | 共享诊断与候选读取 | 已验证：同父代只诊断一次；各候选只取得相关有来源摘要，并用绑定 candidate/session/workplan/dossier 的消费 receipt。真实 Skill claim 不伪造全量 diagnosis receipts，旧规则继续回归。 |
| D05 | 零个可执行类别、生成重试或超预算 | 已验证：无可执行类别/诊断预算时 K=0；真实控制面在两次生成尝试之间退出并重启后，保留同一 candidate、父代、workplan、已失败尝试、截止时间和预算，仅执行剩余尝试。时间耗尽不启动新操作。 |
| D06 | 扩大 scope 的 baseline 推翻假设 | 已验证：历史父代新范围的 baseline 未支持原假设时记录 hypothesis-unconfirmed，取消该槽位；实际生成三项而非凑四项，父代每次只诊断一次。见 search-history.spec.ts。 |
| D07 | 独立 sibling 生成与越界修改 | 已验证：所有 sibling 生成期间尚无 candidate rollout，每个 snapshot 仅一个实际代码父代。workplan 预声明越界要求完整 seed；原 scope 不足时只保留研究，已预先覆盖全集时仍须通过后续发布门。见 search-stages.spec.ts。 |
| E01 | 比例配置下 N=100 / 1,000，4→2→1 候选扩评 | 已验证：原完整 100/1,000 任务 fixture，170/1,700 candidate seed cells；本轮回归仍通过。 |
| E02 | 跨组 bridge 比较 | 已验证：bridge 所有参与者与 anchor 使用同一清单、uniform 任务权重，费用按缓存差集；任务自带权重和不同重复次数均不改变这项宏平均规则。 |
| E03 | bridge 并集或 guards 超上限 | 已验证：scope 并集/guards 超容量减少参与者；容量与费用分别记录原因。 |
| E04 | global/held-out 失败或预算不足 | 已验证：cell/时间预算不足及 provider 确认的终态失败保留局部研究；未知状态不提交、不换 finalist，恢复原操作。专项覆盖 local/bridge/global/held-out 四阶段。 |
| E05 | 局部平均退步但有独特改善 | 已验证：局部加权均分低于父代的版本仍保留单题专长并在下一轮被实际抽到；研究资格没有成为全局通过结论。 |
| E06 | Gear 子集执行与逐题复用 | 已验证：普通 evaluator 无 search 声明时，默认 Gear 适配跑通 outcome-only / outcome+process 的 4→2→1（170 次 candidate seed）；真实 Git/Skill 默认入口可晋升，原数据哈希不变。自定义 provider 的合同检查保留，结果身份不明不重跑。 |
| E07 | 互补候选 A/B | 已验证：互补 A/B 同时保留；无单题第一的 C 仍按自己的证据独立提名，拼接 A/B 原始 cells 冒充 C 被拒绝。 |
| E08 | 比例取整与可选限额 | 已验证：精确 ceil(N×ratio)、min/max、全集上限与实际池不足记录均覆盖；改变 bucketWeights 不改变数量。见 search.spec.ts 和 search-contracts-final.spec.ts。 |
| E09 | 小全集、空任务池、任务重叠 | 已验证：重复任务去重、同桶回填、池不足按实际成员计分；小全集按 shared/local/cross 优先序保存取整超额原因，既不复制任务也不虚报最低数量。 |
| E10 | 非法比例/限额、空 seed、关闭某桶 | 已验证：非有限/越界比例、局部比例和、负数/非整数/冲突限额、空全集和零 local 均拒绝；关闭 shared/cross 不抽题，必需 core 不能关闭，guard 仍进入清单。bridge 关闭时没有发布。 |
| E11 | bridge 按比例不足以容纳并集/guards | 已验证：按冻结比例限制 bridge；所有 guards 必须容纳，不临时增容或删题。 |
| E12 | 规模解析后 resume / 新全集版本 | 已验证：同一 evolution/round 恢复冻结原 N、规则、任务清单与 sizing digest；原地换规则或任务身份被拒绝，新的 admission 才能重新解析。见 search-acceptance.spec.ts、search-epochs.spec.ts。 |
| P01 | 子代优于研究父代、弱于 champion | 已验证：相对历史父代生成并改善局部任务，bridge 仍使用独立 anchor，拒绝弱于 champion 的发布路径。 |
| P02 | 宏平均最优但没有任务第一 | 已验证：宏平均 C 没有任务第一且被研究剪枝，仍可由独立排名提名，并通过自己的完整 seed/held-out 证据晋升。 |
| P03 | outcome 持平、过程改善 | 已验证：完整 driver 的 global seed 和 held-out 两阶段都接受结果持平、过程严格改善，没有旧 seed gate 提前阻断。 |
| P04 | outcome 改善、过程回归 | 已验证：结果改善时过程下界仍可拒绝，独立于 outcome 均分。 |
| P05 | protected task / assertion 退步 | 已验证：单任务/单 assertion 退步不能被总体增益抵消，缺 assertion 为不足证据，重复 assertion 身份被拒绝。 |
| P06 | outcome-only 严格改善 / 完全中性 | 已验证：outcome-only 严格改善与中性拒绝、legacy 分支保留均有既有回归。 |
| P07 | seed 与 held-out 同集或同内容不同路径 | 已验证：内容重叠的独立验证拒绝；shared-set 模式 advisory 且不写 champion。 |
| M01 | 不支持 process / dataset-aggregate | 已验证：dataset-aggregate 过程合同走合法 outcome 路径，不尝试逐任务 process 投影；原生无过程 fixture 的完整流程保持。 |
| M01b | trial scalar、detail_status=aggregate-only | 已验证：无 assertion 的 trial scalar 仍可进入过程前沿并支持 outcome 持平时的晋升。 |
| M02 | 混合 benchmark process 适用范围 | 已验证：过程分母来自冻结任务合同；不适用任务不产生 process=0，不随 candidate 输出改变集合。混合适用范围的 local/global profile 和零权重 guard 均覆盖。 |
| M03 | process=0 / missing / invalid | 已验证：有效 process=0 保留；missing 与 invalid 分别计数并维持 pending，已声明能力缺失不降级为完整过程证据。旧 invalid 与独立认证 v2 outcome 区分。 |
| M04 | process 部分缺失、candidate 子集不同 | 已验证：不同 candidate 只完成不同过程子集时，两者均无过程前沿/aggregate；显示各自固定分母与 coverage，补齐 revision 才更新资格。 |
| M05 | direction/range/scorer/quantum 改变 | 已验证：方向、量程、scorer 与 quantum 纳入合同/执行身份；不同合同拒绝配对。minimize、十进制半边界、可传递并列与精确增益 keys 均有断言。 |
| M06 | projection / repair 后不能聚合 | 已验证：Meta 投影重新计算完整性与过程组，不能聚合时不保留顶层 processScore/summary.process；缺 outcome 拒绝投影为完整 baseline。补评及过程恢复保留原有效值。 |
| M07 | 不同重复次数、retry 与有效零分 | 已验证：支持每任务不同逻辑 slots，先任务内再任务间平均；统计分母、阶段费用、配对一致，duplicate/retry 不加权，有效零分不可替换。 |
| M08 | 新旧 observation schema、promotion process off | 已验证：旧 invalid 无法抢救；v2 独立认证 outcome 在发布 process off 时通过完整晋升路径，研究视图仍如实保留过程缺失。 |
| M09 | 多过程量纲的 outcome 并列 | 已验证：异构组要求显式各组阈值，分别检查下界；outcome 并列时不合成过程均分，按 canonical ID 排名，minimize 增益方向正确。 |
| M10 | 局部不适用 process，全局部分适用 | 已验证：local 的过程适用集可以为空，合法使用 outcome；global 的固定适用集仍要求全部完成，不能沿用局部完整结论。 |
| R01 | restart / resume / repair | 已验证：冻结抽样、父代与基线跨进程恢复；已完成 execution key 不重跑。15 个持久化中断窗口及真实 Skill 手动/重启恢复通过。 |
| R02 | archive CAS 后 crash、champion CAS 后 crash | 已验证：原 commit intent 对账、archive CAS 恢复及真实控制面 champion CAS 成功后异常均通过；后者只有一次物理 champion 写入。终态落盘后的旧 active-round 标记在恢复时清理。 |
| R03 | champion 并发变更 | 已验证：CAS 冲突保留外部版本、原 anchor 与 commit intent；重复恢复不生成、不评测、不偷换比较对象。 |
| R04 | held-out 执行故障 | 已验证：明确失败保留 seed archive，使用独立执行原因码；未知状态保持原 handle，超时后仅查询原操作。实际 Git/Skill 手动恢复与重启路径也已通过。 |
| R05 | Skill 模式空 checkpoint | 已验证：真实临时 Git/Skill 跨轮并重启，两个 checkpoint 的 eventCount 均为 0；新候选读取到未晋升 specialist 的代码文件、实际父代 dossier 和完整 findings，champion 始终为独立原版本。 |
| R06 | seed 已封存后的 held-out repair | 已验证：held-out 补评只运行一个原无效 cell；research digest、finalist 与 seed 执行不变。 |
| R07 | 历史 pending completion | 已验证：只对已提交 archive 的原计划补缺失/invalid slots；新过程 revision 获得资格，旧有效零值/过程值、旧 round 和 archive 均不改写，下一 archive update 才消费补齐引用。 |
| R08 | diagnosis/workplan/各 rung 后崩溃 | 已验证：诊断/cell 原操作、planning、generated、local、阶段决定、expansion、nomination、research、commit、terminal 和各 rung 结果指针写入后中断均恢复原冻结对象；子代只生成一次、执行 key 无重复。见 search-freeze-recovery.spec.ts 与 search-recovery.spec.ts。 |
| R09 | n_local/n_local 完整，bridge n_local/n_bridge 未完 | 已验证：local 范围完整、bridge 仅部分完成时保留原局部资格；冻结不足证据的 bridge 决定，不临时改提名另一候选，状态分别报告两个计划的覆盖率。 |
| R10 | stage 决策已消费后收到补证据 | 已验证：local、bridge、global seed 消费后追加 completion，原决定、nominee 和旧 archive 字节对象均不改写，新的 revision 在下一 archive update 才消费；diagnosis/workplans 的消费标记另有中断验证。 |
| G01 | 在线失败只有 prompt | 已验证：只有 prompt 的在线失败保留 needs-fixture，不能物化评分；基础设施 invalid 进入执行修复分支。 |
| G02 | 提案重复、含凭证、超上限 | 已验证：按语义/fixture/grader 去重，过滤凭证与个人信息、限制提案容量；同 prompt 不同 grader 不错误合并。 |
| G03 | suite 新版本 | 已验证：完整 suite manifest 和 provider 证明在新 admission 校验；protected guards 封存并强制执行、development 不隐式加门，换版本拒绝继续旧 evolution，新 evolution 重新取得成对证据。真实控制面 admission 不修改运行参数或源数据。 |
| G04 | held-out 失败 | 已验证：held-out 来源不生成提案，已知 regression suite 不能作为 held-out；收集在 seed research 封存过程中完成。 |
| C01 | 历史 spec / round / component v1 | 已验证：完整新旧 RefineService、state-store、Skill 及搜索验收回归通过；新基线摘要校验只由明确的 searchMode 启用，旧 champion-only、部分证据、baseline reuse 与恢复路径保持。 |
| C02 | 案例 shadow replay | 已验证：对文档指定的真实第 4/5 轮 cache 完成只读回放，8 改善/10 退步与原报告一致，源文件前后逐字节一致；所有建议 advisory，不写 champion/archive，不认证 held-out 或 v2 cell reuse。详见案例回放报告。 |

## 正文合同核对

- 持久化 task/metric、scope、dossier/workplan/receipt、stage/binding/result、archive、budget ledger 和 commit intent 有 JSON schema 与运行时校验，身份、完整性、来源、预算等另做语义检查。schema 由 TypeScript 源生成。
- scope sampler 封存历史截止点，覆盖子模式、模块、难度/成本和成功反例；当前 sibling 结果不进入采样。稳定和周期 epoch 均有回归。
- seed-only 状态显示各计划 coverage 与 local/bridge 决定；首个消费者落盘后不可改写，held-out 不进入 Meta、archive 或回归提案。
- 统一生成/诊断/rollout/repair/时间预算通过原 reservation 恢复；未知状态保留原操作，超时只读查询，重试不刷新额度。
- regression suite 通过角色、保护规则、来源和 provider 物化证明接入新 evolution；旧 suite 不原地扩大。
- 旧组件身份保留，新模式实现有独立 integrity；champion 迭代、部分证据、组件框架和 benchmark 规范已补充适用边界。

## 最终验证

2026-09-12 算法主体验证（均在隔离工作区，最多两个 worker；默认适配补充验证另列）：

- `search.spec.ts`：26 项通过，包含 1,000 seed 任务的完整 4→2→1 路径及准确的 1,700 candidate seed cells。
- 其余 12 个 `search-*.spec.ts` 与完整 `refine-service.spec.ts`：13 文件、212 项通过。包含 15 个持久化中断窗口、真实 Skill 空 checkpoint 的历史代码/findings 继承、生成重试重启和 champion CAS 成功后的恢复。
- 以上两批文件无重叠，共 14 文件、238 项通过。此前 state-store、Skill Meta 等兼容回归也已通过，不重复计入该数。
- `npm run typecheck`、标准 `npm run build`、搜索 SDK 导入、schema 重建一致性、`npm pack --ignore-scripts --dry-run` 和 `git diff --check` 通过；包内含搜索入口、声明文件及 JSON schema。
- 标准构建依赖使用固定版本与完整性校验；沙箱中首次网络解析失败后在获准的隔离构建中成功，不更换依赖版本。
- 主工作树只读核对仍为 `dev`，原有未提交文件清单未变。真实案例源文件前后哈希一致，没有执行新 benchmark、修改 champion 或发布产物到运行中实验。

2026-09-12 Gear 默认适配修正后的最终回归：

- 全部 14 个搜索测试文件、`refine-service.spec.ts`、`hitch-cli-evaluator.spec.ts`：16 文件、342 项通过，最多两个 worker。该集合包含前述算法主体验证，不与历史批次累加。
- 新增普通 evaluator 的两种通道完整 4→2→1、无注入声明的真实 Git/Skill 晋升、原数据哈希不变、丢失响应只读恢复、未知提交不重发、无控随机重复身份、超时保留已完成 cells，以及缺少诊断产物时 unresolved。
- Gear 的只读恢复复用现有 `eval inspect --json`，按实际 `control.state` 处理排队、规划、运行、收尾、取消和终态缺结果；fixture 验证不会发起 run/submit/rerun/watch/cancel。
- 最终 `npm run typecheck`、标准 `npm run build`、schema 重建与格式检查、搜索 SDK 94 项导出和 npm dry-run 文件清单检查通过。打包检查使用临时 npm cache，未修改用户全局 cache 权限。
