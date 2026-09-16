# Evolve a harness for Marketing

[English](README.md) | [简体中文](README.zh-CN.md)

This directory contains the measured Harness source, last retained change, Meta input and provenance summary.

[Complete case study and run instructions](../../docs/guide/en/example-harness.md)

```bash
node examples/automationbench-marketing/inspect.mjs
```

`harness/manifest.json` belongs to the historical commit; bootstrap a new identity when importing into a fresh carrier. The experiment used a public research set with no independent held-out.

To execute this Harness in a new carrier, from a built Gear checkout:

```bash
export GEAR_LAB_ROOT="$PWD/.evolve-lab/marketing-guide"
export GEAR_INITIAL_HARNESS="$PWD/examples/automationbench-marketing/harness"
node examples/dsh-codex-luna/bootstrap-target.mjs
```

Use a fresh lab path, then follow the [integration lab](../dsh-codex-luna/README.md) to install its runtime and configure authentication and task sets. Bootstrap generates fresh commit/manifest identities; it does not preserve the historical carrier identity.
