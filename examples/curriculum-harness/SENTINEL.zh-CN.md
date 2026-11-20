# SENTINEL 的 retail 数据生成调用方

当前实现可恢复的调用链：实际 solver 执行与评分 → 训练轨迹去重与抽样 → 合并失败记忆 → 选择目标 → 实际工具探索 → 参考重放 → 编写新任务 → 执行校准与语义检查 → 固定／生成任务混合池 → 新 run 的正式 harness 搜索。使用固定权重的模型服务和 CPU 上的 Tau2 retail 工具，**不做 GPU 训练**。

这是 [SENTINEL §3.3–3.4](https://arxiv.org/html/2606.12908v1#S3.SS3) 的部分接入：先执行参考轨迹，再生成对应请求。retail 混合池和三组对照入口已通过离线模型的实际 CLI／worker 集成；该配方的真实搜索效果对照和 mastery 探针仍待验收，没有导出一个宣称完整复现的 `gear.algorithms.SENTINEL`。

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

[sentinel_collect.py](sentinel_collect.py) 与参考探索共用实际工具对话循环。输入是 `schema_version=1`、显式 `partition`（`train`／`validation`／`test`）、`family`、`database`、`user_id`、native `task`、已执行 `reference`，以及 `model`、`effort`、`harness`、`max_steps`、`max_calls`、`sample_id`、`attempt`。每次采集先重新执行参考和两个负例，核对 task 的 gold actions，拒绝隐式初始状态、额外断言、persona 或用户工具。输出保留原分区，validation／test 观测不能进入训练生成器。

```sh
PYTHONPATH=python /tmp/gear-sentinel-env/bin/python \
  examples/curriculum-harness/sentinel_collect.py \
  --input /path/to/retail-solver.json \
  --workspace /tmp/gear-sentinel-solver \
  --tau2-source /tmp/gear-sentinel-tau2
```

solver 只看到 policy、工具定义、实际对话；用户模拟器只看到私有用户指令、该客户资料和可见对话。工具观测、写操作及终态单独保存并重放。评分为 **native DB × 确定性认证／归属检查 × 独立模型的 policy 审查**；语义审查仍可能误判，不等于完整 Tau2 评分。真实工具错误可以被记录并恢复；恢复后满足条件仍可成功。步数用尽保留 `complete=false, passed=null`；API 未知或模型输出不符合动作合同会停止，保留已有回执，不伪造执行或失败。

`result.json` 中 train 分区的 `observation` 可进入生成器，证据指向封存输入、轨迹、评分和校准。policy 身份绑定模型、harness、动作合同、用户模拟／评分条件、实现与调用预算。无 GPU 权重更新。

## 固定／生成混合池

[sentinel_pool.py](sentinel_pool.py) 接收 `schema_version=1`、`partition="train"`、`family`、`database`、`user_id`、`seed`，以及以下四个字段：

| 字段 | 内容 |
| --- | --- |
| `fixed` | 已授权固定任务列表，每项为 `{task, reference, evidence_refs}` |
| `generated` | 已完成生成工作目录的路径列表 |
| `fixed_count`, `generated_count` | 各来源的明确数量，分别为 0–128，合计非零 |

运行方式与前述命令相同，将脚本替换为 `sentinel_pool.py` 并提供独立 workspace。生成任务的完整输入、每次模型请求、结果、记忆及验证材料均以保存回执重新计算，真实工具和 native verifier 重新执行；该路径没有 SDK 客户端、没有缺失回执时的在线补跑。只能消费匹配当前冻结实现的记录，旧版本须用原提交重放。

固定任务同样执行参考校准。所有任务须属于同一个训练环境与 family；重复任务 ID 或精确内容被拒绝。按显式 seed 无放回选择，两类配额不足会返回 `insufficient` 和空选择，不暗中补齐。输出包含完整数据库、task、reference 和来源，仍为待准入提案；后续正式搜索须创建新的 run，不能改写正在运行的任务池。

## 正式 harness 搜索

[sentinel_search.py](sentinel_search.py) 先离线复核混合池的完整来源、结果和实现身份，仅准入非空 `ready` 池；固定的 validation／test 任务也必须执行参考校准。三类任务 ID、精确内容和 family 均隔离。native task 保持原 ID，调用处生成合法、稳定的 Gear ID，映射保存在 `admission.json`；不会因此修改 curriculum 合同。

输入 JSON 包含以下字段：

| 字段 | 内容 |
| --- | --- |
| `schema_version`, `pool_workspace` | `1`，已完成混合池的工作目录 |
| `validation`, `test` | 各自非空的固定任务数组；每项含 `partition`、`family`、`database`、`user_id`、`task`、`reference`、调用方授权的 `evidence_refs` |
| `harness`, `model`, `meta_model`, `effort` | 初始完整提示、固定 solver 和 Meta 模型、推理设置 |
| `max_steps`, `max_calls` | 每次任务执行的步数上限 1–64；本次搜索共享的正整数逻辑模型调用预算 |
| `max_characters`, `target_characters`, `max_repairs` | 硬字符上限、较小的写作目标、有限修订次数；由现有 `PromptConstraints`／`ReflectiveSearch` 校验 |

在本仓库先安装 npm 依赖并完成 `npm run build`，使用当前 Python 源码和同一虚拟环境运行：

```sh
GEAR_COMMAND='["node", "/path/to/gear/lib/cli.js"]' \
GEAR_PYTHON=/tmp/gear-sentinel-env/bin/python \
PYTHONPATH=/path/to/gear/python \
/tmp/gear-sentinel-env/bin/python examples/curriculum-harness/sentinel_search.py \
  --input /path/to/retail-search.json \
  --workspace /tmp/gear-sentinel-search \
  --tau2-source /tmp/gear-sentinel-tau2
```

`--preflight` 只检查配置与计划，不调用模型。CLI 默认将 profile 放在 workspace 的 `profiles` 目录；直接调用 `search()` 时显式设置 `GEAR_PROFILE_ROOT`。入口使用实际 `Project.refine`、独立 worker、`ReflectiveSearch` 和训练门槛，超长候选通过既有修订路径处理。validation 只用于选型；`nominate=false`，本入口不打开最终测试。正式效果实验仍须在优化结束后独立评价固定 test。

[sentinel_provider.py](sentinel_provider.py) 实现现有 Gear process provider 协议。目标只解释封存候选中的 `AGENTS.md`，拒绝额外 Pi 设置／扩展；不声称执行 Pi 本身。Meta 只获得声明的 train 任务与材料，不能请求 validation／test 内容，也不会收到完整 verifier 或参考轨迹。目标执行结果、实际对话、工具观测和评分进入正式 evidence；未完成轨迹为 `task_failed, score=null`，完整失败才是有效的 0 分。

同一 workspace 绑定一个不可变 run；中断后检查原 journal 并恢复，不另建收费 run。provider 检查已提交的模型 turn：未知保持 `unknown`，确实尚未提交的下一步返回 `resumable`；inspect 不发新调用。已完成回执可重建操作结果，工具重放始终使用新的内存数据库。所有任务与 Meta 共享 `max_calls`，同时保留实际完成调用的原生 usage；不宣称 HTTP、token、美元硬上限或可靠取消。扩池或改变初始 harness 时须使用新的 workspace／run。

## 验证与待办

### 固定／随机／failure 对照入口

[sentinel_experiment.py](sentinel_experiment.py) 在调用方组合现有采集、生成、混合池和正式搜索。三组初始 harness、固定模型、任务执行条件、每轮搜索上限和池大小一致；fixed 全部使用原始任务，random／failure 使用相同固定份额加生成份额。两种生成共用实际探索、参考重放、校准、写作和语义审查。随机组仅从预先声明的 `random_targets` 均匀抽取一个学习目标，不接收结果、失败记忆或案例；failure 组只接收当前 harness 的训练探针。当前对照不测跨轮 failure memory 的独立收益。

直接运行生成器时，`conditioning` 可设为 `random`（省略时为 `failure`）；random 必须同时传入非空、无重复的 `random_targets`，`observations=[]`，且不能传入 `history`。两种模式不互相回退。写作者只描述客户目标、已知事实和约束，不要求把认证／确认步骤写进私有用户指令。

实验配置包含以下字段；三组配置在首次模型调用前冻结：

| 字段 | 内容 |
| --- | --- |
| `schema_version`, `training` | `1`；training 含 `family/database/user_id/fixed`，fixed 条目与混合池一致 |
| `validation`, `test` | 与正式搜索相同的固定独立任务数组；启动前对所有原始任务校准并检查隔离 |
| `seeds`, `rounds` | 不重复的显式抽样 seed、1–8 轮；seed 控制任务抽样和组别顺序，不控制模型采样 |
| `harness`, `model`, `meta_model`, `effort` | 初始提示、solver／生成模型、正式搜索 Meta 模型、推理设置 |
| `max_steps`, `calls_per_task`, `calls_per_generation`, `calls_per_search` | 每次执行步数，每个采集／评测任务、每次生成、每轮正式搜索的逻辑调用配额；不宣称 token／美元硬上限 |
| `fixed_count`, `generated_count`, `generation_attempts` | 固定份额、生成份额、每组每轮预先限定的生成尝试数；fixed 原始池至少满足两份额之和 |
| `random_targets` | 不依赖失败观测的已授权训练领域目标列表 |
| `max_characters`, `target_characters`, `max_repairs` | 与正式搜索相同的候选约束 |

使用前述 `GEAR_COMMAND`、`GEAR_PYTHON`、`PYTHONPATH` 设置，命令为：

```sh
/tmp/gear-sentinel-env/bin/python examples/curriculum-harness/sentinel_experiment.py \
  --input /path/to/preregistered-retail-study.json \
  --workspace /tmp/gear-sentinel-study \
  --tau2-source /tmp/gear-sentinel-tau2
```

`--preflight` 不执行模型请求。所有尝试均记录，不在观察到拒绝后追加尝试。池缺额时，该轮不启动搜索，保留当前 harness，并将整份研究标记 `comparable=false`；不会用固定任务填补生成份额。未完成测试不会折算为 0 分或从分母剔除，此时通过率为 `null`，不计算组间差值。

所有 seed／组／轮完成选型后，先封存 `test-admission.json`，再评测相同的固定 test；validation／test 不进入生成或 Meta。相同 seed 内完全相同的 harness 共用同一份采集／测试观测，避免重复收费及引入无意义的模型随机差异。配置、源码、编译 CLI、原生后端、provider、任务和最终选型均绑定摘要；恢复重新检查原记录并复用调用键。汇总计数来自唯一原生回执，不累加复用观测；配额上限与实际消耗分别报告。结果只给出描述性逐 seed 配对差值，不声称统计显著性。

新增 5 项检查覆盖随机组无失败输入、实际 native 校准与离线重放、未完成观测的指标、三组正式运行及恢复、全拒绝后的缺额和不可比较状态。测试中真实执行 Gear CLI／worker、Tau2 工具与 DB 评分；模型仍为明确替身，不构成真实提升证据。

```sh
GEAR_TEST_SENTINEL_RUNTIME=1 \
GEAR_SENTINEL_TAU2_PATH=/tmp/gear-sentinel-tau2 \
PYTHONPATH=python:python/tests /tmp/gear-sentinel-env/bin/python \
  -m unittest test_sentinel_retail test_sentinel_collect test_sentinel_pool test_sentinel_search test_sentinel_experiment test_formal_curriculum_harness -v
```

本批共 47 项定向检查通过：45 项工具、provider、恢复与隔离检查，另 2 项实际 CLI／worker 集成。正式集成覆盖超长候选拒绝与修订、训练门槛、6 个真实 native 任务执行、丢失外层返回后的同 run 恢复、扩池后第二个独立 run 以及缺额池拒绝准入；最终测试未打开。模型与语义审查均为明确替身，不能作为真实模型效果证据。此前 58 项 curriculum 纯算子回归记录保留；原始单轮诊断测试仍使用明确源失败夹具，采集和正式评分测试则执行真实工具与 native verifier。

CI 的 `Curriculum / tool environments CPU` 作业安装固定 Tau2、构建 Node CLI，并运行 `test_sentinel*.py`，启用正式 runtime 集成；未安装可选依赖时只运行纯采样检查，跳过 native 集成，不把跳过项当作通过。

[首版真实模型接入记录](../../research/sentinel-retail-2026-11-20/README.zh-CN.md)：冻结源码 `03c8f4d66`，11 次 `gpt-6-astra` 调用、154,167 tokens，生成一条待准入任务，离线重放未新增调用。该首版原始失败为明确夹具，不能声称真实源失败采集或收益；须在原冻结版本验证。

[实际 solver 与记忆探针](../../research/sentinel-retail-2026-11-20-v2/README.zh-CN.md)：冻结源码 `9d7a3e4c8`，正常 harness 的实际样本成功，明确提前结束的诊断对照实际失败。失败驱动生成 1 条候选，执行校准通过，但语义审查拒绝；记忆正常传递，混合池报告生成来源缺额且不补齐。23 次完成调用有 332,115 tokens；另 1 次容量失败单独保留并确认终态，随后在剩余预算内作一次明确恢复，全尝试 token 总数未知。导出后工具与决定重放一致、无新增模型请求。两份归档均附上游 MIT 许可，需使用各自冻结源码复核。该诊断对照不代表自然失败率或收益；retail 的真实搜索效果对照和 mastery 测量仍待验收。
