# Agent-R-inspired 轨迹搜索与执行修复

[agentr_retail.py](agentr_retail.py) 提供固定权重的失败来源重放 → MCTS → 好坏路径配对 → 错误位置提议 → 实际回退 → 新后缀执行 → 修复材料入口。CPU retail 环境执行和转换留在调用方，复用 `gear.curriculum.BuildSupervision` 的输入输出；没有新增 adapters 层或通用环境运行时。

**本版本不做 GPU 训练。** 入口输出可审计的修复材料与语义步范围，不输出原生训练 token/logprob，不运行 SFT。经过下方准入入口，修复材料可以作为对应原训练任务的补充证据进入正式 Meta 搜索；候选仍以原始 validation 选型，最终 test 另行成对评价。真实模型效果仍待验收。

依据为 [Agent-R 论文](https://arxiv.org/html/2501.11425v1)与 [Apache-2.0 官方源码的冻结版本](https://github.com/ByteDance-Seed/Agent-R/tree/82fcc1ca7873b460949ed49022146dd988c32e31)，重点核对 `mcts_utils/mcts_raw.py`、`mcts_utils/webshop/mcts_ws.py` 和 `path_collection.py`。这里独立实现搜索和验证机制，没有运行上游的训练程序，也不声明复现其 benchmark 结果。

## 已实现的路径与上游差异

| 阶段 | 本调用方行为 |
| --- | --- |
| 来源 | 显式指定一个完整失败的 train `RetailCollector` 目录；离线重放原模型回执、工具、评分与校准。family、policy、环境和实现必须一致 |
| 搜索 | 将原失败的实际前缀放入树，再按 UCT 选择、独立采样多个下一动作、执行环境、对完成叶子回传奖励。源路径的存在不算已经完成模型扩展 |
| 去重和未知 | 完全相同的动作与实际反馈复用节点，不重复累计奖励；采样调用仍计费。达到步数上限但未结束的路径 reward 为 null，不回传零分 |
| 配对 | 只配原始失败与经过原任务 verifier 检查的成功路径；二值奖励差固定为 1。优先共同前缀最长，其次成功路径最短，最后按稳定身份排序 |
| critic | 从分叉处逐步检查失败路径，只提供截至当前步的公开对话、政策及整次尝试失败的事实。good/uncertain 继续，首个 bad 保留该动作并结束定位 |
| 回退 | 在新内存数据库重放 critic 截止的失败前缀，再独立重建好坏路径的共同前缀；保存前后数据库、对话与动作摘要。critic 的截止点晚于分叉点时，仍回到共同前缀 |
| 修复 | 从真实恢复的检查点重新采样后缀，仅提供失败的公开上下文与 critic 意见。不给 actor 搜索出的好分支或隐藏参考答案。新后缀必须重新执行并通过原任务评分 |
| 材料 | 保留失败、回退、重执行轨迹和评分的分别引用，调用 `BuildSupervision` 输出修复提案。共同前缀 loss=False，新后缀 loss=True；没有伪造原生训练捕获 |
| harness | 离线重放完整修复产物，绑定已准入的原训练任务，将公开失败／修复对话与回退位置提供给本次任务范围内的 Meta。候选修改、约束修订和训练门槛沿用正式 `ReflectiveSearch` |

上游会按奖励条件选择多组好坏路径，再把失败前缀、反思文本与好路径后缀拼接为训练材料。本入口每次处理一个失败、一对路径及一次新后缀；配对规则、固定二值奖励与原失败入树是具体适配。它没有直接复用搜索到的好后缀，而是增加真正的状态回退和新后缀验证。这是 Gear 的加强验收要求，不表示上游文本拼接已经证明状态连续，也不是完整迭代 SFT 配方。

MCTS 使用 `mean_reward + exploration * sqrt(log(parent_visits) / child_visits)`，未访问的开放节点优先，关闭节点不再选择。这里 visits 只统计不同的、已完成且已评分的叶子。每个节点最多进行一次 `branch_samples` 扩展，一次 iteration 沿树继续下降／扩展直到关闭节点，最多下降源 solver 的 `max_steps`。已扩展节点的全部子节点关闭后逐级关闭，根关闭就提前结束。所有平局使用显式 seed 和稳定节点身份；不会把纯随机采样称为 MCTS。

## 状态、评分与可见材料

回退能力只适用于调用方自有的、可丢弃的内存模拟器。每条工具边都从原始数据库重新执行全部前缀，核对工具观察与每一步前后状态；对话也属于检查点身份。这个入口不能撤销真实外部服务上的订单操作。

源 collector 已执行参考解与空动作／漏写负例校准。搜索及修复继续使用同一原任务的 native DB verifier，并检查鉴权、订单归属与独立政策审查。仅 native reward=1、访问检查通过且政策审查通过才算成功。政策判断来自模型，不能保证完全可靠；原始 native 结果和判断理由均保留。失败或未完成的新后缀不会用树中已有的成功路径填补。

搜索 actor 仅见 `policy/tools/conversation`。critic 仅见公开前缀；修复 actor 额外看到失败的公开对话、critic 意见和实际回退位置。用户模拟器只接收其目标、客户资料与用户／助手对话；隐藏 task、数据库和参考仅由执行／评分端持有。所有模型调用继承源 collector 的 model 和 effort，不更新权重。搜索和带修复上下文的行为分别有新 policy ID，不能冒充原始单次 rollout 的完全相同策略。

修复的 native 轨迹从原始状态包含重执行的共同前缀及新后缀，`RepairVerification.mode="verified_replay"`；实际 rollback 作为单独证据绑定。错误后缀不拼进这条连续轨迹。`training_eligible=false`：普通推理回执并非可信训练捕获，后续若训练仍须获得新的原生 token/mask 证据，本版不执行此步骤。

## 配置和运行

沿用 [SENTINEL 安装步骤](SENTINEL.zh-CN.md#安装与运行)，准备同版本 Tau2 和一份已完成的训练失败。无需本地 GPU、Docker 或训练 controller：

```python
import json
from pathlib import Path

source = Path("/path/to/completed-failed-collector").resolve()
record = json.loads((source / "result.json").read_text())["observation"]["record"]
config = {
    "schema_version": 1,
    "partition": "train",
    "family": record["family"],
    "source_workspace": str(source),
    "policy_id": record["policy_id"],
    "iterations": 4,
    "branch_samples": 4,
    "exploration": 0.25,
    "seed": 17,
    "max_calls": 256,
}
Path("/tmp/gear-agentr-input.json").write_text(json.dumps(config, ensure_ascii=False))
```

```sh
PYTHONPATH=python /tmp/gear-sentinel-env/bin/python \
  examples/curriculum-harness/agentr_retail.py \
  --input /tmp/gear-agentr-input.json --workspace /tmp/gear-agentr-generation \
  --tau2-source /tmp/gear-sentinel-tau2 --preflight
```

`--preflight` 只重放来源和验证设置，不打开 SDK。去掉该参数执行搜索与修复；换成 `--replay` 则用完成回执重建整个结果，不允许 SDK fallback。恢复使用同一目录、配置、来源和源码；改变任一冻结条件应使用新目录。

`iterations` 为 1–32，`branch_samples` 为 1–8，`exploration` 为有限的 0–10 数值，`max_calls` 为 1–8192。动作步数沿用源 collector 上限。所有新搜索 actor、用户模拟、政策审查、critic 和修复调用共享一个 `TextCalls` 预算。`max_calls` 计逻辑模型 turns，不是 token／美元硬上限；原始失败采集的用量另计。配额用尽后停止并保留中间证据，不自动加预算。

稳定调用键和原始完成回执支持已收费响应丢失后的恢复；工具只在新的内存库中重放。未知远程调用由 `TextCalls` 检查原 turn，未确认前不换键重提。API 故障或格式错误不会补成任务零分；完成但未结束的轨迹保留未知评分。

主要输出为：`source.json`、`source-grading.json`、每次扩展及 UCT 决策、完整 `tree.json`、`pair.json`、逐步判断与 `boundary.json`、`rollback.json`、修复检查点／上下文／新动作／native 评分、`repair/execution-proof.json` 和 `repair/supervision.json`。离线重放核对全部 JSON 产物和模型请求清单，额外或被修改的证据均拒绝。

`result.status` 含义：`ready` 为新后缀通过检查；`no_success` 为搜索未获得成功路径；`no_boundary` 为 critic 未指出错误；`repair_failed` 为新后缀完整但未通过；`incomplete` 为新后缀达到步数上限仍未结束。后三者及没有成功路径时不输出修复提案。`effect_verified` 始终为 false，单次原题修复不能证明持续改进。

## 接入正式 harness 搜索

[agentr_harness.py](agentr_harness.py) 是具体调用处的转换。沿用 [SENTINEL 正式搜索配置](SENTINEL.zh-CN.md#正式-harness-搜索)，增加可选字段：

```json
{
  "agentr_workspaces": ["/tmp/gear-agentr-generation"]
}
```

把该字段加入原搜索配置后，继续运行 [sentinel_search.py](sentinel_search.py)。`pool_workspace` 的已选 train 池必须包含失败来源的原始 native task、数据库与 user；family 也须一致。修复材料不会扩充任务池或改变固定／生成配额。搜索基线的 model、effort、harness 和 max_steps 必须与失败来源一致，不能把另一条策略的失败无声归给当前基线。后续候选仍由搜索产生并重新执行，历史修复评分不充当候选分数。

准入接受 1–16 个绝对路径，逐一离线重建 Agent-R 搜索、critic、回退、新后缀、原任务评分及监督提案。只有 `ready` 才可进入。相同目录及相同任务／源策略／失败动作／修复动作的重复材料均拒绝，改写 sample 或路径不能重复计数。输出 `agentr-context.json`：公开对话、critic 位置与意见、回退机制和步数、实际评分摘要；审计 provenance 与成本另存字段。整个封存文件最多 1 MiB，超限拒绝，不截断执行证据。

只有 Meta 的 provider profile 带该文件的路径、摘要与任务清单；target profile 不接收。每次 Meta 调用先核对文件摘要和 train 范围，再只投影本次操作 task IDs 的材料，复核对应指令。Meta 看不到数据库快照、私有 user instructions、隐藏参考、native verifier 定义或产物路径；执行中实际返回给 actor 的工具观察属于公开轨迹，可以保留。solver 仍只接收政策、工具和当前对话。文件变化、改写任务或越界引用在 SDK 调用前拒绝，包括已有回执的恢复检查。

正式搜索沿用 `Project.refine`／worker、`PromptConstraints`、有限修订和训练门槛，只修改 `AGENTS.md`。validation/test 均保持原始 native 环境和 family 隔离；搜索不打开最终 test。选型后再使用同一原始 test 分别评价 baseline 和选中 harness。新增、删除或替换修复材料需新搜索目录与 run；原 run 的 manifest、profile、Meta 请求及回执均冻结。

搜索结果额外记录 `agentr_context_digest`、`agentr_generation_usage` 和 `agentr_source_collection_usage`。写入最终结果前再次验证材料摘要，防止成本字段在最后一次 Meta 调用后被改写。生成用量包含所引用产物的 MCTS、用户模拟、审查、critic 和新后缀；源采集按唯一 input/result 身份只计一次。原 collector 的 completed_calls 在这里转换为已完成逻辑调用数，预算上限不作为实际用量相加。任何一个 token 用量未知就不提供合计，不能将未知补零或报告部分总数。两类先前调用成本独立于本次 search 的模型用量和任务尝试数；正式效果对照应同时计入。未准入或中止的其他生成尝试仍须由实验外层台账另计，不能把这些字段当作所有尝试的总费用。

## 验证与待办

[Agent-R 测试](../../python/tests/test_agentr_retail.py)使用实际 Tau2 工具与 native 评分，模型响应是显式 fixture。覆盖误取消另一张订单后的状态回退、critic 较晚定位、重新执行的正确后缀、语义 mask、UCT 与去重、多轮树关闭、未知分数、失败不回填、材料隔离、收费回执恢复、离线篡改检测及无 SDK CLI 预检。

```sh
GEAR_TEST_SENTINEL_RUNTIME=1 \
GEAR_SENTINEL_TAU2_PATH=/tmp/gear-sentinel-tau2 PYTHONPATH=python \
  /tmp/gear-sentinel-env/bin/python -m unittest discover \
  -s python/tests -p 'test_agentr*.py' -v
```

[正式接入检查](../../python/tests/test_agentr_search.py)需要先构建 Gear CLI（`npm run build`），覆盖完整来源重放、原任务／策略／family 绑定、作用域内的材料消费、无新任务准入、隐藏材料隔离、付费 Meta 响应恢复、结果成本篡改拒绝及原始 test 成对评价。模型响应是明确 fixture；有无材料的分支用于证明输入实际影响调用链，不作为算法收益证据。
