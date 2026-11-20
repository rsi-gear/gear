# curriculum 第 11 节逐项验收：无 GPU 训练范围

审计实现基线为 `52d720227`，目标保持为[完整设计](failure-driven-data-operators-spec.zh-CN.md)，本版本不做 GPU 训练。**本表不是完整完成声明：纯算子、执行合同和各具体调用方已有验证，真实工具环境的有效效果对照仍未完成。** 文本 IFEval 四组对照已完成，结论为未观察到 failure 优势。

“通过”只用于表中明确的验证范围。模型替身可以验证输入转换、恢复和实际工具执行，不能证明真实模型收益；真实原题修复也不能替代未见任务评价。GPU 权重更新、训练部署、LoRA／DPO／MoE 后端和论文规模训练证据按用户指定范围留待后续。

| 第 11 节要求 | 当前证据与实际覆盖 | 判定及剩余边界 |
| --- | --- | --- |
| 1. 纯算子、可校验／序列化 I/O、配置身份、原 executor 格式 | [基础测试](../python/tests/test_curriculum.py)在 `python -S` 中导入、往返 Module 描述，检查 prompt／参数变化拒绝恢复；CPU `TaskSource` 实际返回标量 executor 的 `{x,target}`，通过真实 TrainingLoop。四种生成类型见[合同测试](../python/tests/test_curriculum_practice_kinds.py)；正式搜索与 native retail 的转换分别由[正式入口](../examples/curriculum-harness/FORMAL.zh-CN.md)、[SENTINEL](../examples/curriculum-harness/SENTINEL.zh-CN.md)验证 | **具体合同与调用方通过。** 外部调用方仍负责授权和冻结自身实际配置；这不是自动适配任意 executor 的承诺 |
| 2. 诊断、生成、验证后的恢复；未知结果先 reconcile | 基础测试分别在三阶段完成计算后中断；[正式调用检查](../python/tests/test_formal_curriculum_harness.py)验证 pending 在提交前落盘、丢失 acknowledgement 后读取原 turn、未确认时不重提；[Agent-R](../python/tests/test_agentr_retail.py)、[Self-Direction](../python/tests/test_selfdirection_retail.py)重放原回执及实际工具状态。[真实 DiagEvo 记忆后端](../research/diagevo-memory-2026-11-20/README.zh-CN.md)另有完成回执丢失后的原 turn 恢复证据 | **实现与相应恢复路径通过。** 不宣称网络副作用具有无条件 exactly-once；未知或服务端终态失败可以停止，不能自动换键重试 |
| 3. 去重，区分任务失败／基础设施／不完整；部分轨迹边界 | `ExtractOutcomeCases` 按逻辑 sample 选最新 attempt，矛盾记录拒绝；[信号检查](../python/tests/test_curriculum_signals.py)排除未知和不完整；[mastery 检查](../python/tests/test_sentinel_mastery.py)以完整轨迹去重，重复失败可撤销后来的 mastery 但不增加频次；Self-Direction 保留省略索引，原始完整轨迹单独保存 | **通过。** API 失败、超时及尚未结束的轨迹均不能补成零分。实际中断案例见 [retail V3](../research/sentinel-retail-2026-11-20-v3/README.zh-CN.md) |
| 4. train/dev/test、family、任务准入和盲模式隔离 | [ReflectiveSearch 检查](../python/tests/test_reflective_search.py)验证反思／训练门槛／选型 scope；[retail 正式集成](../python/tests/test_sentinel_search.py)拒绝私有任务或越界材料流向 Meta；[三组对照集成](../python/tests/test_sentinel_experiment.py)在全部选型完成后封存最终 test。生成任务须进入新 run，写文件不构成准入；缺少可见 verdict 的 case 保持 unknown | **现有入口通过。** 当前不提供通用 unscored rollout；调用方不能自行将 scored_private 信息转成生成反馈 |
| 5. 真实环境启动、参考／断言／负例、语义与精确去重 | [TRACE 环境检查](../python/tests/test_trace_environment.py)在固定 CPU Docker 镜像实际执行 reset、参考与反例，并检查主机文件／网络隔离；[生成集成](../python/tests/test_trace_generate.py)执行生成代码、有限修订和分组校准。[retail](../python/tests/test_sentinel_retail.py)使用真实 Tau2 DB verifier。[练习池](../python/tests/test_curriculum_pool.py)验证完整语义比较池；Self-Direction 分开保存语义判断与规范化 QA hash | **实际执行及证据绑定通过。** 生成 reward、参考、政策和语义新颖性仍可能有模型偏差，不称独立 oracle；生成 fixture 的执行通过不等于真实生成模型有效 |
| 6. 新捕获、完整 GRPO 组、proof／preference／synthetic 类型 | [监督合同](../python/tests/test_curriculum_supervision.py)检查原状态、共同前缀、修复语义 mask；[可信 builder](../python/tests/test_training_supervision.py)把新回执转入既有 SFT 批次，拒绝旧 receipt、错配 token/proof，并检查真实 CPU 后缀梯度与 tokenizer；[TRACE 校准](../python/tests/test_trace_calibrate.py)保留组内全部成功／失败，缺失分布保持未知 | **本版数据合同通过；GPU 训练不验收。** Agent-R 普通推理轨迹不输出训练捕获资格；合成 QA 不伪造 native success proof，偏好仍为中间数据；完整 GPU rollout／更新需后续独立证明 |
| 7. fixed/random/failure/memory 对照及各阶段成本 | [IFEval V5](../research/curriculum-harness-2026-11-20-v5/README.zh-CN.md)有四组×三种子×两轮、每轮相同六条有效学习样本、24/24 合格候选、1,478 份真实调用和完整 token 归属；生成／诊断额外成本另计，验证执行 676 次，权重训练 0 步。memory 是通用历史调度消融，并非完整 Forge | **文本对照通过；工具域真实对照未完成。** 预算相同指有效样本和候选机会，不能声称实际 token 相同。验证 CPU 时间、HTTP 重试和美元费用没有完整计量 |
| 8. 旧失败修复、未见收益、历史回归、多轮曲线和单位成本 | [补充复算](../research/curriculum-acceptance-2026-11-20/README.zh-CN.md)逐 trial 保存旧失败／成功探针、三点训练曲线、24 道留出结果、相对 controls 的差和单位 token 描述性比值；原评分以冻结 exporter 重验 1,424 份一致，未重选候选 | **受限文本测量通过；工具域及广泛能力证据仍缺。** 只有 1 道旧失败、7 道旧成功、24 道共享测试题；不同 seed 的测量不独立。没有已证实的 failure 净收益或经济 ROI |
| 9. 包边界、无 Node/Hitch/GPU 导入、确定性与转换 | [基础测试](../python/tests/test_curriculum.py)用无 site-packages 的子进程断言 curriculum 不加载 search/training/evaluation/memory/Project/torch；[显式随机源与选择](../python/tests/test_curriculum_pool.py)、[能力对比](../python/tests/test_curriculum_capabilities.py)及[技能树](../python/tests/test_curriculum_skills.py)检查配置重建、身份和稳定输出。仓库依赖边界检查与实际模型请求／任务转换集成通过 | **通过。** 纯算子的确定性不代表远程模型解码可设置 seed；没有把执行、存储或 adapters 层引入 curriculum |

## 配方范围

本版已有可运行的具体调用方：[Forge](../examples/curriculum-harness/FORGE.zh-CN.md)、[DataEnvGym](../examples/training-loop/DATAENVGYM.zh-CN.md)、[SENTINEL](../examples/curriculum-harness/SENTINEL.zh-CN.md)、[CoEvolve](../examples/curriculum-harness/COEVOLVE.zh-CN.md)、[TRACE](../examples/curriculum-harness/TRACE.zh-CN.md)、[Agent-R](../examples/curriculum-harness/AGENTR.zh-CN.md)、[Self-Direction](../examples/curriculum-harness/SELFDIRECTION.zh-CN.md)及 [DiagEvo 合同与编排](training/diagevo.zh-CN.md)。每个文档都列出实际入口、上游差异和后端限制，不能以共有算子存在推断整篇论文已经复现。

DataEnvGym 的 CPU 数值更新不是 LLM 效果；Self-Direction 的上下文 lesson 不是 LoRA 训练；TRACE 的生成环境与文本 harness 搜索不是 MoE 组合；Agent-R 的可丢弃模拟器回退不是外部服务 undo。DiagEvo 的 GPU 双模型训练和相应部署依赖不阻塞本版。

当前正式 `ReflectiveSearch` 有有限候选修订、训练门槛和分离选型；V5 的真实文本实验是在训练门槛实现前冻结，不能把该实验称为训练门槛的真实模型验证。该功能已有实际 CLI／worker 与 native 工具的模型替身集成，新的工具域实验才能补充真实模型证据。

## 未完成项与完成条件

1. **真实工具环境对照**：需完整、可归属的 source outcomes、生成／拒绝材料、同额已准入学习池、候选／门槛／选型及封存后的固定测试结果。生成不足或 API 中断必须明确报告，不能以缺额实验宣布各策略有效比较。
2. **工具域效果指标**：在上述有效对照基础上报告原失败修复、留出变化、回归、成本和其测量范围；不能以单个 task 的成功或语义审核结果替代。
3. **最终审计收口**：将完整实验的实际证据绑定回第 7、8 项，检查剩余项目；没有证据时继续保留未完成状态。负结果可以完成实验验收，不要求 failure 胜出。

同 run 动态任务池和新的 GPU 训练后端仍按设计的后续运行能力处理，不以此扩大本版交付承诺。完整目标保持 active，不能因已有 CPU 检查通过而改写以上完成条件。

本次补充核验中，可信监督合同 11 项与正式恢复／ReflectiveSearch 17 项全部通过；冻结 V5 的 1,424 份真实模型评测重评分一致，成本派生文件完整复算一致。前述检查均未发起新模型请求。[工具对照 V4](../research/sentinel-retail-2026-11-20-v4/README.zh-CN.md)则在 43 次完整调用后因空结束动作中止，已保存 990,092 tokens；尚无完整任务评分，不计为有效对照。
