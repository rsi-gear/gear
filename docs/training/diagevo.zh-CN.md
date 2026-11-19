# DiagEvo 课程规则的当前接入

`gear.training.recipes.diagevo.DiagEvoPolicy` 已实现 DiagEvo 的投票筛选、频率调度和状态更新规则，`gear.training.recipes.diagevo_memory.DiagEvoDiagnostician` 提供诊断、检索筛选及节点归并组件。`gear.training.recipes.diagevo_round.DiagEvoMemoryUpdater` 已将这些组件串成一个可恢复的轮末记忆更新流程；`gear.training.recipes.diagevo_challenger.DiagEvoChallengerReward` 计算 challenger 的问题质量奖励。challenger 与 solver 的 dataset builder 已将奖励绑定到原生捕获及 GRPO 批次，solver 可从完整训练提交链恢复轮末诊断材料。数学答案已有实际 Math-Verify 分类后端，单个 solver 作业已接入现有四阶段原生驱动并通过 CPU 替身集成测试。完整双模型算法尚未注册，也未在 `gear.algorithms` 中宣称支持；challenger 更新及更新后新采样、实际诊断／embedding 后端、完整外层执行和 GPU 效果仍待接入验证。

规则依据 [DiagEvo 第 2 节及附录 E](https://arxiv.org/html/2609.00768v2#S2)，默认构造样本数 12、优化组大小 8；绝对置信度区间为 [0.25, 0.75]，相对阈值 1.6，晋级阈值 0.7，探索系数 0.5。所有参数进入现有 `Module` 描述，可重建和替换，不在 `curriculum` 增加专用分支。

## 构造、筛选与优化样本

调用方将已完成的 solver 响应归一化为 `SolverSample`，保留 question、实际 policy、全局唯一 sample ID、阶段、答案等价类及轨迹引用。`construction` 要求完整且同题同策略的样本组，按票数计算第一、第二答案的占比；只有同时满足绝对区间和相对票数条件的题才进入后续优化。标签始终为 `majority_vote`，不代表真实正确性。

构造报告保留完整输入与一条多数答案参考轨迹。`optimization` 需要独立的新样本组，用与伪标签一致／不一致定义 +1／-1，即使全部优化响应都不一致，原构造参考仍可用于对比诊断。它不把构造样本复用为训练 rollout。优化期间策略可以推进，每个组必须保留自己的实际 policy；原生 token、logprob、组完整性和当前策略资格仍由训练 backend 检查。

报告修改后不能继续使用：消费时从原构造样本重新计算投票。缺失、未完成、混合策略或重复 sample 不会被当作完整组；为同一个轨迹引用另取 sample ID 也不能重复计票。caller 需要先处理原外部调用结果，不能用部分组补出失败标签。

## Challenger 问题质量奖励

`DiagEvoChallengerReward.questions(samples)` 在实际 solver 请求前验证整批 challenger 采样，并提取格式有效的问题。`ChallengerSample` 分别保存 sample、group、prompt、policy 和 capture 身份；不同采样组可共享同一个自由探索 prompt，不能按 prompt 文本合并 GRPO 组。每组默认八条，整批来自同一 challenger 策略。

这里采用明确的输出合同：完整响应仅含一对 `<question>...</question>`，允许外围空白，拒绝空问题、嵌套／重复标签和额外文本。已完成的格式错误保留在组内并获零奖励；未完成、缺项、重复 capture 或混合策略直接拒绝，不能补成失败样本。格式检查不证明题目有解或语义正确。

`score(samples, votes)` 要求每个有效问题有完整的 solver 投票，question ID 对应 challenger sample ID；所有票来自一个冻结 solver，且不能重用任何 challenger 或其他问题的 capture／sample。投票报告从原样本重新计算。这里不采用 solver 课程的 `retained` 条件：相冲突的多数票也参与 challenger 的难度奖励。

奖励遵循 [DiagEvo 附录 D](https://arxiv.org/html/2609.00768v2#A4)：`max(0, 1 - 2*abs(p1 - 0.5) - repetition_weight*cluster_share)`，默认权重 1。结果逐项保留原样本、完整投票、聚类成员、重复占比、不确定性及奖励，供训练调用方绑定原生 token／logprob／receipt；本组件不认证这些引用的真实性，也不执行梯度更新。

聚类约定参考固定版本 [R-Zero `5699329`](https://github.com/Chengsong-Huang/R-Zero/blob/5699329d018d79535b7910abdedf5a6eebf355fd/examples/reward_function/caller_penalty.py)：空白分词、NLTK 默认四元 BLEU 与 method1 平滑、`1-BLEU` 距离、average linkage、默认阈值 0.5。较早问题作为 hypothesis，较晚问题作为 reference，单向距离镜像填入矩阵；这不具备输入排列不变性，调用方必须冻结原批次顺序。本实现重新组织计算与证据输出，不执行上游文件的网络、文件或环境变量副作用，也不采用其末尾奖励公式。

只聚类有效问题，重复占比的分母固定为完整 challenger 批次大小，含格式无效槽位；零个或一个有效问题有显式处理。聚类身份以成员 sample ID 表示，不暴露库的任意数字标签。NLTK 和 scikit-learn 延迟加载，并声明为该 Module 的包依赖；训练阶段身份应记录实际安装版本。当前测试版本为 `nltk==3.10.4`、`scikit-learn==1.5.2`，不加入 `gear.curriculum` 的依赖。

这些可选计算依赖可用 `pip install './python[training-metrics]' -c python/constraints-test.txt` 安装。CI 的 training-cpu 作业安装它们并运行对应测试；不安装该 extra 的最小环境跳过依赖真实聚类库的测试，其他规则测试照常执行。

## 原生 GRPO 数据绑定

`gear.training.recipes.diagevo_data.DiagEvoChallengerDatasetBuilder` 接收已有 `ContentStore`、冻结训练请求和可替换的奖励组件。`questions(groups, lease=...)` 从 `RawTrajectory` 的真实请求／响应记录读取问题，并验证完整组、已关闭 lease、已准入 train task、harness、策略、tokenizer 和采样配置。同组的实际输入消息也必须一致，不能仅凭相同 task ID 假定同一个 prompt。

此入口面向单次文本生成；solver 捕获的最后一条 user 消息必须精确等于提取的问题，前置 system/developer 消息、采样配置和策略身份在整批保持一致。`build(groups, lease=..., solver_policy_id=..., solver_trajectories=..., answer_classes_ref=...)` 要求每个有效问题有完整构造组，并匹配调用方从冻结模型状态取得的预期 solver policy ID；格式无效的问题没有 solver 组。所有模型请求的 episode、run、receipt、request 和完整轨迹身份都不能重复。原生 `build_episode` 的截断、完整 token、行为 logprob、mask 和反馈关联检查继续执行。

答案等价判定仍由调用方处理，`answer_classes_ref` 指向以下封存结构。每个构造轨迹恰好有一个 label，`trajectoryDigest` 为 `digest_json(asdict(raw_trajectory))`，`evidenceRef` 保存该分类决定的实际依据；`classifier` 保存真实实现／模型版本及配置。这里检查分类与捕获的绑定、完整覆盖和证据可读取性，不验证数学等价或来源授权，调用方必须只提交获准的捕获和分类结果。

```json
{
  "schemaVersion": 1,
  "kind": "diagevo-answer-classes",
  "classifier": {"由调用方填写": "实际冻结的分类器身份"},
  "labels": [
    {"trajectoryDigest": "完整轨迹摘要", "answerKey": "同题答案等价类", "evidenceRef": {"实际": "CAS 引用"}}
  ]
}
```

builder 从这些捕获和分类重新构造投票、计算整批奖励，调用现有 `seal_batch` 返回原生 batchRef。token、mask、logprob、policyVersion 及原 feedback 均保留；新奖励单独记录 `rewardSource`、`originalVerifierReward`、`curriculumRewardRef`，后者绑定完整输入、奖励、源码身份及实际依赖版本。训练调用方将 batchRef 登记到原 lease 的 ledger，再按已有 `grpo-dataset` 合同交给 `SlimeModelUpdater`。此处没有新 adapter 或另一个 updater，也没有改写 verifier 的原始奖励。

当前要求 v2 `agent-grpo-v1`、`zeroVarianceGroup="keep"`、与奖励一致的 group size，以及原生已支持的 `topP=1`。builder 本身不运行模型、不关闭或重开 lease，也不完成两模型作业调度。测试证明已绑定的数据能封存为原生批次，不等于 Slime 已执行更新或 GPU 数值已验收。

## 数学答案分类后端

`gear.training.recipes.diagevo_answers.DiagEvoMathClassifier` 使用开源 [Math-Verify](https://github.com/huggingface/Math-Verify) 0.9.0。安装命令为 `pip install './python[training-math]' -c python/constraints-test.txt`；当前锁定 latex2sympy2_extended 1.11.0、ANTLR 4.13.2、SymPy 1.14.0 和 mpmath 1.3.0。依赖延迟加载，源码、实际安装版本及参数进入分类器身份，不加入 curriculum 核心依赖。

`construction(questions, captures)` 读取完整原生 solver 响应并输出上述 `answer_classes_ref`。它只解析最后一个外层 `\boxed{...}`，不回退到更早的答案；最后一个 box 未闭合或含嵌套 box 时拒绝提取。使用严格规范化、禁止字符串 fallback，缺失或不支持的答案各有独立标识，避免解析失败聚成多数票。Math-Verify 双向比较均成立才合并，且整个题目的比较关系必须自反、传递。保存的依据包含捕获、解析状态、表达式和逐对比较结果。

`optimization(curriculum_ref, groups)` 先重算冻结的构造分类，随后把新答案与各原类别的所有成员比较；匹配同一类别才复用原 ID，部分匹配或同时匹配不相容类别会报错。未匹配答案各有独立 ID，只表示它不属于已有类别，不宣称这些新答案彼此不等价。分类器异常和超时终止阶段，不转换为负奖励。这个数学专用约定是明确的适配；多数票仍是伪标签，不证明题目或答案真实正确。

默认每次 parse/verify 超时 5 秒、一次完整分类软期限 300 秒、每题最多 256 条响应、单条最多 262144 字符；优化阶段的原分类重放与新比较共享同一期限。软期限在库调用前后检查，文件读取与 Python 处理也可能延迟检查，不提供独立进程的硬资源隔离。当前库超时依赖主线程信号，因此只在 worker 主线程运行，并拒绝占用已有的进程 alarm。

## Solver 课程与已提交失败材料

`gear.training.recipes.diagevo_solver.DiagEvoSolverDatasetBuilder` 使用同一原生数据合同。`seal_curriculum` 接收完整候选题池、构造捕获、生成指令、轮初 memory、预期 solver policy 与答案分类证据。它从捕获重算投票并封存被保留和被筛除的所有题；晋级需要后者的观测，不能只保存进入梯度更新的题。构造捕获须属于同一个冻结 solver，实际题目、指令前缀、tokenizer 和采样配置一致。保留题的多数票参考必须有非空原文。

`build(groups, lease=..., curriculum_ref=..., answer_classes_ref=...)` 只允许训练已保留题，要求原生 task ID 与封存 question ID 相同。优化捕获不能复用构造捕获；每个优化组保持自己的实际策略，同时保留构造阶段的题目、指令和采样合同。优化分类证据使用 `kind="diagevo-optimization-classes"`，增加 `curriculumRef`，其余字段沿用上述分类结构。调用方必须沿用同一分类器以及该题池内稳定的答案等价类，不能为优化响应重新编号。builder 检查身份、覆盖和引用，数学等价性仍由实际分类器负责。

构建后的批次保留原 token、mask、行为 logprob 和 verifier 反馈；伪标签一致／不一致的奖励另记为 +1／-1。全部失败的组仍保留。`round_evidence(commit_refs, curriculum_ref=...)` 要求提供此 solver 作业的全部计划更新，按顺序检查训练作业身份、连续提交号、前序提交、实际消费的 batch、checkpoint、优化器／RNG、导出权重及下一批的更新前权重。恢复作业还检查父 checkpoint 的兼容性、完整状态和导出模型。随后从原捕获重建每个消费批次，拒绝漏批、换批和跨更新复用捕获。

返回的既有 `RoundEvidence` 包含完整题池、全部已提交优化组，以及诊断必需的失败原文和构造参考原文，可直接交给 `DiagEvoMemoryUpdater`。已完成但文本为空的失败响应按空字符串保留，缺失值仍拒绝；诊断模型可选择不归因，不补写虚构的错误答案。当前方法不处理部分完成作业或跳过全部更新的轮次。

未指定 `generation_builder` 时，上述入口仍是接受调用方题目的底层数据 builder，不证明 challenger 来源。完整配方应使用下一节的绑定入口；它也只验证存储记录之间的关联，提交与 lease 的真实性必须由实际 native ledger 保证。

## 更新后 challenger 的新题池

`gear.training.recipes.diagevo_generation.DiagEvoQuestionPrompt` 提供自由探索、单原因定向及 active/mastered 同节点组合的文本 prompt。共同 system prompt 保持不变，自由探索不携带记忆描述，其他模式包含精确原因、状态和父节点 label；所有提示词参数进入 Module 身份。默认文字按[论文附录 I](https://arxiv.org/html/2609.00768v2#A9)的语义重新表述，不宣称逐字复现。调用方直接把 `messages(...)` 的结果用于已有执行路径，无新增 adapter。

`DiagEvoGenerationBuilder(challenger_builder, prompt=...)` 将新题池关联到完整 challenger 作业。`seal` 接收更新后新捕获、已关闭 lease、全部更新提交、轮初 memory/nodes、按已准入 task ID 映射的生成指令和冻结 solver policy。它重放每个已提交 challenger 批次的奖励构建，核对消费批次、连续 checkpoint 与更新前权重，并要求各批使用同一个 solver 指令和采样合同。

新题池的 lease 必须指向最后一个更新的 HF 导出，使用后续 policy 身份。更新批次与新题池的实际消息都必须等于相同记忆和指令生成的 prompt。所有 challenger／solver 的 episode、run、request、receipt 和轨迹身份跨阶段去重；不能把旧捕获换名后当成新采样。新的问题文本可以偶然相同，文本相同不等于复用捕获。已完成但格式无效的响应保存在原批记录中，不生成 solver 问题；整批没有有效问题时，后续 solver 课程会明确拒绝。

`read` 会从原提交、捕获和配置重新构建整个来源记录。将该 builder 传入 `DiagEvoSolverDatasetBuilder(..., generation_builder=...)` 后，`seal_curriculum(..., generation_ref=...)` 强制要求完整新题目、逐题生成指令、轮初记忆和冻结 solver 相符，且构造响应不能复用 challenger 奖励评估中的响应。该来源随课程、优化批次和已提交失败材料保留，恢复时再次检查。

当前同一 challenger 作业内的两阶段使用相同已准入任务范围、组大小和批次大小。每个 task 固定一种生成指令，调用方须用已有 `DiagEvoPolicy.schedule` 按冻结随机源构造任务及抽样计划；此绑定检查实际内容与计划关联，尚不证明完整外层频率调度已经执行。它不自行启动训练、采样或完成跨作业任务准入，也不处理全无有效题时的重采样策略。完整双模型调用方与实际训练验证仍然缺失。

## 单个 solver 作业的原生执行

`gear.training.pipelines.diagevo_solver.build_loop` 组合既有 `FrozenTaskSource → HitchRolloutExecutor → SolverDatasetStage → SlimeModelUpdater`。可冻结 [示例入口](../../examples/training-loop/recipes/diagevo_solver.py) 作为 `trainer.script`，在 `trainer.scriptConfig` 中提供 `curriculumRef` 和 `challengerRequestRef` 两个 CAS 引用。前者必须绑定更新后新题池和上述数学分类；后者是生成记录对应的完整 challenger 训练请求。调用方须先按已有权限传输这些引用及其依赖，并准入恰好全部保留题；此入口不会自动创建或扩展任务权限。

factory 从冻结描述重建 policy、challenger objective 和 question prompt，只解析显式允许的组件，不按制品字符串任意导入代码。随后重放来源记录并核对分类器身份。替换算法组件的调用方可在自己的冻结 script 中直接组合现有 stage，不增加 adapters 层。

数据阶段先核对实际 ledger 中的关闭 lease、更新前 checkpoint、完整原生组和来源，再执行数学分类、封存 ±1 奖励批次并交给既有 updater。原 token、mask、行为 logprob 和 verifier 反馈不变。已完成阶段按现有 `TrainingLoop` 重放；批次封存后丢失返回时可从原捕获确定性重建，参数更新提交后丢失返回时复用原生提交，不重复采样或更新。数学计算是本地运算，中断后未完成的分类可以重算，不产生额外模型调用。

这里完成的是一个已准入 solver 作业。上游 challenger 参数更新、更新后新题采样、冻结 solver 的构造采样，以及轮末真实诊断和下一轮作业创建仍由尚未完成的外层入口负责。CPU 集成中的 actor、权重和 challenger 历史是明确标注的测试替身，不能作为真实 LLM／GPU 更新或论文效果证据。

## 调度与状态

`Cause` 同时保存历史失败 ID 和当前 active 周期中的失败 ID，频次由后者的数量得到。调度根据冻结的首轮频次和当前 active 总频次分配自由探索概率，按 active 周期频次抽取目标；只与同技能节点中的 mastered 原因做均匀配对。随机源由调用方显式提供，输入排列不改变抽样结果。

首轮或没有 active 原因时全部自由探索。若首轮频次为零而以后出现 active 原因，当前实现明确拒绝；论文没有给出这个退化基准的操作策略，完整调用方必须先规定并冻结处理方式，不能静默改掉参考频次。该边界尚不算完整配方已经处理。

`update` 要求构造报告覆盖预先声明的全部生成题，包括被筛除的题。晋级使用所有直接针对该 active 原因的题的平均一致率；没收到针对性观测不会自动晋级。晋级先将状态设为 mastered 并清零当前周期，再处理新的优化失败，所以同一轮的新失败可以重新激活原因，频次只计新周期。历史失败 ID 保留，用于拒绝重复归因。

一次失败最多分配给一个原因。已知原因的身份不可被诊断输出悄悄改写；新原因只从已保留题的真实失败优化响应建立。诊断可以不归因，但不能给成功响应计失败频次。这里仅检查归因输入的一致性，轨迹真实性仍需由调用方验证。

## 诊断与记忆整理组件

`DiagEvoDiagnostician` 按[附录 I](https://arxiv.org/html/2609.00768v2#A9)提供四组 `prepare_*/parse_*` 方法。`prepare` 返回既有 `ModelInput`，由调用方实际执行；`parse` 重新计算候选范围并检查模型决定。没有新增 executor、adapter 或通用调度协议。

`DiagnosisPair` 将一个优化失败与原构造组保留的参考响应关联。提取前重新验证完整投票与奖励，禁止成功响应或修改后的优化组参与；即使优化组全部失败，仍使用原构造参考。自由探索、定向生成、stitching 分别只提供零、一、两个已知原因。结果最多匹配其中一个原因，或提出一个新原因；无法归于技能缺陷时允许两者均为空。输出保留两个原轨迹引用，可直接构成 `FailureAttribution` 的证据引用。

`cause_similarities` 计算全量原因的余弦相似度，包括 mastered 原因；拒绝缺项、维度不同、零向量和非有限值。超过默认 0.5 阈值的原因才进入模型去重确认，相似度本身不等于重复。节点检索使用其成员原因的最大相似度，默认取前五个节点，并附上分数最高的代表原因。模型只能选择候选节点或创建新节点；新节点 ID 由调用方分配。没有相似原因时跳过去重；没有已有节点时只能创建节点。

轮末先用节点 label 的 embedding 筛出相似节点对，再将两个节点的全部原因交给模型确认。确认合并时按 node ID 字典序保留一个节点，更新其 label 并重设原因的父节点；原因 ID、描述、历史失败、active 周期和频次均保留，不做隐式原因合并。涉及已经删除节点的旧决定不能再次应用。

原因与节点 label 的 10–20 词长度在解析时强制检查；“可迁移、动宾短语、无题目特有信息”等语义要求依赖诊断模型，不能仅凭格式验证宣称满足。调用方必须把文本、embedding 及 embedding 模型身份绑定到实际记录；本组件不能验证调用方提供的文本就是对应 capture 的内容，也不能验证向量确实来自该文本。

记忆更新调用方保留生成时的轮初 memory 用于 recurrence 检查，并在轮内让后续去重看到先前归因的新原因；状态转移只在最终提交时生效。归并决定绑定它所看到的完整节点快照，节点成员变更后不能静默复用旧响应。

## 可恢复的轮末调用流程

`DiagEvoMemoryUpdater.update(ctx, evidence, memory=..., nodes=...)` 使用现有 `TrainingContext` 和该 stage 的工作目录。`RoundEvidence` 包含全候选池的构造票、生成指令、真实优化组、逐题文本，以及诊断必需的失败／构造参考文本；覆盖不全、夹带其他文本、重用原 capture 或重复计入历史失败会在外部调用前拒绝。这里检查引用与输入一致性，不认证它们对应的原生采样内容；该认证仍由训练调用方负责。

记忆更新先冻结 operation、checkpoint、history 摘要、配置、源文件摘要、算子描述和后端身份，再按 sample ID 稳定顺序处理失败。新原因的 ID 由本轮输入和样本派生，后续失败可立即通过全量检索匹配它；每次重算都从轮初 memory 和累计归因出发，避免重复递增。所有失败处理完后才执行节点归并并原子保存结果。

节点候选对在归并开始前固定。若前一个归并删掉了节点，后续候选对会解析到存续节点，并使用更新后的全部成员重新询问模型；不会仅凭传递关系自动合并。相同节点快照不重复询问，单轮也不因新 label 无限重新筛选。

实际调用只要求四个普通异步函数，由调用方处理 SDK 格式转换：

| 函数 | 输入与返回 |
| --- | --- |
| `diagnose(key, model_input)` | 返回已完成模型响应的 JSON；组件执行其语义范围检查 |
| `embed(key, text)` | 返回一个向量；embedding 模型身份和文本绑定由调用方负责 |
| `recover_diagnosis(key)` / `recover_embedding(key)` | 返回 `{"state":"completed","output":...}`、`{"state":"not_submitted"}` 或 `{"state":"unknown"}` |

原生请求身份、实际 token／费用与传输层记录留在这两个后端，按相同 key 查回。只有后端能够确证从未提交时才可返回 `not_submitted`；网络错误或本地未收到响应不能作为此证据。`unknown` 会停止，已完成但未写回本地的结果先恢复；无效的已完成模型响应也会保存，重跑时不会自动换一个响应。

每轮默认最多 256 个诊断请求和 256 个 embedding 请求，参数随输入冻结；提取、去重、分配、归并共同占用诊断配额，同文本的 embedding 在轮内复用。这是逻辑请求限额，不是原生重试或金额上限。后端身份必须包含实际模型版本和配置，不能仅填一个不随实现变化的昵称。

已完成的 `TrainingLoop` stage 会直接重放其结果。接入方复用该 stage 前应调用 `DiagEvoMemoryUpdater.verify(stage_workspace, operation_id=...)` 检查记忆侧录和全部子调用记录；记录缺失或变化不会被默认为成功。再次调用 `update` 也会重算纯决策并核对最终结果，已有外部结果直接复用。该组件可以放入现有调用方的训练阶段，没有为 curriculum 增加执行层；它自身不是两模型训练循环。

## 验证与剩余接入

`python/tests/test_diagevo_policy.py` 覆盖模糊多数票、过易／过难题、完整组、构造／优化分离、全部优化失败时的参考保留、频率抽样和同节点配对、被筛除题参与晋级、同轮晋级后重新激活、不完整题池与重复归因拒绝。

`python/tests/test_diagevo_memory.py` 另覆盖全失败组的参考保留、同节点已知原因复现、不强制归因、全量原因筛选、余弦数值边界、最大成员分数检索、候选外 ID 拒绝、空记忆建节点与归并时状态保持。纯组件可按 `Module` 重建。

`python/tests/test_diagevo_round.py` 使用明确标识的持久化测试服务覆盖整轮处理、同轮新原因去重、晋级和重新激活、重叠节点对、提取／embedding／分配／归并后回执丢失、最终提交后中断、未知结果、未提交恢复、并发所有权、预算耗尽及侧录缺失。这些测试服务不是实际 LLM 或 embedding 效果证据。

`python/tests/test_diagevo_challenger.py` 使用真实 NLTK／scikit-learn 覆盖奖励峰值及截断、跨组重复惩罚、格式错误与完整分母、零／单有效问题、缺失／跨策略／复用证据拒绝、输入顺序影响和 Module 重建。

`python/tests/test_diagevo_data.py` 使用明确标识的原生捕获合同 fixture，验证完整批次封存、重建一致性、原 token／mask／logprob／反馈保留、同 task 不同 prompt 拒绝、未准入任务／开放 lease／重复请求拒绝、solver 问题／指令／策略漂移、构造缺项和等价类证据覆盖。

`python/tests/test_diagevo_solver.py` 另覆盖完整题池与筛选、全失败组、构造／优化捕获隔离、分类约定、消费批次和提交链、恢复父状态、空失败原文及真实记忆调用流程的衔接。

`python/tests/test_diagevo_generation.py` 覆盖三种生成 prompt、更新后权重关联、旧请求换名拒绝、跨更新 solver 漂移、记忆与实际 prompt 一致性、无效新问题保留、构造响应不能复用奖励评估，以及新题池进入已提交 solver 失败材料。提交和模型状态为明确标识的 CPU 合同 fixture，不表示执行了优化器更新。

`python/tests/test_diagevo_answers.py` 使用实际 Math-Verify 验证数值／符号等价、最终答案提取、未解析回答隔离、构造类别沿用及 ±1 原生奖励；另检查异常、共享软期限、非传递比较和新答案匹配多个类别时拒绝分类。

`python/tests/test_diagevo_pipeline.py` 通过实际 script factory、原生 driver、回环 HTTP 捕获、SQLite ledger 和预处理跑两轮 solver 作业，并从消费提交恢复失败材料。Slime/Ray actor 与 checkpoint 为 CPU 替身。另覆盖封存后返回丢失、提交后返回丢失、任务准入和组件身份约束。九组共 78 个测试通过；这是规则、数据、执行和恢复验证，不是模型训练效果验证。

尚缺 challenger 实际更新及更新后重新采样、冻结 solver 构造采样、实际诊断／embedding 后端及原生费用回执绑定、完整外层恢复，以及双模型真实运行和效果对照。当前 solver 入口和记忆流程验证不替代完整 DiagEvo 或 GPU 实验验收。

接入两模型更新时还有三个已核实的边界：

- [DiagEvo 附录 D](https://arxiv.org/html/2609.00768v2#A4)要求先用一批问题更新 challenger，再从更新后的 challenger 采样另一批候选；不能把第一批题直接作为 solver 课程。两个独立采样池及其更新关联已有原生数据检查，但实际 challenger 参数更新、更新后采样和 solver 更新仍须由完整训练入口执行并验证。
- 全失败优化组仍是诊断材料。[原生采样路径](../../python/gear/training/backends/slime/rollout.py)选择跳过／重抽时，只在返回的 raw groups 中保留训练准入组；完整调用方需要明确使用已支持的 `zeroVarianceGroup="keep"`，或另行保留并验证未准入组，不能因为没有梯度信号而丢掉失败证据。
- [现有原生采样合同](../../python/gear/training/recipes/agent_grpo.py)只接受 `topP=1`，而论文报告为 0.99。完整配方必须扩展并验证对应行为分布合同，或预先声明使用 `topP=1` 的适配实验；不能将不支持的参数写进配置后视为已经实现。

此外，模型节点当前制品引用图上限为 4096 个对象、16 MiB metadata。论文规模的一批 challenger 加每题 12 条 solver 捕获可能超过该上限；完整入口需要在更新前核验体量，并接入相应的分页或独立证据保留能力。当前小批 CPU 合同验证没有覆盖该规模，也不能据此声称论文默认批量可运行。
