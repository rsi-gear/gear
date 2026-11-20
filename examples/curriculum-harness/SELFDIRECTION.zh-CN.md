# Self-Direction-inspired 过程问答与 harness 重试

[selfdirection_retail.py](selfdirection_retail.py) 将已采集的基线失败转成经过语义审查的过程问答，或检索已有 lesson，再用这些材料执行一次原任务重试。**本版本不做 GPU 训练，不更新模型权重。** 改变的是单次重试的上下文；所有转换、模型调用、执行、持久化和恢复都留在这个具体调用方，`gear.curriculum` 继续只提供算子和输入输出。

参考 [Self-Direction 官方实现说明](https://self-direction.github.io/implementation.html)和[论文](https://arxiv.org/html/2610.31846v1)。官方提供的是精简片段与伪代码，尚未据此确认完整可运行仓库及代码许可。本实现独立编写。上游将合成问答用于专项 LoRA；这里把验证后的问答作为推理建议使用，不能据此声称实现了 LoRA、复现论文效果，或获得了等价的模型学习。

## 执行与材料边界

| 阶段 | 当前实现 |
| --- | --- |
| 基线来源 | 输入 1–16 个有序 `RetailCollector` 工作区。每个都是原始基线单独执行的 train 样本，必须具有相同 family、policy、model、effort、harness 和步数／调用上限。重放全部模型回执、真实工具、native 评分和参考／负例校准 |
| 触发 | 只有完成且评分失败的来源进入生成／复用。基线成功直接保留；未完成或未知来源不变成失败。当前 retail 映射仅使用 `wrong_answer`，没有将基础设施错误归成论文的任务异常类别 |
| 记录 | 保存完整失败来源及轨迹摘要；样本身份去重，重试不会变成新证据。每个新任务的第一份来源都必须来自原始基线，不能沿用上一个任务的 lesson harness |
| 检索 | CPU MiniLM 对公开任务指令做归一化向量编码，在同一基线策略、family、backend 的已注册 lesson 中按余弦相似度选一个；达到阈值才复用。平局按 lesson ID 稳定排序；阈值 1 显式限定相同指令 |
| 构造 | 未命中才组合 `PlanPractice(kind="example")` 与 `GeneratePractice`，同一模型生成最多 24 条过程问答。建议至少接纳 8 条；不足时不注册 lesson，也不补造样本 |
| 验证 | `ValidatePractice` 分别核对 semantic correctness、target fidelity、novelty；模型判断未知或缺失即不接纳。另行记录规范化 QA 的精确重复，语义审查比较所有当前候选与已有同范围问答 |
| 输出 | `SelectPractice` 筛选后，`BuildSupervision(ProceduralSupervision)` 输出 `synthetic_procedural`。rationale 留在生成侧录，不进入 lesson 问答；没有 native token/logprob、success proof 或训练作业 |
| 重试 | 将一个 lesson 的问答提供给 actor，从原始数据库和空对话步骤开始真实执行，仍用原任务 native DB verifier、访问检查和政策审查判定 |
| 回退 | lesson 重试明确失败，或没有合格 lesson 时，最多执行一次 clean-base 回退；仅追加简短的先前失败提示。未知调用停止等待 reconcile；未完成轨迹保留 null reward，不触发回退 |
| 归因 | lesson 成功记为该 lesson 解决；仅回退成功记为 `base`。未解决的失败保持 open。单题修复仍不等于未见任务提升，`effect_verified=false` |

生成和审查采用 **`feedback_only`、类别化反馈**。调用 `GeneratePractice.prepare` 之前就清除原 OutcomeRecord 中的 native 分数、审查理由及文件引用；它只收到公开指令、政策、工具和公开失败对话。轨迹超过 24 步时保留前 12、后 12 步，并明确记录原索引和省略数量。完整原轨迹仍保存在本地审计材料中。

隐藏 user goal、数据库快照、参考解及 verifier 定义只交给对应执行／评分角色。官网片段使用 `failure.gold`，论文附录 F.2 则排除 gold-answer tokens 等高带宽反馈；本入口选择后者的可见材料边界，没有混用两种协议。过程问答的“正确”仍是模型语义判断，不是独立执行证明；它不能替代原任务的 native 评分。

这是一条具体的原任务重试 harness 配方。它不调用 `Project.refine` 搜索永久 developer prompt，也没有将生成问答当成新的原生 retail 任务准入。需要比较长期或未见任务效果时，应在独立留出任务上另行运行基线与对照。

## CPU 检索

[selfdirection_lessons.py](selfdirection_lessons.py) 使用 [all-MiniLM-L6-v2 固定 revision](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/tree/1110a243fdf4706b3f48f1d95db1a4f5529b4d41) 的本地 safetensors：CPU float32、冻结参数、masked mean pooling 后归一化、384 维。编码仅用公开 task ticket，不使用私有用户指令。超过 256 tokens 明确拒绝，避免静默截断；这是本调用方的限制。

本地文件摘要、依赖版本、架构、编码方式和向量都进入身份／证据。模型加载只复制清单内文件，禁止 remote code，不自动下载模型。CPU 推理也没有 optimizer 或反向传播。离线重放读取原始 embedding 回执并重算检索与全部 native 轨迹；它不宣称重新执行了 embedding 模型。真实 CPU 编码另有可选集成检查。

## 配置与运行

先按 [SENTINEL 安装步骤](SENTINEL.zh-CN.md#安装与运行)准备固定 Tau2、Gear 和独立基线 collector。来源采集与使用应保持同一冻结源码；旧实现的来源不能改写身份强行导入。

CPU 编码额外需要 `torch`、`transformers`、`tokenizers`、`safetensors`，使用仓库 [CPU 依赖约束](../../python/constraints-test.txt)可保持本次检查的版本：PyTorch 2.14.0、Transformers 5.18.0、tokenizers 0.23.2、safetensors 0.8.0。可用 Hugging Face 的 `snapshot_download` 在运行前准备明确版本；运行入口本身不访问模型仓库：

```python
from huggingface_hub import snapshot_download

snapshot_download(
    "sentence-transformers/all-MiniLM-L6-v2",
    revision="1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
    local_dir="/tmp/gear-selfdirection-minilm",
    allow_patterns=[
        "config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json",
        "special_tokens_map.json", "vocab.txt", "sentence_bert_config.json",
        "1_Pooling/config.json", "modules.json",
    ],
)
```

配置示例：

```python
import json
from pathlib import Path

source = Path("/path/to/base-collector").resolve()
record = json.loads((source / "result.json").read_text())["observation"]["record"]
config = {
    "schema_version": 1,
    "partition": "train",
    "family": record["family"],
    "policy_id": record["policy_id"],
    "source_workspaces": [str(source)],
    "previous_workspace": None,
    "threshold": 0.7,
    "min_examples": 8,
    "max_examples": 24,
    "max_calls": 256,
}
Path("/tmp/gear-selfdirection-input.json").write_text(json.dumps(config))
```

```sh
PYTHONPATH=python /path/to/python examples/curriculum-harness/selfdirection_retail.py \
  --input /tmp/gear-selfdirection-input.json \
  --workspace /tmp/gear-selfdirection-run \
  --tau2-source /tmp/gear-sentinel-tau2 \
  --embedding-model /tmp/gear-selfdirection-minilm --preflight
```

预检离线重放来源、检查身份与设置，不打开 SDK。移除 `--preflight` 运行；使用相同目录和配置恢复。改成 `--replay` 则重放已完成运行，无需 `--embedding-model`，不会打开 SDK 或重新生成收费数据。

`source_workspaces` 的顺序就是处理顺序。后续任务可以复用此前已注册的 lesson；下一轮设置 `previous_workspace` 为已完成运行的绝对路径，可先完整离线验证旧运行再导入 registry。重复样本、循环引用、超过八层的历史链、跨策略／family／embedding 身份均拒绝。每个 registry 最多 16 个 lesson；已满且未命中时明确记录 `registry_full`，只走一次 base 回退，不隐式淘汰。导入材料的引用同时绑定原运行输入摘要，不能把旧运行的同名文件当成本轮文件。

`min_examples` 和 `max_examples` 为 1–24，且前者不大于后者；`max_calls` 为 1–8192，所有生成、审查、actor、客户模拟和政策检查共享这一预算。达到上限即停止并保留回执。它计逻辑模型 turns，不是 token、美元或网络重试的硬上限。

结果按 generate、validate、retry、fallback 分别报告调用数和已知 tokens；基线采集用量另计，历史导入成本按原运行链保留，不算作本轮重新发生的调用。未知 tokens 不补零，不提供美元或 CPU 时间估算。稳定调用键复用原完成回执；远程未知结果由既有 `TextCalls` reconcile，不能靠改键自动重提。

## 验证与效果范围

[测试](../../python/tests/test_selfdirection_retail.py)检查真实 Tau2 工具和 native DB 结果，LLM 与默认 embedding 是明确 fixture。检查范围包括生成／语义筛选、过程监督合同、命中与未命中、跨轮 registry、原始基线和重试状态、公开材料隔离、clean-base 归因、不完整与未知状态、预算、中断恢复、篡改检测及无 SDK CLI 重放。CPU CI 运行这些检查；本地执行不代表远端 CI 已运行。

```sh
GEAR_SENTINEL_TAU2_PATH=/tmp/gear-sentinel-tau2 PYTHONPATH=python \
  /path/to/python -m unittest discover -s python/tests \
  -p 'test_selfdirection*.py' -v
```

安装上述 CPU 依赖后，增加 `GEAR_SELFDIRECTION_MINILM=/tmp/gear-selfdirection-minilm` 可执行真实 MiniLM 检查，包括重复编码一致、不同目标相似度、参数无梯度且位于 CPU、超长输入拒绝。

本地已通过 15 项调用方／检索检查，并在独立依赖环境通过 1 项真实 CPU MiniLM 检查。默认 retail 环境未装 embedding 依赖，因此其可选 MiniLM 项跳过；该项已单独实际运行，未将跳过计为通过。

同轮通过既有 65 项 curriculum、22 项 Agent-R／正式搜索和 57 项 retail 回归，合计 160 项实际通过检查。Ruff、格式、依赖边界、48 个本地文档链接和 CI YAML 检查通过。本阶段没有新增真实 LLM 调用；检查中的模型响应仍为明确替身。

模型替身下的原题修复仅证明材料实际进入调用并通过执行检查。真实 LLM 修复率、未见任务收益、历史回归及单位成本收益仍待验收；本入口未执行 GPU 训练或论文的 LoRA 加载／训练流程。
