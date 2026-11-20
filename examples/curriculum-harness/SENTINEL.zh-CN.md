# SENTINEL 的 retail 数据生成调用方

当前实现一个可恢复的生成触发：已授权的训练轨迹 → 去重与成功／失败抽样 → 诊断 → 选择失败目标 → 实际工具探索 → 参考重放 → 编写新任务 → 执行校准与语义检查 → 待准入任务。使用固定权重的模型服务和 CPU 上的 Tau2 retail 工具，**不做 GPU 训练**。

这是 [SENTINEL §3.3–3.4](https://arxiv.org/html/2606.12908v1#S3.SS3) 的部分接入：先执行参考轨迹，再生成对应请求。当前尚未串联多轮失败记忆、固定／生成数据混合、新任务的正式搜索准入或该配方的效果对照；没有导出一个宣称完整复现的 `gear.algorithms.SENTINEL`。

## 实现与证据

[sentinel_generate.py](sentinel_generate.py) 直接组合 `ExtractOutcomeCases`、`ContrastiveDiagnoser`、`MergeFailureMemory`、`SelectLearningTargets`、`PlanPractice`、`GeneratePractice`、`ValidatePractice` 和 `SelectPractice`。单次触发暂从空记忆开始；诊断快照会保存，跨轮消费尚未接入。模型输入与 native task 的转换就在调用处，没有 curriculum adapters 或新执行协议。

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

调用方须从自己的执行记录构造 observations，并验证其证据可见性、真实性和使用授权。字符串形式的 evidence ref 本身不是证明。所有记录必须属于同一个训练 family 和具体环境身份；环境身份可用 `RetailSession(load_backend(source_root), database, user_id).identity` 得到。测试使用明确的源失败和模型响应替身，不能作为真实 student 失败采集的证据。

重复 attempt 先按既有算子选择；相同 task／policy／environment／tool trace 不重复诊断，冲突的 verdict 被拒绝。抽样保留成功与失败两类，不从未完成轨迹推断失败。非 train、其他环境或缺少来源引用的记录在模型调用前被拒绝。

```sh
PYTHONPATH=python /tmp/gear-sentinel-env/bin/python \
  examples/curriculum-harness/sentinel_generate.py \
  --input /path/to/authorized-retail-generation.json \
  --workspace /tmp/gear-sentinel-generation \
  --tau2-source /tmp/gear-sentinel-tau2
```

同一工作目录继续执行会校验原输入、算子、源码、模型、调用记录位置和配额。工具重放只作用于重新创建的内存副本；外部模型结果由 `TextCalls` 的稳定键与原 turn 协调，未知结果会停止，不重发收费请求。保存结果后丢失返回可沿原路径恢复。配额是逻辑 SDK turn 数，不是底层 HTTP、token 或美元硬上限。结果中的 `model_usage` 只统计已完成且保存的调用；缺少原生 usage 时 token 保持未知。

工作目录保留 `input.json`、诊断、逐次模型输入／回执、工具步骤、`reference.json`、`calibration.json`、`validation-evidence.json` 和 `result.json`。证据引用包含文件摘要与检查项；这些文件由调用方管理，不另造 CAS 或运行时。

## 验证与待办

```sh
GEAR_SENTINEL_TAU2_PATH=/tmp/gear-sentinel-tau2 \
PYTHONPATH=python:python/tests /tmp/gear-sentinel-env/bin/python \
  -m unittest test_sentinel_retail test_formal_curriculum_harness -v
```

本批 21 项定向检查通过，其中 15 项是新 SENTINEL 测试，6 项复用模型回执恢复与隔离检查；另有 58 项 curriculum 回归通过。新测试中的 retail 执行、取消、退款、参考重放和 native DB 正负例检查是真实代码执行；模型、原始 solver verdict 和语义审查均为明确替身。还覆盖记录后返回丢失、输入／模型漂移、截断、未知模型结果、身份认证、工具参数、调用方输入被修改以及训练范围隔离。

CI 的 `Curriculum / tool environments CPU` 作业安装固定 Tau2 并运行这些测试；未安装可选依赖时只运行纯采样检查，跳过 native 集成，不把跳过项当作通过。当前没有真实模型工具探索结果、完整 Tau2 评测或 SENTINEL 相对 fixed/random 的收益证据。下一步是将源失败采集、跨轮记忆与生成池接入固定权重的正式 harness 搜索。
