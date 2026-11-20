# DiagEvo 课程规则的当前接入

`gear.training.recipes.diagevo.DiagEvoPolicy` 已实现 DiagEvo 的投票筛选、频率调度和状态更新规则，`gear.training.recipes.diagevo_memory.DiagEvoDiagnostician` 提供诊断、检索筛选及节点归并组件。`gear.training.recipes.diagevo_round.DiagEvoMemoryUpdater` 已将这些组件串成一个可恢复的轮末记忆更新流程；`gear.training.recipes.diagevo_challenger.DiagEvoChallengerReward` 计算 challenger 的问题质量奖励。challenger 与 solver 的 dataset builder 已将奖励绑定到原生捕获及 GRPO 批次，solver 可从完整训练提交链恢复轮末诊断材料。两个单作业入口均已接入四阶段原生驱动：challenger 最后提交后可独立生成新题、重新采样 solver 并封存完整筛选结果；后续已准入 solver 作业可消费该结果，并在最后提交后执行记忆更新，将决定与回执关联到模型产物。保留题及下一轮记忆调度均已有实际任务编译、封存与 controller 准入函数。训练 actor 的集成验证仍使用 CPU 替身。Codex 诊断、BGE embedding 和已提交失败材料的记忆更新已通过真实后端验证。完整双模型算法尚未注册，也未在 `gear.algorithms` 中宣称支持；多轮跨作业编排和 GPU 效果仍待接入验证。

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
  "classifier": { "由调用方填写": "实际冻结的分类器身份" },
  "labels": [
    {
      "trajectoryDigest": "完整轨迹摘要",
      "answerKey": "同题答案等价类",
      "evidenceRef": { "实际": "CAS 引用" }
    }
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

## 冻结 HF solver 推理

`gear.training.recipes.diagevo_inference.FrozenHFSolver` 从既有 `seal_hf`／HF 导出制品加载真实本地模型，提供 `sample(group_key, questions, count=...)`。它执行 CPU float32 推理，保留原 chat template 输入、生成 token、每个 token 的行为 logprob、完整文本和 EOS 终止；使用 temperature=1、topP=1、不截断和显式上下文上限。可选 `chat_template_kwargs` 沿用现有布尔 `enable_thinking` 合同，实际传给 tokenizer 并进入持久身份。模型文件重新校验后仅从本地 safetensors 加载，不执行远程代码，不更新参数。源码、依赖、模型字节引用、指令、种子和限额也进入持久身份。

整组问题与数量绑定稳定 group key，各槽位有派生 CPU 种子；HF 推理在主线程中保存并恢复 CPU RNG，不重新设置 CUDA RNG。已完成结果直接复用；本地前向计算中断后允许重算，逻辑槽位配额不会重复增加，但不能据此宣称物理推理次数或 CPU 成本 exactly-once。默认每槽生成软期限 300 秒，在生成步之间检查，不覆盖权重加载，也不是独立进程的硬期限。截断输出也保存，原 key 再次调用仍拒绝，不能自动换成另一份回答。

返回的 `RawTrajectory` 记录真实本地推理事实；其中反馈只检查文本生成完成，`correctnessAssessed=false`，reward=0 不表示数学错误或正确。它们用于投票／诊断，没有 native train lease，不能直接作为当前 solver 的 GRPO 梯度批次。`runtimeInstanceId` 明确表示冻结模型和配置的逻辑本地实例，恢复不宣称原进程仍存活。

[预训练模型检查](../../research/diagevo-solver-2026-11-20/README.zh-CN.md)使用固定 revision 的 SmolLM2-135M-Instruct。V1 在 256 tokens 截断并按合同拒绝；V2 仅将上限扩为 1024，四份响应均到 EOS，原 key 的前 256 个 token 和 logprob 与 V1 完全一致，重放不加载模型。但四份回答均缺少最终 boxed 答案，被分类为四个独立 `unparsed`，没有形成数学正确性或训练收益证据。

## Solver 课程与已提交失败材料

`gear.training.recipes.diagevo_solver.DiagEvoSolverDatasetBuilder` 使用同一原生数据合同。`seal_curriculum` 接收完整候选题池、构造捕获、生成指令、轮初 memory、预期 solver policy 与答案分类证据。它从捕获重算投票并封存被保留和被筛除的所有题；晋级需要后者的观测，不能只保存进入梯度更新的题。构造捕获须属于同一个冻结 solver，实际题目、指令前缀、tokenizer 和采样配置一致。保留题的多数票参考必须有非空原文。

课程构造发生在保留题准入之前，因此初始化 builder 时可以省略 `request`，用于封存和重放课程。`build` 和 `round_evidence` 仍明确要求已准入的 solver 请求；省略请求不会获得梯度批次构建或已提交失败材料读取能力。

`build(groups, lease=..., curriculum_ref=..., answer_classes_ref=...)` 只允许训练已保留题，要求原生 task ID 与封存 question ID 相同。优化捕获不能复用构造捕获；每个优化组保持自己的实际策略，同时保留构造阶段的题目、指令和采样合同。优化分类证据使用 `kind="diagevo-optimization-classes"`，增加 `curriculumRef`，其余字段沿用上述分类结构。调用方必须沿用同一分类器以及该题池内稳定的答案等价类，不能为优化响应重新编号。builder 检查身份、覆盖和引用，数学等价性仍由实际分类器负责。

构建后的批次保留原 token、mask、行为 logprob 和 verifier 反馈；伪标签一致／不一致的奖励另记为 +1／-1。全部失败的组仍保留。`round_evidence(commit_refs, curriculum_ref=...)` 要求提供此 solver 作业的全部计划更新，按顺序检查训练作业身份、连续提交号、前序提交、实际消费的 batch、checkpoint、优化器／RNG、导出权重及下一批的更新前权重。恢复作业还检查父 checkpoint 的兼容性、完整状态和导出模型。随后从原捕获重建每个消费批次，拒绝漏批、换批和跨更新复用捕获。

返回的既有 `RoundEvidence` 包含完整题池、全部已提交优化组，以及诊断必需的失败原文和构造参考原文，可直接交给 `DiagEvoMemoryUpdater`。已完成但文本为空的失败响应按空字符串保留，缺失值仍拒绝；诊断模型可选择不归因，不补写虚构的错误答案。当前方法不处理部分完成作业或跳过全部更新的轮次。

未指定 `generation_builder` 时，上述入口仍是接受调用方题目的底层数据 builder，不证明 challenger 来源。完整配方应使用下一节的绑定入口；它也只验证存储记录之间的关联，提交与 lease 的真实性必须由实际 native ledger 保证。

## 更新后 challenger 的新题池

`gear.training.recipes.diagevo_generation.DiagEvoQuestionPrompt` 提供自由探索、单原因定向及 active/mastered 同节点组合的文本 prompt。共同 system prompt 保持不变，自由探索不携带记忆描述，其他模式包含精确原因、状态和父节点 label；所有提示词参数进入 Module 身份。默认文字按[论文附录 I](https://arxiv.org/html/2609.00768v2#A9)的语义重新表述，不宣称逐字复现。调用方直接把 `messages(...)` 的结果用于已有执行路径，无新增 adapter。

`DiagEvoGenerationBuilder(challenger_builder, prompt=...)` 将新题池关联到完整 challenger 作业。`seal` 接收更新后新捕获、已关闭 lease、全部更新提交、轮初 memory/nodes、按已准入 task ID 映射的生成指令和冻结 solver policy。它重放每个已提交 challenger 批次的奖励构建，核对消费批次、连续 checkpoint 与更新前权重，并要求各批使用同一个 solver 指令和采样合同。

新题池的 lease 必须指向最后一个更新的 HF 导出，使用后续 policy 身份。更新批次与新题池的实际消息都必须等于相同记忆和指令生成的 prompt。所有 challenger／solver 的 episode、run、request、receipt 和轨迹身份跨阶段去重；不能把旧捕获换名后当成新采样。新的问题文本可以偶然相同，文本相同不等于复用捕获。已完成但格式无效的响应保存在原批记录中，不生成 solver 问题；整批没有有效问题时，调用方保存明确状态，不创建可训练课程。

`read` 会从原提交、捕获和配置重新构建整个来源记录。将该 builder 传入 `DiagEvoSolverDatasetBuilder(..., generation_builder=...)` 后，`seal_curriculum(..., generation_ref=...)` 强制要求完整新题目、逐题生成指令、轮初记忆和冻结 solver 相符，且构造响应不能复用 challenger 奖励评估中的响应。该来源随课程、优化批次和已提交失败材料保留，恢复时再次检查。

当前同一 challenger 来源记录中的更新阶段和新题池使用相同已准入任务范围、组大小和批次大小。每个 task 固定一种生成指令，调用方使用 `DiagEvoPolicy.schedule` 构造抽样计划；下文的 `prepare_challenger_job` 已将已采纳记忆、冻结随机源与实际任务封存串联。builder 本身不启动采样或完成跨作业任务准入，也不处理全无有效题时的重采样策略。下节调用方已接更新后的独立采样；完整双模型外层仍然缺失。

`seal_local` 接受最后导出权重的本地 HF 捕获，明确保存 `localBackend` 和各组稳定键，不接受虚构的 native lease。它重放同一完整更新历史，验证导出模型、tokenizer/template、采样配置、实际 prompt、任务窗口及完整 B×G 槽位，并跨所有阶段拒绝重复捕获。此模式保留真实本地来源，不将它们转成有训练资格的原生 rollout。

## 原生文本 harness 合同

两个原生 script factory 都要求 `fixedHarness.adapter="model-call"`，并在加载课程或模型前拒绝工具 harness。controller 的训练准入按实际请求检查 Hitch 的 `training_harnesses`；独立评测检查 `external_endpoint_binding="1"` 以及 `endpoint_harnesses`。部署检查也使用上游实际公布的能力名称。不能只更换 manifest 名称而继续发送工具请求。

这依赖 Hitch 的文本训练支持，尚未包含在未修改的 0.2.19 发布包内。本次固定源是 Hitch 分支 `codex/diagevo-model-call-training`、提交 `3c03d9895b70d0300f49602a366c87b587b22602`，基于 dev `cd5889d680969e5d3e5ad091d28da3d8280a2c10`；本地提交尚未推送。[完整依赖补丁](patches/hitch-model-call-training.patch)可应用到该基线并重新构建。部署时须从实际安装的 checkout 重新冻结 harness manifest、`runtimeLock.hitchCommit` 和 runtime digest，不能照抄历史运行的身份。

现有 Hitch `model-call` 在训练 binding 下仅发一次无工具的 Chat Completions 请求，预算来自 binding，幂等键为 `RUN_ID-0`，不自动重试。正常 stop 保留 provider receipt 并发出 terminated；length 发出 truncated；工具回复、取消和接口失败不转成正常样本。Gear 继续保存原生 token/logprob 和策略身份，`_capture` 的严格文本检查不放宽。

消息转换由任务创建方完成。例如把冻结的 scalar-content 消息列表封存为 Hitch 的 candidate input：

```json
{
  "schema_version": "1",
  "messages": [
    { "role": "system", "content": [{ "type": "input_text", "text": "Solve and box the answer." }] },
    { "role": "user", "content": [{ "type": "input_text", "text": "What is 1 + 1?" }] }
  ]
}
```

训练输入只接受零个或多个 system 消息加一个 user 消息，不接受图像或输入内预算／reasoning 覆盖。runner 将文本 parts 拼成原生 scalar content；调用方须确保拼接结果与 `scriptConfig.prompts` 精确一致。已有 benchmark final-response 导出合同可处理文本产物；任务、环境及 verifier 的创建／校准仍需外层实现，不因该 harness 支持而自动完成。

## 单个 challenger 作业的原生执行

`gear.training.pipelines.diagevo_challenger.build_loop` 组合 `FrozenTaskSource → HitchRolloutExecutor → ChallengerDatasetStage → ChallengerModelUpdater`，最后一阶段先调用既有 `SlimeModelUpdater`。[示例入口](../../examples/training-loop/recipes/diagevo_challenger.py)可冻结为 `trainer.script`；`scriptConfig` 有三个必需字段：`objective` 为 `DiagEvoChallengerReward.describe().to_dict()`，`solver` 为上述 `FrozenHFSolver` 构造参数（含 `model_ref` 和 `instruction`），`prompts` 为已准入 task ID 到实际消息列表的映射。调用方用 `DiagEvoQuestionPrompt.messages` 等普通函数组织消息和任务，传输 solver HF snapshot 及其依赖，不增加 adapter。可选第四字段 `freshGeneration` 启用下述更新后采样。

数据阶段先核对 native ledger 的关闭 lease、更新前权重、完整采样组、任务准入及精确 prompt，再对格式有效的问题实际采样冻结 solver。Math-Verify 绑定其原响应；现有 challenger builder 重算质量奖励，保留原 challenger token、mask、logprob 和 verifier 反馈，并交给原 updater。已完成但格式无效的问题保留为零奖励槽位；全批无有效问题时不运行 solver，不伪造回答，也不丢弃整个零方差组。

这个入口不更换 native actor：可训练 challenger 继续由 Slime 管理，冻结 solver 在独立的本地 HF 实例中执行。当前 solver 实现仅使用 CPU，尚未验收大模型显存、独立 GPU 部署或论文规模吞吐。两轮集成测试中真实执行 tiny HF forward、HTTP 捕获、SQLite ledger、数学分类及原生数据预处理，Slime actor／优化器／checkpoint 是显式替身。三处中断验证分别覆盖 solver 回执、已封存批次和训练提交丢失返回，不代表真实 GPU 数值更新已经通过。

## 更新后独立采样与制品关联

`freshGeneration` 恰好包含 `prompt`、`memory`、`nodes`、`directives`、`seed`、`maxSeconds`。`prompt` 为 `DiagEvoQuestionPrompt.describe().to_dict()`；memory/nodes 为对应 dataclass 的 JSON 列表；directives 为已准入 task ID 到 `{"mode": "free", "cause_ids": []}` 等指令的映射；seed 是非负安全整数，maxSeconds 是 1–3600 的单次生成软期限。运行前从这些材料重建的消息必须与 `prompts` 完全相同。

最后一次更新提交后，调用方先核对实际 SQLite ledger 的全部 commit，再重算已消费批次的来源与奖励。它读取最终 checkpoint 的 HF 导出，以本地 CPU float32 独立生成 B×G 条响应，保留原采样上限和部署的 `enable_thinking` 选项。任务窗口从最终已提交游标继续；任务数不足 B 时允许循环取题，但每组和槽位都有独立调用键、种子与捕获。这里使用导出的真实模型字节，不宣称 CPU 与 SGLang 的数值输出逐位一致，也不额外执行优化器更新。

最终 updater 输出含 `generationRef`、`generationUsage` 和下节的 `constructionRef`。原生 driver 将已完成四阶段结果封存为 `native-training-loop-result`，通过模型既有的 `provenanceRef → trainingLoopRef → checkpoint` 暴露给调用方；现有 CAS 图传输沿这些引用收集制品，不新增 wire 字段或独立发布通道。发布前核对该结果的最终 checkpoint、HF 导出、更新游标和 commit 与实际候选一致。

generationUsage 单列新题生成的本地调用数、输入／输出 tokens 和生成秒数，美元费用为未知；它没有并入原生 ledger 的 `TrainingUsage.rolloutTokens`。外层比较总成本时须同时计入原生 rollout、质量奖励阶段的 solver 捕获、新题生成和课程构造，不能把 native 计数当成全部生成成本。原始回执也保留中止前的结果。

训练提交返回丢失时，可在不启动 CUDA 的恢复路径继续本地采样；已经保存的回答直接重放。新题池封存后丢失返回不再加载 challenger，只运行尚未完成的 solver 构造。构造结果也已封存时，两个模型都无需加载。取消保持已完成提交，恢复后继续未完成槽位。完整但格式无效的响应保留为无效槽位，不能自动换样本直到成功。

## 新题的构造采样与作业交接

启用 `freshGeneration` 后，updater 对全部格式有效的新题重新调用同一个冻结 solver，逐题采样 `construction_samples` 条完整响应。调用键与质量奖励阶段分离，不复用其回答；两个阶段共享显式 `max_calls` 总限额。Math-Verify 分类之后，现有 builder 封存全题池、所有投票和参考响应，保留题与筛除题都在其中。缺组、截断或配额耗尽直接终止，已有回执保留，不发布部分投票，也不自动扩额。

`constructionRef` 指向 `kind="diagevo-curriculum-construction"` 的 CAS 制品，包含新题来源、可空的 curriculum 引用、challenger 原请求引用、冻结 solver 身份、保留题 ID 和本阶段真实本地用量。状态有三种：

| 状态 | 含义 |
| --- | --- |
| `ready` | 完整分类及筛选已完成，至少一道题被保留；调用方可以据此创建并准入后续作业 |
| `no-retained-questions` | 全部候选与投票已保存，但没有题满足原筛选策略，不创建 solver 训练作业 |
| `no-valid-questions` | 新题全部格式无效，不调用构造 solver，curriculum 引用为空 |

这一步没有放宽置信度阈值或生成额外候选来保证成功。就绪结果可交给下述任务封存／准入函数；solver 入口可发布轮末记忆，并由 `prepare_challenger_job` 创建下一轮任务。完整外层仍须管理两个模型的作业启动、跨轮预算和恢复。

## 保留题任务封存与准入

`gear.training.recipes.diagevo_tasks.prepare_solver_job` 在调用方侧重新计算完整课程、核对冻结 solver，然后使用实际 `hitch benchmark compile` 生成保留题的 Harbor 快照与新的 solver spec。输入包括 `construction_ref`、已经由调用方认证的原 challenger request、冻结 solver 作业模板、显式 Hitch argv 和任务配置。仅接受 `ready`；空题池由外层结束本轮，函数不会补题或调整阈值。

每个新题使用独立、合法的 Harbor ID。其 family 和来源环境引用取自实际 challenger 捕获对应的已授权 train task；原任务与新题的关系保存在 provenance 中。同一个来源任务可以生成多个新题。私有 dev／held-out 的 ID、family、任务快照、文件指纹和 instruction 内容都会参与排除检查。只有控制器持有这些私有内容，不将其发送给模型；这些检查不等于语义去重。

模型输入直接取自构造阶段的已验证请求，保留 system 指令和 user 问题，不追加写文件提示。Hitch 编译器生成真实 package/task 身份和 `candidate_input`；可信 worker 导出并在独立 verifier 中恢复 `/hitch-evidence/final-response.json`。本任务 verifier 的 `completion` 只表示规范响应完整成功，错误数学答案和空字符串仍可能是完整响应。Math-Verify／多数投票另行生成原生训练奖励，标签来源始终为 `majority_vote`，不表示数学真值。

`task_options` 要求显式提供 `sourceLicense`、固定到 OCI digest 的 `environmentImage`／`verifierImage`、`agentTimeoutSeconds`、`setupTimeoutSeconds`、`verifierTimeoutSeconds` 和 `maxResponseBytes`。环境镜像须支持实际 Hitch model-call 运行时，verifier 镜像须包含 Python 与 bash；本次 CPU 验证没有拉取或运行镜像。Hitch package publication 保留 `training_eligible=false`，不以编译成功授予训练权限；Gear 的精确捕获授权分别来自原 challenger train 范围和 solver 模板。

作业模板须已封存 solver `trainer.script`，只允许可选 `scriptConfig.memoryUpdate`；函数填入 `constructionRef` 并替换 train 分区。dev、held-out、评测策略、参考模型、部署和本作业预算均保持模板原值。起始模型、采样和模板选项必须与构造 solver 一致。外层仍需划分每个作业的预算并维护跨轮总量，不能把新实验的预算当作自动重置的总预算。

```python
from gear.training.recipes.diagevo_tasks import prepare_solver_job, admit_solver_job

# store 是控制器 CAS；challenger_request 与 construction_ref 来自已认证的
# 上一作业结果。外层负责检查作业决定，而不是信任模型提供的引用。
prepared_ref = prepare_solver_job(
    store, handoff_directory,
    construction_ref=construction_ref,
    challenger_request=challenger_request,
    solver_spec=solver_spec,
    hitch_command=controller_config["hitch"]["command"],
    task_options=task_options,
)
job = admit_solver_job(
    store, prepared_ref,
    controller_config=controller_config_path,
    gear_command=["gear"],
)
# 后续沿用 gear training run EXP_ID RUN_ID --config CONTROLLER.json。
# inspect/pause/resume/close、独立选型及发布仍属于现有 controller。
```

准备目录冻结输入和结果，重试复用原制品；改变模型、来源、配置或代码时拒绝复用。`admit_solver_job` 使用现有 controller 的 `init`／`admit --idempotency-key`，创建或准入已提交但返回丢失后仍得到同一个实验／作业。重放保留已暂停或完成的状态、决定和用量，不自动恢复训练。调用方显式提供命令，配方不依赖 CLI 实现层，也不增加 adapters。函数只完成一次交接，尚未实现多轮双模型调度。

## 单个 solver 作业的原生执行

`gear.training.pipelines.diagevo_solver.build_loop` 组合既有 `FrozenTaskSource → HitchRolloutExecutor → SolverDatasetStage → SlimeModelUpdater`。可冻结 [示例入口](../../examples/training-loop/recipes/diagevo_solver.py) 作为 `trainer.script`，在 `trainer.scriptConfig` 中提供 `{"constructionRef": ...}`。它要求状态为 `ready`，solver 起始 HF 字节、采样参数、上下文上限及 chat template 选项与原冻结 solver 一致，重新检查来源、完整题池、实际后端身份及保留题列表；准入范围必须恰好是这些保留题。

也保留底层配置 `{"curriculumRef": ..., "challengerRequestRef": ...}`，供自行组织构造采样的调用方使用；该路径不增加上述本地 solver 起始模型身份约束。课程必须绑定更新后新题池和数学分类，challenger 请求必须与生成记录一致。两个入口均不自动创建任务或扩展权限。

默认训练输入传输不遍历 `scriptConfig` 中的任意 CAS 引用。当前交接使用同一模型节点的持久 CAS，前一作业留下的来源、回执及课程仍可读取；原始冻结 solver 的权重须在首个作业前由调用方按现有权限准备。跨节点传输尚未自动接入。challenger 请求中的私有 task／verifier 引用继续留在控制器侧，不应为补齐输入而整图上传。

factory 从冻结描述重建 policy、challenger objective 和 question prompt，只解析显式允许的组件，不按制品字符串任意导入代码。随后重放来源记录并核对分类器身份。替换算法组件的调用方可在自己的冻结 script 中直接组合现有 stage，不增加 adapters 层。

数据阶段先核对实际 ledger 中的关闭 lease、更新前 checkpoint、完整原生组和来源，再执行数学分类、封存 ±1 奖励批次并交给既有 updater。原 token、mask、行为 logprob 和 verifier 反馈不变。已完成阶段按现有 `TrainingLoop` 重放；批次封存后丢失返回时可从原捕获确定性重建，参数更新提交后丢失返回时复用原生提交，不重复采样或更新。数学计算是本地运算，中断后未完成的分类可以重算，不产生额外模型调用。

这里完成的是一个已准入 solver 作业。完整外层仍须调用上述交接函数、启动作业并调度下一轮。两作业交接测试使用真实 tiny HF 新题／构造推理，但原生训练 actor、优化器和提交仍为明确标注的替身，不能作为真实 GPU 更新或论文效果证据。

## Solver 最后提交后的记忆发布

上述两种 solver 配置都可增加 `memoryUpdate`。它要求 `diagnosis` 和 `embedding` 两组参数，可选 `diagnostician` 为 `DiagEvoDiagnostician.describe().to_dict()`；未指定时沿用默认诊断规则。

| 字段 | 配置 |
| --- | --- |
| `diagnosis` | `CodexDiagnosis` 的 `model` 必填；可显式指定 `model_provider`、`effort`、`timeout_seconds`、`max_calls` |
| `embedding` | `BGEEmbedding` 的 `model_ref` 必填；可指定 `max_tokens`、`max_calls` |

根目录由现有作业目录确定，配置不能覆盖后端存储路径。模型节点须预先具备 `agents`、数学和 CPU 推理依赖、诊断服务凭据，以及 BGE 引用及其文件；当前输入传输不自动遍历这些 scriptConfig 引用，也不传输凭据。未启用该选项的作业继续使用原 `SlimeModelUpdater`。

启用后使用 `SolverModelUpdater` 包装原 updater。中间更新保持原流程，只有最后一次提交才读取实际 SQLite ledger 的全部 commit，并与运行时提交链及返回 checkpoint 对照。随后以更新后的 checkpoint 构造记忆上下文，通过 `update_committed_memory` 重建全部已消费失败、原构造参考及轮初记忆，执行诊断、检索和归并。

最终 checkpoint 增加 `memoryRef`，现有 `provenanceRef → trainingLoopRef → checkpoint.memoryRef` 关联完整 `diagevo-committed-memory` 制品，不新增发布协议。制品中的 `memory.memory` 和 `memory.nodes` 是供下一轮调度消费的状态，`callReceipts` 保留诊断／embedding 输入输出及原生身份；用量明确区分已知 tokens、缺失 usage 和本地 embedding 用量，美元费用仍未知。关联记忆不代表模型已经通过效果选型或已激活部署。

原生训练提交丢失返回后，可在不启动 CUDA 的路径完成记忆；诊断回执丢失时读取原 turn，结果不明则停止，不重发。记忆结果已保存而最终返回丢失时，从原决定和回执重建，不连接 SDK 或加载 BGE。完整四阶段结果重放也经现有 `on_progress` 回调核对记忆与全部原生回执，缺失或变化会拒绝继续发布。

取消在记忆步骤和每个外部调用前后检查，已完成调用先保存结果；当前调用仍受后端软期限约束，不提供立即中断远端 turn 的保证。取消保留训练提交和已保存回执，恢复后继续未完成记忆。下节已提供下一轮频率抽样与任务创建函数；完整双模型作业调度仍待实现。

首次执行的记忆步骤仍位于原 native 作业内，训练资源由 driver 在作业退出时释放，不能把诊断耗时视为已经释放 GPU 后的免费时间。全部训练已提交的恢复路径无需重新启动 native actor。

## 已采纳记忆到下一轮 challenger

`gear.training.recipes.diagevo_evolution.accepted_native_result` 从调用方提供的可信 controller run 记录读取已采纳模型，核对完成／采纳状态、资源释放、原始请求、模型 provenance、全部更新提交及最后 checkpoint。`accepted_solver_memory` 继续读取对应 `memoryRef`，从实际已消费失败重算频次、晋级与重新激活，检查归因／未归因集合、技能节点及诊断／embedding 回执。CAS 哈希只证明内容身份；controller 记录必须来自可信控制器，不能使用模型输出伪造采纳决定。这些检查也不证明诊断语义或多数票标签正确。

`prepare_challenger_job` 接受 challenger 作业模板、当前 solver 模型引用、question prompt、轮次／seed、推理软期限、显式命令及任务选项。第零轮只允许空记忆；后续轮要求前一轮和首轮已采纳 solver 的记录，所选 solver 必须与前一记录相符，课程 policy 保持一致。调用方负责保留首轮记录及跨轮模型顺序，函数不会自行从任意历史中挑选模型。

计划冻结首轮频次和两个记忆引用，并通过现有 `DeterministicRandom` 为 `rolloutBatchSize × (updatesPerCandidate + 1)` 个任务生成自由探索／定向／组合指令。训练更新和之后的新题采样有各自的任务槽位。首轮频次为零且后来出现 active 原因时，冻结策略为 `stop-before-next-challenger`：在编译和准入前明确报错，不重设基准、不额外采样。

计划和消息封存为 `diagevo-generation-schedule`，继承模板中已授权 train 来源，再复用与 solver 相同的实际 Hitch 编译和私有分区排除检查。模板须是已冻结 script 的单作业 `model-call` GRPO，只含 `scriptConfig.objective`／`solver`；函数替换 train，填入实际 solver HF 引用、prompts 和 freshGeneration，保留其余字段。准备目录固定输入及实现身份，重放不再次编译。`admit_challenger_job` 复用既有 controller 幂等创建／准入，保留作业暂停或终态，不自动启动或恢复训练。

```python
from gear.training.recipes.diagevo_evolution import prepare_challenger_job, admit_challenger_job

prepared_ref = prepare_challenger_job(
    store, next_round_directory,
    challenger_spec=challenger_spec,
    solver_model_ref=previous_solver_run["candidateRef"],
    prompt=question_prompt.describe().to_dict(),
    round_index=1, seed=17, max_seconds=300,
    hitch_command=controller_config["hitch"]["command"],
    task_options=task_options,
    previous_solver=previous_solver_run,
    first_solver=first_solver_run,
)
job = admit_challenger_job(
    store, prepared_ref,
    controller_config=controller_config_path, gear_command=["gear"],
)
```

这里只接受已被 controller 采纳的 solver，是 Gear 的选型适配，不宣称与论文逐轮模型更新完全相同。两个交接方向已具备独立函数，但跨轮总预算、完整双模型停止／恢复和实际训练尚未由统一外层串联；不能把一次任务准入当作多轮算法已经运行。

## 调度与状态

`Cause` 同时保存历史失败 ID 和当前 active 周期中的失败 ID，频次由后者的数量得到。调度根据冻结的首轮频次和当前 active 总频次分配自由探索概率，按 active 周期频次抽取目标；只与同技能节点中的 mastered 原因做均匀配对。随机源由调用方显式提供，输入排列不改变抽样结果。

首轮或没有 active 原因时全部自由探索。若首轮频次为零而以后出现 active 原因，纯 policy 明确拒绝；下一轮任务调用方已冻结为准入前停止，不静默改掉参考频次。这是论文未明确规定的退化情况处理方式，不代表完整多轮配方已经运行。

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

## 实际诊断、embedding 与提交绑定

`gear.training.recipes.diagevo_backends.CodexDiagnosis` 使用 `openai-codex==0.159.3` 的公开异步 SDK。每个稳定 key 只创建一个诊断 turn，固定模型、provider、effort、指令、输出 schema、期限和逻辑调用配额。实际返回的模型和 provider 必须与请求一致；回执保存原生 turn/thread 身份、输出、状态、item 类型及 usage。禁用 shell 和网页搜索，拒绝含工具 item 的诊断结果。模型名称由服务端解析，不代表已锁定服务端不可变权重版本。

请求在提交前占用配额，并保存实际发送的 JSON 文本。中断恢复只读取原 thread 中唯一的已完成 turn，核对原 turn ID、逐字输入及其 JSON 内容；无法确定结果时停止，不重发。已完成但格式无效的响应保留原回执。原生 usage 若已收到则立即落盘；恢复时缺失的 usage 标为未知，不能补成零。逻辑 turn 限额不覆盖 SDK 内部 HTTP 重试，也不是金额上限；当前没有可靠美元费用回执，`usd` 保持 `null`。

`BGEEmbedding` 对显式提供并封存的 BERT 模型文件执行本地 CPU float32 推理，使用归一化 CLS 向量，禁止远程模型代码和自动下载。文本超过冻结 token 上限时拒绝，不截断；模型、tokenizer、配置的实际字节进入 CAS，源码与依赖版本进入后端身份。`seal_bge_model` 中的来源名称和 revision 是调用方声明，字节摘要才是实际使用内容的依据。局部中断允许重算本地向量，已完成结果直接复用；计时仅包含模型前向推理，不包含加载、tokenization 或总进程耗时。

普通调用函数 `gear.training.recipes.diagevo_committed_memory.update_committed_memory(...)` 接收 post-update `TrainingContext`、绑定新题池来源的 solver builder、全部 commit refs、curriculum ref 和这两个后端实例。它重建已消费批次的失败材料，要求 context 对应最后一个提交的 checkpoint／HF 导出，再执行并验证记忆更新。每份实际回执必须匹配记忆调用的输入和输出，诊断 turn 不可重复计数；输出为包含完整回执引用、已知 token 汇总和未知用量列表的 CAS 制品。

这仍是训练调用方中的函数，没有增加 curriculum adapter 或通用执行协议。solver factory 的 `memoryUpdate` 已负责本作业 native ledger 校验及最终模型产物中的记忆关联。独立调用该函数时，调用方仍须认证提交来源并处理引用传输；下一轮作业创建尚未自动串联。

[真实后端记录](../../research/diagevo-memory-2026-11-20/README.zh-CN.md)使用 `gpt-6-astra` 与固定 revision 的 `BAAI/bge-small-en-v1.5`：第二版执行 5 个诊断 turn、4 次 embedding，在回执保存前注入中断后读取原 turn 完成恢复，断开诊断 client 后重放得到相同制品。第一版因 JSON 字段顺序导致恢复校验中止，其 1 个 turn 单独保留；两版合计 64,526 原生 tokens。BGE small 是本次实现选择，不宣称等于论文配置；solver 响应、actor 状态和提交为明确标识的 CPU fixture，训练步数为零，不能据此声称训练闭环或效果提升。

## 验证与剩余接入

`python/tests/test_diagevo_policy.py` 覆盖模糊多数票、过易／过难题、完整组、构造／优化分离、全部优化失败时的参考保留、频率抽样和同节点配对、被筛除题参与晋级、同轮晋级后重新激活、不完整题池与重复归因拒绝。

`python/tests/test_diagevo_memory.py` 另覆盖全失败组的参考保留、同节点已知原因复现、不强制归因、全量原因筛选、余弦数值边界、最大成员分数检索、候选外 ID 拒绝、空记忆建节点与归并时状态保持。纯组件可按 `Module` 重建。

`python/tests/test_diagevo_round.py` 使用明确标识的持久化测试服务覆盖整轮处理、同轮新原因去重、晋级和重新激活、重叠节点对、提取／embedding／分配／归并后回执丢失、最终提交后中断、未知结果、未提交恢复、并发所有权、预算耗尽及侧录缺失。这些测试服务不是实际 LLM 或 embedding 效果证据。

`python/tests/test_diagevo_challenger.py` 使用真实 NLTK／scikit-learn 覆盖奖励峰值及截断、跨组重复惩罚、格式错误与完整分母、零／单有效问题、缺失／跨策略／复用证据拒绝、输入顺序影响和 Module 重建。

`python/tests/test_diagevo_data.py` 使用明确标识的原生捕获合同 fixture，验证完整批次封存、重建一致性、原 token／mask／logprob／反馈保留、同 task 不同 prompt 拒绝、未准入任务／开放 lease／重复请求拒绝、solver 问题／指令／策略漂移、构造缺项和等价类证据覆盖。

`python/tests/test_diagevo_solver.py` 另覆盖完整题池与筛选、全失败组、构造／优化捕获隔离、分类约定、消费批次和提交链、恢复父状态、空失败原文及真实记忆调用流程的衔接。

`python/tests/test_diagevo_generation.py` 覆盖三种生成 prompt、更新后权重关联、旧请求换名拒绝、跨更新 solver 漂移、记忆与实际 prompt 一致性、无效新问题保留、构造响应不能复用奖励评估，以及新题池进入已提交 solver 失败材料。提交和模型状态为明确标识的 CPU 合同 fixture，不表示执行了优化器更新。

`python/tests/test_diagevo_answers.py` 使用实际 Math-Verify 验证数值／符号等价、最终答案提取、未解析回答隔离、构造类别沿用及 ±1 原生奖励；另检查异常、共享软期限、非传递比较和新答案匹配多个类别时拒绝分类。

`python/tests/test_diagevo_pipeline.py` 通过实际 script factory、原生 driver、回环 HTTP 捕获、SQLite ledger 和预处理跑两轮 solver 作业，并从消费提交恢复失败材料。Slime/Ray actor 与 checkpoint 为 CPU 替身。另覆盖封存后返回丢失、提交后返回丢失、任务准入和组件身份约束。

`python/tests/test_diagevo_backends.py` 使用 SDK 类型化通知替身和真实 tiny BERT，检查 schema、模型身份、未知提交不重试、原 turn 恢复、JSON 字段顺序、调用配额、回执漂移、向量归一化及不截断。`python/tests/test_diagevo_backend_round.py` 用显式离线回执检查最终 checkpoint、实际输入输出关联、原生 turn 去重、用量缺失及重放。

`python/tests/test_diagevo_inference.py` 使用真实 tiny causal LM，核对实际 token／logprob、权重冻结、CPU RNG 恢复、模板选项、剩余上下文预算、稳定槽位、无加载重放、本地中断、内容漂移与截断拒绝。`python/tests/test_diagevo_challenger_pipeline.py` 验证上述两轮原生 challenger 接入和三处中断，另覆盖 prompt 漂移及全无效问题。CI CPU 作业安装 `agents` 及训练依赖以运行这些测试。类型检查仍限于 `pyproject.toml` 配置的 78 个文件，不宣称覆盖全部新增原生后端文件。

`python/tests/test_diagevo_fresh_pipeline.py` 用真实 tiny HF forward 生成格式有效的新题，并检查最终导出来源、重复任务的独立分组、三处返回丢失恢复、提交后的取消，以及旧权重／不完整组／复用训练捕获的拒绝。新题与使用的参数由测试夹具预先构造，原生训练 actor／优化器仍是替身，因此这些检查不证明训练带来新能力。

`python/tests/test_diagevo_construction_pipeline.py` 使用真实 tiny HF 和数学分类检查独立构造捕获、完整筛除记录、空题池、配额耗尽后的重放、结果返回丢失恢复，以及模型／采样／范围漂移拒绝。两个不同作业目录共享模型节点 CAS，前一作业的课程被后一 solver 作业实际消费，并可恢复其已提交失败材料。就绪路径显式将夹具策略 `p_high` 设为 1，以接纳恒定输出 boxed 2 的小模型；这只验证交接，不代表默认难度窗口有效。第二作业请求和 native actor 是测试替身，没有验证控制器自动创建／准入任务或真实梯度更新。

`python/tests/test_diagevo_memory_pipeline.py` 将 solver 实际消费的提交、数学失败材料、真实 tiny BERT 和 SDK 类型化消息替身接到模型 provenance。覆盖两次提交仅在末次更新记忆、提交／诊断回执／最终返回丢失、完整阶段重放时的回执缺失、ledger 漂移、调用后的取消、未知 turn 停止重发和缺失 usage 保留；另串联新题构造、第二 solver 作业及最终记忆。SDK 响应、原生 actor、优化器和任务请求仍为明确替身，本组没有收费模型调用，也没有真实梯度或效果证据。

`python/tests/test_diagevo_text_harness.py` 单独启动真实 Hitch `model-call` 进程、run-scoped proxy 和 Gear `ExactGateway`，再用实际保存的回执通过 DiagEvo `_capture`；核对单次调用、无工具消息、幂等键、receipt ID 和原 token 保留。模型使用显式 byte-token 替身，verifier／任务准入为 fixture，不声称 Harbor 或 GPU 执行。它同时检查旧 Hitch 能力缺失和原生 factory 选用工具 harness 时提前拒绝。此前的 driver 集成用例由测试控制器直接发送 HTTP，不覆盖这一真实 runner 边界。

`python/tests/test_diagevo_tasks.py` 使用实际 Hitch package 编译器、快照封存／还原和 Gear `init`／`admit` 子进程，把保留题接到真实准入请求并通过 solver factory 校验。另验证准备／创建／准入返回丢失不重复建作业、固定评测与预算保留、私有内容／family 冲突、起始模型／授权／投票漂移，以及可信最终响应导出／恢复后执行实际打包 verifier。native actor、部署元数据和容器环境仍为显式 CPU fixture，未拉取 Docker 镜像或运行 GPU。

`python/tests/test_diagevo_evolution.py` 将真实 tiny HF／BERT 两作业链产生的记忆，经频次重算、下一轮调度、实际 Hitch 编译与 controller 准入交给 challenger factory。另检查无记忆首轮、固定输入重放、来源／所选 solver 漂移、未采纳作业、篡改频次及回执缺失。此前作业的采纳决定、原生 actor 和 SDK 消息是显式测试替身，本组不证明真实评测采纳或多轮 GPU 收益。

当前共 142 个 DiagEvo 用例在完整依赖环境一次运行全部通过，无跳过项；下一轮调度与任务交接的 7 项定向验证也通过。最小依赖环境为 40 个通过、102 个因缺少可选依赖或未配置独立 Hitch checkout 跳过。设置以下环境变量可运行跨仓库文本合同和任务交接测试，普通 CI 未设置时会明确跳过，不计为已验收：

```sh
GEAR_DIAGEVO_HITCH_PATH=/absolute/path/to/built/hitch \
PYTHONPATH=python:python/tests \
python -m unittest test_diagevo_text_harness test_diagevo_tasks test_diagevo_evolution -v
```

此前 Gear 的 46 项定向回归覆盖训练及评测的固定 harness 准入、能力缺失和实际 Python 节点部署探测。本次 `admission-replay`、`controller-cli`、`coordinator`、`iteration` 四个文件的 50 项回归通过，覆盖并发创建、落盘后返回丢失、已完成／暂停作业重放和旧调用方式兼容。Hitch 的 runner／binding 回归 16 项、远程工作图回归 4 项此前通过；后者使用真实打包、代理与 worker 协议，Harbor、Docker 和 canonical bundle 为 fixture。本次 Gear 构建、TypeScript 类型检查、Ruff 与依赖边界检查通过；Python 类型检查仍仅指上述 78 文件。

上一批 driver、GRPO、脚本及配方回归有 57 个通过，4 个因未设置 `GEAR_PINNED_SLIME_SOURCE` 跳过，不将这些跳过项计为已验收。

保留题与已采纳记忆均已有任务封存／controller 准入函数及单次交接重放。尚缺跨轮预算、完整双模型作业编排及停止／恢复，以及双模型真实训练和效果对照。美元成本也尚无可靠来源。两个方向的数据交接、轮末记忆发布和真实推理／记忆后端验证不替代完整 DiagEvo 或 GPU 实验验收。

接入两模型更新时还有三个已核实的边界：

- [DiagEvo 附录 D](https://arxiv.org/html/2609.00768v2#A4)要求先用一批问题更新 challenger，再从更新后的 challenger 采样另一批候选；不能把第一批题直接作为 solver 课程。两个单作业入口及更新后的本地采样已接入；完整入口仍须串联 challenger 更新、新题构造与 solver 更新，并验证实际训练效果。
- 全失败优化组仍是诊断材料。[原生采样路径](../../python/gear/training/backends/slime/rollout.py)选择跳过／重抽时，只在返回的 raw groups 中保留训练准入组；完整调用方需要明确使用已支持的 `zeroVarianceGroup="keep"`，或另行保留并验证未准入组，不能因为没有梯度信号而丢掉失败证据。
- [现有原生采样合同](../../python/gear/training/recipes/agent_grpo.py)只接受 `topP=1`，而论文报告为 0.99。完整配方必须扩展并验证对应行为分布合同，或预先声明使用 `topP=1` 的适配实验；不能将不支持的参数写进配置后视为已经实现。

此外，模型节点当前制品引用图上限为 4096 个对象、16 MiB metadata。论文规模的一批 challenger 加每题 12 条 solver 捕获可能超过该上限；完整入口需要在更新前核验体量，并接入相应的分页或独立证据保留能力。当前小批 CPU 合同验证没有覆盖该规模，也不能据此声称论文默认批量可运行。
