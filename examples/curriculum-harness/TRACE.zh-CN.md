# TRACE-inspired 环境生成与校准

[trace_generate.py](trace_generate.py) 实现无 GPU 的能力发现 → 重复标注 → 能力筛选 → Python 环境生成 → 隔离执行 → 固定权重 rollout → 难度校准。`gear.curriculum` 新增纯 `ContrastCapabilities` 算子及输入输出；模型调用、源轨迹转换、Docker 执行和恢复留在这个具体调用方，没有 adapters 层。

依据是 [TRACE 论文](https://arxiv.org/html/2604.05336v2)和[官方源码的冻结版本](https://github.com/ScalingIntelligence/TRACE/tree/d2db23085409555b3f13ea426f42d62cf0bbc43d)：重点核对了 `aggregate_capabilities.py`、环境生成提示词、`calibrate_environment.py` 和 `collect_rollouts.py` 的聊天工具环境合同。上游代码为 MIT。这里实现并验证其生成与校准机制，没有运行论文训练程序。

**本版本不做 GPU 训练。** 本入口的完成状态表示生成环境通过本次执行、语义和难度检查，不表示 harness 已提升。通过检查的环境可以经下方混合池入口进入新的正式 `Project.refine` run；候选仍由原始 retail 验证任务选型。固定／随机／能力定向三组真实模型效果对照仍待验收。专项 LoRA、GRPO、MoE 组合及路由属于后续范围。

## 来源与能力筛选

来源必须是显式列出的 [RetailCollector](sentinel_collect.py) 训练目录。调用方使用已完成模型回执重新执行源工具、native 评分和语义判断，核对配置、全部模型请求、轨迹、校准和结果。同一 sample 不重复计数，也不能改写。来源使用同一 family、后端实现和 solver policy；仅完整成功与失败参与能力统计。没有两类结果时返回 `no_contrast`，不调用生成模型。API 未知或不完整轨迹不会补成失败。

发现调用输出一份规范能力字典。之后每个独立标注调用都只看到同一字典和完整源轨迹，不接收前一轮的标签；每轮必须覆盖所有能力 × 所有案例，标签为 `NA`、`PRESENT` 或 `LACKING`。这些是模型判断，不是因果归因证明。

对每个能力、每轮标注计算：

- coverage = 缺失该能力的失败数 / 全部失败数。
- ER− = 缺失该能力的失败数 / 需要该能力的失败数；ER+ 对成功样本采用同样公式。
- gap = ER− − ER+。同时满足 coverage、gap 阈值的轮数达到 `minimum_consistent_runs` 才入选。

无适用样本的分母保留为未知，不能通过 gap 门槛。这比上游将空分母置零更保守。只对 gap 有定义的轮次求均值，同时保存定义轮数和通过轮数。一次生成处理入选能力中均值 gap 最大的一项；不会把每个失败都直接转成能力。

## 可执行环境与检查

生成器输出独立的标准库 Python 模块，用自行构造的合成状态实现原始工具接口的非空子集，不能导入或包裹 Tau2。工具名称、参数 schema 和定义保持一致；返回值形状、政策、能力迁移及答案隐藏另外接受语义审查。

模块实现 `CapabilityGame`：`reset(seed)`、`get_system_prompt()`、`get_tool_schemas()`、`get_messages()`、`step(action_json)`、`get_summary()`、`done`、`_conversation` 和有界 `max_steps`。动作是 `{name, arguments}`；`respond_to_user` 接收 `{message}`。另提供 `reference_actions(seed)`。摘要包含实际动作数与有限的 `[0,1]` 奖励，允许部分分。

[执行通道](trace_environment.py)每次从相同 seed 在新 CPU 容器重放动作前缀，宿主不 import 生成代码。镜像使用本机不可变 image ID，禁止自动拉取；容器无网络、只读根目录、非 root、无额外 capabilities，仅挂载生成模块和可信 driver 两个只读文件，不挂载工作区或凭证。设置 CPU、内存、进程数、时长和输出上限，每次结束只清理本次创建的容器。此隔离用于限制代码执行范围，不是生成 verifier 正确性的证明。

每个校准 seed 实际执行参考解、空动作、跳过工具直接作答、工具前缀加错误最终答案。参考解必须终止且奖励为 1；三个负例都必须小于 1。重置和参考动作必须可重放，不同 seed 的初始请求必须不同。语义调用检查实际执行记录、政策、任务和参考一致性、返回形状、解法隐藏与新颖性。生成的奖励函数仍可能有未覆盖漏洞；有限负例与模型审查不能保证原始 benchmark 上的泛化。代码相同的修订不会重复执行；无效代码、语义拒绝或难度拒绝可在 `max_revisions` 内反馈给下一次生成。

solver 只接收系统政策、工具定义和可见对话，不接收源码、参考动作、内部状态或奖励。其模型、effort、harness 和步数预算与源 collector 设置一致。生成环境使用不同聊天动作协议，因此分别记录 `source_policy_id` 和 `calibration_policy_id`，不能把二者当成完全相同的 benchmark 策略或直接比较绝对分数。

## 校准与恢复

每个 seed 必须有完整、唯一的 `sample_idx=0..group_size-1` 分组；固定环境及校准策略身份。完成轨迹的奖励必须有限，未结束轨迹为 `reward=null`。任何未知样本使整份分布成为 `incomplete`，缺少分组成员则拒绝统计；不删去困难样本、不拿部分分组替代预定样本数。

统计平均奖励、总体标准差、成功率、零分率、全成功／全零／常数分组比例、非恒定分组比例，以及按 sample_idx 排序的经验 first-k pass@k。这里的 pass@k 是前 k 条中至少一次成功的任务比例，不是组合数无偏估计。所有门槛在首次调用前显式冻结。通过校准意味着对当前固定 solver 存在所声明的难度和变化，不等于产生了学习收益。

所有生成与 solver 调用共用一个 `TextCalls` 预算。`max_calls` 计逻辑模型 turns，包含发现、重复标注、代码生成、语义审查和 rollout，不是 token／美元硬上限；原始采集成本另计。保存稳定调用键、完整请求和回执，中断后在新容器重放工具前缀、复用已有回执。未知调用使用现有 reconcile 机制；不会以新键偷偷重提或计为零分。Docker／API 故障停止执行并保留未完成记录，不作为算法效果。

`--replay` 使用保存的响应离线重建来源、能力筛选、环境检查和每个 rollout，并核对 JSON 产物清单、模型请求清单及最终结果；没有 SDK fallback。仍需要相同 Docker 镜像、源码、Tau2 后端与原来源目录。

## 配置和运行

沿用 [SENTINEL 安装步骤](SENTINEL.zh-CN.md#安装与运行)，并预先准备标准库 Python 3.10+ 的 Linux Docker 镜像。运行者先核对镜像来源，再把 `docker image inspect --format '{{.Id}}' <镜像>` 的完整 ID 写入配置；入口不自行下载镜像。本阶段不需要 Node 或 GPU。

下面从同一固定 solver 的已完成训练成功、失败样本构造输入。示例采用两个 seed、每组四条，仅用于运行路径检查，不能代替足够规模的效果实验：

```python
import json
from pathlib import Path

success = Path("/path/to/success-collector").resolve()
failure = Path("/path/to/failure-collector").resolve()
source = json.loads((success / "input.json").read_text())["config"]
record = json.loads((success / "result.json").read_text())["observation"]["record"]
config = {
    "schema_version": 1, "partition": "train", "family": source["family"],
    "source_workspaces": [str(success), str(failure)],
    "policy_id": record["policy_id"],
    "capability_parameters": {
        "max_capabilities": 8, "coverage_threshold": 0.1,
        "gap_threshold": 0.2, "minimum_consistent_runs": 8,
    },
    "labeling_runs": 8,
    "generator": {"model": source["model"], "effort": source["effort"]},
    "solver": {key: source[key] for key in ("model", "effort", "harness", "max_steps")},
    "image": "填写实际 sha256: 开头的完整本机镜像 ID",
    "seeds": [17, 18], "group_size": 4,
    "thresholds": {
        "mean_min": 0.2, "mean_max": 0.6,
        "success_min": 0.2, "success_max": 0.6, "std_min": 0.05,
        "max_all_success_groups": 0.2, "max_all_zero_groups": 0.2,
        "max_constant_groups": 0.5, "min_informative_groups": 0.5,
        "success_threshold": 1, "zero_threshold": 0, "pass_at_k": [1, 4],
    },
    "max_calls": 11 + 8 * source["max_steps"], "max_revisions": 0,
}
Path("/tmp/gear-trace-input.json").write_text(json.dumps(config, ensure_ascii=False))
```

```sh
PYTHONPATH=python /tmp/gear-sentinel-env/bin/python \
  examples/curriculum-harness/trace_generate.py \
  --input /tmp/gear-trace-input.json --workspace /tmp/gear-trace-generation \
  --tau2-source /tmp/gear-sentinel-tau2 --preflight
```

`--preflight` 重放来源并检查隔离通道，不打开 SDK 或提交模型调用。去掉该参数运行生成；换成 `--replay` 则离线校验已有完整结果。恢复使用同一目录、配置及实现。调整模型、预算、阈值或源码后应使用新目录，不能覆盖原实验。

产物包括 `history.json`、能力字典和逐轮标签、`assessments.json`、生成计划、每版代码与环境身份、正负例执行记录、独立审查、每个 seed/sample 的模型输入和轨迹、分组校准、验证／选择报告及最终用量。`training_eligible=false`，这些草案没有自动取得训练或正式搜索准入。

## 混合池与正式 harness 搜索

[trace_pool.py](trace_pool.py) 在调用处把通过校准的环境展开为指定 seed 的练习；沿用 [sentinel_pool.py](sentinel_pool.py) 的固定／生成配额。`generated` 列表可以包含：

```json
{
  "recipe": "trace",
  "workspace": "/tmp/gear-trace-generation",
  "draft_id": "从生成结果 selected 取实际 draft ID",
  "seeds": [31, 32, 33]
}
```

每个 seed 算一条生成任务，必须和环境难度校准的 seeds 不重合；来源 family、原始工具定义和已通过的 draft 必须匹配。池构建先用保存的回执离线重放整个生成与校准，再对新 seed 执行参考与负例；公开上下文必须不同，不能只换 seed 或代码摘要就重复计入同一练习。新 seed 的参考验证不冒充重新测量过的 solver 难度分布。固定来源仍是原始 retail 任务，生成环境保留自己的合成状态，不会被伪装成 Tau2 task。两类配额不足返回 `insufficient`，不补抽或用另一类任务填补。

接着沿用 [正式 retail 搜索配置](SENTINEL.zh-CN.md#正式-harness-搜索)，将 `pool_workspace` 指向这个新池。无需新增算法或 provider：`sentinel_search.py` 显式准入每条 TRACE 代码／执行身份、seed、公开上下文及验证摘要，profile 冻结整个任务包的 digest；`sentinel_provider.py` 直接调用隔离的 `TraceCollector` 执行候选。未经声明、修改过代码或 seed 的任务在模型调用前拒绝。

TRACE 环境只能进入 **train**。validation/test 必须继续使用原始 retail 环境与 native verifier，并保持 family 隔离。模型 solver 仅见公开政策、工具和对话；Meta 仅获得训练指令与执行反馈，不获得生成代码、参考动作或私有验证／测试内容。候选仍只修改 `AGENTS.md`，复用正式 `ReflectiveSearch`、训练门槛、长度约束、有限修订和回执恢复。每轮训练成功率使用已冻结的 `success_threshold` 将完成 reward 转为 0/1；原始 reward 另存反馈。未完成轨迹保持 `score=null`。

搜索本身不打开最终 test。待候选选择完成后，调用方用 [RetailCollector](sentinel_collect.py) 在同一份原始 test 上分别评价 baseline 和选中 harness，保留 test 分区；不能把合成环境上的分数上涨直接算成迁移收益。扩展池后使用新的搜索目录和 run，不能在原 run 中增加任务。权重始终固定。

## 验证边界

[核心测试](../../python/tests/test_curriculum_capabilities.py)验证标签矩阵、来源和算子绑定、coverage/gap 公式、重复标注一致性及未知分母。[校准与 collector 测试](../../python/tests/test_trace_calibrate.py)、[隔离测试](../../python/tests/test_trace_environment.py)和[生成调用方测试](../../python/tests/test_trace_generate.py)使用真实 CPU Docker 和 Tau2 执行，模型响应与生成代码均为显式 fixture。它们覆盖参考／负例、完整分组、语义拒绝、修订上限、付费回执恢复、离线重放和无 SDK 预检；不证明真实模型发现的能力或生成环境质量。

本轮本地通过 65 项 curriculum 回归、22 项 TRACE 检查及 69 项既有 retail／CoEvolve 回归，共 156 项；执行覆盖真实 Docker、Tau2 与正式 CLI／worker，模型响应均为替身。新增 5 项混合池／正式搜索检查覆盖新 seed 内容重复、准入篡改、未知结果、恢复及原始留出评测。Ruff、依赖边界和文档本地链接检查通过；纯算子代码未改变，上一阶段 mypy 结果仍适用。离线重放会比较原始 Python 源文件字节，拒绝仅 JSON 汇总一致而执行文件已变更的制品。CPU CI 已配置相同检查和固定 digest 的 Python 镜像；本地通过不表示远端 CI 已运行。

```sh
GEAR_TRACE_PYTHON_IMAGE=实际完整镜像ID \
GEAR_SENTINEL_TAU2_PATH=/tmp/gear-sentinel-tau2 PYTHONPATH=python \
  /tmp/gear-sentinel-env/bin/python -m unittest discover \
  -s python/tests -p 'test_trace*.py' -v
```

[正式接入测试](../../python/tests/test_trace_search.py)使用真实 CPU Docker、Gear CLI／worker 和 Tau2 评分，覆盖混合池、显式准入、材料隔离、未知结果、收费回执恢复，以及选型完成后在原始 test 执行 baseline／选中 harness。模型决策均为明确 fixture；测试中出现的分数变化只是执行链路检查。

真实 LLM 生成质量、校准分布、原 benchmark 留出收益和单位成本收益尚未验收。不能用 fixture 中预设的一半成功或任何生成环境上的高分代替这些结果。
