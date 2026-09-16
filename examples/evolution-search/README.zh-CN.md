# Evolution algorithm extension

[English](README.md) | [简体中文](README.zh-CN.md)

此目录包含真实实验的 Harness 源码、最后保留修改、Meta 输入和来源摘要。

[完整案例与运行步骤](../../docs/guide/zh-CN/example-algorithm.md)

```bash
node examples/automationbench-marketing/inspect.mjs examples/evolution-search
```

`harness/manifest.json` 属于历史提交；导入新 carrier 时必须生成新身份。实验使用公开研究集，没有独立 held-out。

```bash
npm run build
node examples/evolution-search/replay.mjs
node --test examples/evolution-search/selection.test.mjs
```

replay 展示历史数据，然后使用真实 Gear registry 运行合成 fixture；不调用模型。`algorithm-settings.json` 是固定历史引擎的算法配置，不是完整 server 配置。

[Codex + Astra max 对照](codex-astra-max-evaluation.json)：同一公开题集 57/100，进化后的 Luna max Harness 为 53/100。该结果来自单独的原生 Codex 评测，不是新增进化轮次。
