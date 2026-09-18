# Marketing token usage and cost

[English](marketing-token-cost.md) | [简体中文](marketing-token-cost.zh-CN.md)

Comparison of GPT 5.6 Luna max and GPT 6 Astra max on AutomationBench’s 100 public Marketing tasks, using the same optimized DSH harness (`a0740800`).

| Average per task | GPT 5.6 Luna (max) | GPT 6 Astra (max) |
| --- | ---: | ---: |
| Uncached input tokens | 85,012.36 | 42,067.48 |
| Cached input tokens | 1,131,525.12 | 400,944.64 |
| Output tokens, including reasoning | 14,337.34 | 7,283.46 |
| **Total tokens** | **1,230,874.82** | **450,295.58** |
| **Estimated API cost (USD)** | **$0.0568** | **$1.1858** |

Averages cover 100 valid task runs per model, including recorded subagent usage. Costs use standard API prices as of September 18, 2026: [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) $0.20/$0.02/$1.20 and [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) $10/$1/$50 per million uncached input/cached input/output tokens. These are API-equivalent estimates for runs made through Codex subscriptions, not actual bills. They exclude harness optimization, historical invalid attempts, session-title generation, and infrastructure costs.

[Back to README](../README.md)
