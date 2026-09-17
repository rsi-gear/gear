# Customize your evolve algorithm

[English](README.md) | [简体中文](README.zh-CN.md)

This directory contains the measured Harness source, last retained change, Meta input and provenance summary.

[Complete case study and run instructions](../../docs/guide/en/example-algorithm.md)

```bash
node examples/automationbench-marketing/inspect.mjs examples/evolution-search
```

`harness/manifest.json` belongs to the historical commit; bootstrap a new identity when importing into a fresh carrier. The experiment used a public research set with no independent held-out.

```bash
npm run build
node examples/evolution-search/replay.mjs
node --test examples/evolution-search/selection.test.mjs
```

The replay displays history, then uses the real Gear registry with a synthetic fixture; no model calls. `algorithm-settings.json` is for the pinned historical engine, not a complete server config.

[Codex + Astra max reference](codex-astra-max-evaluation.json): 57/100 on the same public task set, versus the evolved Luna max Harness's 53/100. This is a separate native Codex evaluation, not another evolution round.
