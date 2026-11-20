# SENTINEL 的 retail 数据生成调用方

当前实现可恢复的调用链：实际 solver 执行与评分 → 训练轨迹去重与抽样 → 合并失败记忆 → 选择目标 → 实际工具探索 → 参考重放 → 编写新任务 → 执行校准与语义检查 → 固定／生成任务混合池。使用固定权重的模型服务和 CPU 上的 Tau2 retail 工具，**不做 GPU 训练**。

这是 [SENTINEL §3.3–3.4](https://arxiv.org/html/2606.12908v1#S3.SS3) 的部分接入：先执行参考轨迹，再生成对应请求。当前尚未将 retail 混合池交给正式 harness 搜索，也没有该配方的效果对照或已测 mastery 探针；没有导出一个宣称完整复现的 `gear.algorithms.SENTINEL`。

## 实现与证据

[sentinel_generate.py](sentinel_generate.py) 直接组合 `ExtractOutcomeCases`、`ContrastiveDiagnoser`、`MergeFailureMemory`、`SelectLearningTargets`、`PlanPractice`、`GeneratePractice`、`ValidatePractice` 和 `SelectPractice`。显式 `history` 输入携带原始案例和记忆；诊断只使用当前抽样，生成目标仍能引用旧案例。模型输入与 native task 的转换就在调用处，没有 curriculum adapters 或新执行协议。

[sentinel_retail.py](sentinel_retail.py) 使用真实 `RetailDB`、`RetailTools`、`Environment` 和 `EnvironmentEvaluator`。依赖固定在 Tau2 `v1.0.1` / `fc0055dc4e0a316c3f83133267fbd6faaa770992`，启动时核对 installed package 与 checkout 的全部 Python 源码、策略及依赖版本，拒绝修改过的来源。[来源记录](sentinel-source.json)包含版本和 MIT license 摘要；上游源码、数据库和基准任务均未复制进 Gear。

数据库必须由调用方显式提供，环境工厂不会回退到 benchmark 数据。工具只修改本次会话的内存副本；计算表达式和转人工工具暂不支持。用户模拟器只收到选定客户的已知资料、内部目标和实际对话，不收到参考工具结果。每次工具返回、前后状态摘要和终态均保存；独立重放重新执行读和写，不能只凭终态相同接受篡改过的中间观测。

任务写作在完整参考重放通过之后开始。写作者只能提供用户文本，reference、工具动作和 verifier 均由调用方从执行记录构造。native DB 校验必须接受参考轨迹，同时拒绝空操作与删除全部写操作的负例。身份认证、客户／订单归属另作确定性检查；用户确认是否充分、文字与目标是否一致、是否泄露解法由独立模型调用作语义检查，不能当作执行证明或正确性 oracle。拒绝、无失败、无诊断目标、步数用尽均不自动补抽。

native task 的 `reward_basis` 明确只有 `DB`，不会用空 `COMMUNICATE` 条件声称通过完整沟通检查。消费该任务时必须继续使用同一个显式数据库及环境工厂；单独把 task 交给上游默认 registry 不能保证正确状态。`ready` 仅代表通过当前验证策略，输出仍为 `training_eligible=false`，不自动创建 Gear task 或授予执行／训练资格。新颖性目前只做全部来源指令的精确比较，不宣称语义去重。

## 安装与运行

已在独立 Python 3.12 环境验证；无需 torch、CUDA 或训练节点。先安装依赖并保留同一固定版本源码：

```sh
python3.12 -m venv /tmp/gear-sentinel-env
/tmp/gear-sentinel-env/bin/python -m pip install -r examples/curriculum-harness/sentinel-requirements.txt
git clone --depth 1 --branch v1.0.1 https://github.com/sierra-research/tau2-bench.git /tmp/gear-sentinel-tau2
```

模型调用沿用 [TextCalls](model_calls.py) 和已有 Codex SDK 登录。输入文件包含以下字段，不读取环境变量中的模型密钥：

| 字段 | 内容 |
| --- | --- |
| `schema_version`, `partition` | `1`, `"train"` |
| `family`, `database`, `user_id` | 已授权训练 family、独立 retail 数据库和选定客户 |
| `observations` | `{record, tool_calls}` 数组；record 为 `OutcomeRecord` JSON，tool_calls 为真实 `{name, arguments}` 序列 |
| `model`, `effort`, `seed` | 固定模型与推理设置、显式抽样随机源 |
| `max_steps`, `max_calls`, `max_cases` | 工具／对话步数上限 1–64；逻辑 SDK 调用配额 1–256；案例抽样上限 2–128 |
| `history`（可选） | 上一轮 `memory.json` 的完整内容：`schema_version`、`scope`、`observations`、`memory` |

调用方须从自己的执行记录构造 observations，并验证其证据可见性、真实性和使用授权。也可直接消费下述 collector 返回的 `observation`。字符串形式的 evidence ref 本身不是证明。所有记录必须属于同一个训练 family 和具体环境身份；环境身份可用 `RetailSession(load_backend(source_root), database, user_id).identity` 得到。自动化测试的模型响应均为明确替身，不能作为真实模型收益证据。

同轮重复 attempt 先按既有算子选择；相同 task／policy／environment／tool trace 在当前轮和历史中均不重复诊断，冲突的 verdict 被拒绝。已导出的历史样本不可改写；重试须在封存该轮前协调完成，后续新探针使用新 `sample_id`。旧支持案例必须存在且保持完整失败，成功反例还须匹配 solver policy。无新失败时保留记忆且不调用模型；未出现旧失败不代表已掌握，本调用方拒绝无测量的 mastery 状态。抽样保留成功与失败两类，不从未完成轨迹推断失败。非 train、其他环境或缺少来源引用的记录在模型调用前被拒绝。

```sh
PYTHONPATH=python /tmp/gear-sentinel-env/bin/python \
  examples/curriculum-harness/sentinel_generate.py \
  --input /path/to/authorized-retail-generation.json \
  --workspace /tmp/gear-sentinel-generation \
  --tau2-source /tmp/gear-sentinel-tau2
```

同一工作目录继续执行会校验原输入、算子、源码、模型、调用记录位置和配额。工具重放只作用于重新创建的内存副本；外部模型结果由 `TextCalls` 的稳定键与原 turn 协调，未知结果会停止，不重发收费请求。保存结果后丢失返回可沿原路径恢复。配额是逻辑 SDK turn 数，不是底层 HTTP、token 或美元硬上限。结果中的 `model_usage` 只统计已完成且保存的调用；缺少原生 usage 时 token 保持未知。

工作目录保留 `input.json`、诊断、`memory.json`、逐次模型输入／回执、工具步骤、`reference.json`、`calibration.json`、`validation-evidence.json` 和 `result.json`。结果通过 `memory_ref` 绑定历史快照。证据引用包含文件摘要与检查项；这些文件由调用方管理，不另造 CAS 或运行时。

## 实际 solver 采集

[sentinel_collect.py](sentinel_collect.py) 与参考探索共用实际工具对话循环。输入是 `schema_version=1`、`partition="train"`、`family`、`database`、`user_id`、native `task`、已执行 `reference`，以及 `model`、`effort`、`harness`、`max_steps`、`max_calls`、`sample_id`、`attempt`。每次采集先重新执行参考和两个负例，核对 task 的 gold actions，拒绝隐式初始状态、额外断言、persona 或用户工具。

```sh
PYTHONPATH=python /tmp/gear-sentinel-env/bin/python \
  examples/curriculum-harness/sentinel_collect.py \
  --input /path/to/retail-solver.json \
  --workspace /tmp/gear-sentinel-solver \
  --tau2-source /tmp/gear-sentinel-tau2
```

solver 只看到 policy、工具定义、实际对话；用户模拟器只看到私有用户指令、该客户资料和可见对话。工具观测、写操作及终态单独保存并重放。评分为 **native DB × 确定性认证／归属检查 × 独立模型的 policy 审查**；语义审查仍可能误判，不等于完整 Tau2 评分。真实工具错误可以被记录并恢复；恢复后满足条件仍可成功。步数用尽保留 `complete=false, passed=null`；API 未知或模型输出不符合动作合同会停止，保留已有回执，不伪造执行或失败。

`result.json` 中的 `observation` 可进入生成器，证据指向封存输入、轨迹、评分和校准。policy 身份绑定模型、harness、动作合同、用户模拟／评分条件、实现与调用预算。无 GPU 权重更新。

## 固定／生成混合池

[sentinel_pool.py](sentinel_pool.py) 接收 `schema_version=1`、`partition="train"`、`family`、`database`、`user_id`、`seed`，以及以下四个字段：

| 字段 | 内容 |
| --- | --- |
| `fixed` | 已授权固定任务列表，每项为 `{task, reference, evidence_refs}` |
| `generated` | 已完成生成工作目录的路径列表 |
| `fixed_count`, `generated_count` | 各来源的明确数量，分别为 0–128，合计非零 |

运行方式与前述命令相同，将脚本替换为 `sentinel_pool.py` 并提供独立 workspace。生成任务的完整输入、每次模型请求、结果、记忆及验证材料均以保存回执重新计算，真实工具和 native verifier 重新执行；该路径没有 SDK 客户端、没有缺失回执时的在线补跑。只能消费匹配当前冻结实现的记录，旧版本须用原提交重放。

固定任务同样执行参考校准。所有任务须属于同一个训练环境与 family；重复任务 ID 或精确内容被拒绝。按显式 seed 无放回选择，两类配额不足会返回 `insufficient` 和空选择，不暗中补齐。输出包含完整数据库、task、reference 和来源，仍为待准入提案；后续正式搜索须创建新的 run，不能改写正在运行的任务池。

## 验证与待办

```sh
GEAR_SENTINEL_TAU2_PATH=/tmp/gear-sentinel-tau2 \
PYTHONPATH=python:python/tests /tmp/gear-sentinel-env/bin/python \
  -m unittest test_sentinel_retail test_sentinel_collect test_sentinel_pool test_formal_curriculum_harness -v
```

本批 37 项定向检查通过，其中 31 项为 SENTINEL 测试，6 项复用模型回执恢复与隔离检查；另有 58 项 curriculum 回归通过。retail 执行、取消、退款、solver DB 评分、参考重放和 native 正负例均是真实代码；模型与语义审查为明确替身。覆盖恢复、隔离、截断、未知结果、真实工具错误后恢复、历史支持与跨轮去重、混合配额不足和篡改回执拒绝。原有单轮诊断测试仍使用明确源失败夹具，采集测试则由实际执行与评分产生 verdict。

CI 的 `Curriculum / tool environments CPU` 作业安装固定 Tau2 并运行这些测试；未安装可选依赖时只运行纯采样检查，跳过 native 集成，不把跳过项当作通过。

[首版真实模型接入记录](../../research/sentinel-retail-2026-11-20/README.zh-CN.md)：冻结源码 `03c8f4d66`，11 次 `gpt-6-astra` 调用、154,167 tokens，生成一条待准入任务，离线重放未新增调用。该首版原始失败为明确夹具，不能声称真实源失败采集或收益；须在原冻结版本验证。

[实际 solver 与记忆探针](../../research/sentinel-retail-2026-11-20-v2/README.zh-CN.md)：冻结源码 `9d7a3e4c8`，正常 harness 的实际样本成功，明确提前结束的诊断对照实际失败。失败驱动生成 1 条候选，执行校准通过，但语义审查拒绝；记忆正常传递，混合池报告生成来源缺额且不补齐。23 次完成调用有 332,115 tokens；另 1 次容量失败单独保留并确认终态，随后在剩余预算内作一次明确恢复，全尝试 token 总数未知。导出后工具与决定重放一致、无新增模型请求。两份归档均附上游 MIT 许可。该诊断对照不代表自然失败率或收益；retail 的正式搜索交接、独立效果对照和 mastery 测量仍待验收。
