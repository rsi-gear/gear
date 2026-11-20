# CoEvolve-inspired retail 环境探索

[coevolve_retail.py](coevolve_retail.py) 提供固定权重下的调用链：已采集的 solver 历史 → 三类行为信号 → 完整轨迹摘要 → 多次独立工具探索 → 聚合执行记录并构造任务 → 参考重放与校准 → 混合池 → 正式 harness 搜索。**本版本不做 GPU 训练。** `gear.curriculum` 仍只包含纯算子和输入输出；执行、转换、保存与恢复都在调用方，没有 adapters 层。

研究依据是 [CoEvolve §3.1–3.3](https://arxiv.org/html/2604.15840v1#S3)：三类信号引导环境探索，再把交互记录转成可执行任务。核对时[官方链接指向的仓库](https://github.com/StoneHanaMori/CoEvolve)只有 README、图片和许可文件，本实现依据论文机制编写，没有复制或宣称运行上游训练程序。

## 当前边界

实现使用既有 [Tau2 retail 执行通道](SENTINEL.zh-CN.md)，不是论文的 AppWorld/BFCL 复现。策略版本对应固定模型、harness 和执行设置；历史中的“遗忘”表示可比任务上出现先成功、后失败的观测，不等于证明模型权重发生遗忘。

原始历史来自 [RetailCollector](sentinel_collect.py)。调用方逐个读取显式指定的工作目录，用保存的模型回执重新执行工具、native DB 评分和已保存的语义判断；请求、完整轨迹、评分、校准、策略身份和结果都必须一致。重放没有 SDK 提交路径。来源必须是同一 train family、同一数据库／客户、同一执行与评分实现。源目录和回执由调用方授权保管；本地一致性校验不是对外部身份或时间戳的密码学认证。

输入历史按 `iteration` 升序排列，每个 iteration 只允许一个 solver policy。每个任务的相同 iteration 构成 boundary rollout group；当前策略必须匹配最后一个 iteration，只有最后一轮的信号可作为本次生成目标。旧记录供历史窗口和动作频率统计使用。同一 sample 不重复计数，也不能换组或改写；独立采集、内容恰好相同的多个 sample 仍是多个观测。未知／未完成结果不提供失败或低频统计。

三个信号通过 `signals` 分别启停；阈值交给现有 `ExtractLearningSignals`。本调用方把动作模式具体定义为**每条完整轨迹中成功执行过的不同工具名**，不按工具参数归类，不推断从未执行的动作。抽样使用显式 `seed` 和 `max_contexts`，保留每条轨迹所有启用的信号标签。

每个入选轨迹先生成结构化探索上下文。随后从相同初始数据库独立执行 `exploration_runs` 次探索；每步真实调用工具，模型能看到前面的实际反馈。每条记录包含 run ID、动作、返回值、对话和状态摘要。全部轮次结束后聚合记录，写作者选择一个有效 run 并生成用户请求与私有客户目标。解法保留该 run **完整的已执行动作序列**，不让模型凭空写出执行证明或跨状态拼接动作；至少需要三个工具动作。

接纳要求参考从初始状态重放成功、native DB 奖励为 1、空操作和移除写操作的负例奖励均为 0，并通过独立语义调用检查目标一致性、信号忠实度、认证／确认和解法隐藏。新颖性同时记录精确比较与语义判断，比较范围是全部来源任务及本轮之前已接受的任务。语义判断不是 oracle，也不保证相对于未提供的外部任务库新颖。此策略比论文的执行／奖励接纳方式更保守；没有另跑一个拿到生成解法的 LLM validator。

`PracticePlan.conditioning="signal"` 允许完整成功或失败案例，保留原始 outcome；它解决 rare/boundary 可能来自成功轨迹的情况。`failure` 仍只允许失败案例，`random` 仍不接收案例材料。`signal` 本身不自动计算或证明信号，实际信号由本调用方先提取和绑定。

## 配置与运行

沿用 [SENTINEL 的 Python 3.12、Tau2 和 SDK 安装步骤](SENTINEL.zh-CN.md#安装与运行)。本入口不需要 Node；接入后续正式搜索时才需要构建 Gear CLI。

先用 collector 收集新旧 harness 的训练样本，保留整个工作目录。下面从已经完成的 collector 输入与结果生成配置；路径换成调用方实际持有的绝对路径：

```python
import json
from pathlib import Path

old = Path("/path/to/prior-solver-sample").resolve()
current = Path("/path/to/current-solver-sample").resolve()
source = json.loads((current / "input.json").read_text())["config"]
record = json.loads((current / "result.json").read_text())["observation"]["record"]
config = {
    **{key: source[key] for key in (
        "schema_version", "partition", "family", "database", "user_id", "model", "effort"
    )},
    "history": [
        {"workspace": str(old), "iteration": 0},
        {"workspace": str(current), "iteration": 1},
    ],
    "policy_id": record["policy_id"],
    "signals": ["forgetting", "boundary", "rare"],
    "signal_config": {
        "history_window": 5,
        "boundary_threshold": 0.5,
        "rare_frequency": 0.05,
        "minimum_patterns": 20,
    },
    "seed": 23,
    "max_contexts": 1,
    "exploration_runs": 2,
    "max_steps": 24,
    "max_calls": 104,
}
Path("/tmp/gear-coevolve-input.json").write_text(json.dumps(config, ensure_ascii=False))
```

`model`/`effort` 在这里控制生成侧；可以和 source solver 不同，配置中必须显式给出。`policy_id` 始终指历史中的当前 solver。边界信号需要同一任务／策略／iteration 下的多个真实样本；两个不同策略各一个样本只足以提供相应历史，不构成 boundary group。

```sh
PYTHONPATH=python /tmp/gear-sentinel-env/bin/python \
  examples/curriculum-harness/coevolve_retail.py \
  --input /tmp/gear-coevolve-input.json \
  --workspace /tmp/gear-coevolve-generation \
  --tau2-source /tmp/gear-sentinel-tau2 \
  --preflight
```

`--preflight` 重放全部来源、保存信号与选择结果，不导入 SDK 或调用模型。去掉该参数执行生成。配置、源码、后端、完整来源快照、模型输入与回执均冻结；恢复使用同一个目录、配置和源码。后续策略样本使用新 sample ID、新 iteration 和新的生成目录。不能把旧源码下的历史直接重新解释为当前实现的评分记录。

`max_calls` 限制本次生成提交的逻辑模型 turns；它包含摘要、目标、用户模拟、工具决策、任务写作和语义审查，不是 HTTP、token 或美元硬上限。原始 solver 采集成本另计，来源重放只消耗 CPU。API 未知结果交由既有 `TextCalls` reconcile，不重新提交同一键；配额用尽或外部调用失败会停止，不伪造成功或失败任务。没有信号时返回 `no_signals`、零新调用；无有效参考或验证拒绝时不补抽。

主要产物：

- `history.json`：已重放的源记录和完整轨迹；`signals.json`：统计输入、启用信号和入选案例。
- `contexts/<index>/`：信号、练习计划、每次探索、选中的参考、校准与验证证据。
- `model/`、`calls/`：模型输入、完成回执与实际提交记录。
- `result.json`：候选、入选 draft IDs、用量；`training_eligible=false`，不自动授权执行或训练。

## 混合池与正式搜索

既有 [sentinel_pool.py](sentinel_pool.py) 的 `generated` 列表可直接接收：

```json
{
  "recipe": "coevolve",
  "workspace": "/tmp/gear-coevolve-generation",
  "draft_id": "从 result.json 的 selected 取一个实际 ID"
}
```

池构建先离线重跑整个生成 trigger，核对来源、模型请求、探索和校准，再导出这条 native task。保留固定／生成数据的精确配额；不足时返回 `insufficient`，不暗中拿固定任务补齐。之后按 [正式 retail 搜索流程](SENTINEL.zh-CN.md) 运行 `sentinel_search.py`，保持 validation/test 与 train family 隔离，生成数据进入新的 `Project.refine` run。

## 验证与未完成项

[测试](../../python/tests/test_coevolve_retail.py)使用真实工具与 native 评分、明确的模型替身，覆盖三种信号及消融、成功来源、完整历史重放、训练范围、独立探索重置、语义拒绝、收费回执恢复、用量与配额、制品篡改拒绝、混合池，以及正式 CLI/worker 搜索后用新 harness 再收集下一轮历史。`signal` 核心合同另有轻量测试；CPU CI 同时运行这些检查。

本次本地验证通过 59 项 curriculum 核心测试、69 项调用方回归和 6 项正式 worker 集成，共 134 项；其中 CoEvolve 调用方为 11 项检查加 1 项正式搜索集成。边界、lint、格式和文档本地链接检查通过。没有发起新的真实模型调用。安装上述依赖并构建 Gear 后，可以单独运行此配方的测试：

```sh
GEAR_SENTINEL_TAU2_PATH=/tmp/gear-sentinel-tau2 \
GEAR_TEST_SENTINEL_RUNTIME=1 PYTHONPATH=python \
  /tmp/gear-sentinel-env/bin/python -m unittest discover \
  -s python/tests -p 'test_coevolve*.py' -v
```

这些检查验证执行路径和边界，不证明真实模型生成质量或 harness 收益。该配方尚无完成的真实 LLM fixed/random/signal 对照、多轮回归曲线或单位成本收益。它也没有实现 GRPO、权重更新、AppWorld/BFCL 评测或完整论文算法导出；GPU 路线继续留在后续范围。
