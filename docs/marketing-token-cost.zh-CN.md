# Marketing 任务的 token 消耗与费用

[English](marketing-token-cost.md) | [简体中文](marketing-token-cost.zh-CN.md)

在 AutomationBench 的 100 个公开 Marketing 任务上，比较 GPT 5.6 Luna max 和 GPT 6 Astra max 使用同一版优化后的 DSH harness（`a0740800`）时的消耗。

| 平均每题消耗 | GPT 5.6 Luna（max） | GPT 6 Astra（max） |
| --- | ---: | ---: |
| 非缓存输入 token | 85,012.36 | 42,067.48 |
| 缓存输入 token | 1,131,525.12 | 400,944.64 |
| 输出 token（含推理） | 14,337.34 | 7,283.46 |
| **总 token** | **1,230,874.82** | **450,295.58** |
| **API 等价费用（美元）** | **$0.0568** | **$1.1858** |

均值覆盖两边各 100 道有效任务，包含已记录的子任务调用。费用按 2026-09-18 的标准 API 单价折算：每百万非缓存输入／缓存输入／输出 token，[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) 为 $0.20／$0.02／$1.20，[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) 为 $10／$1／$50。实际运行使用 Codex 订阅通道，因此这里是 API 等价估算，并非实际账单；不含 harness 优化、历史无效尝试、会话标题生成及基础设施费用。

[返回 README](../README.zh-CN.md)
