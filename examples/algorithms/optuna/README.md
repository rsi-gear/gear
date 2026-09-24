# Optuna ask/tell through Gear operations

This CPU example runs two Optuna 4.9 trials. Each `ask`, objective evaluation,
and `tell` is a separate durable Gear operation. The algorithm state contains
only JSON and an artifact reference to the checkpoint. The trusted Optuna
provider owns the authenticated pickle codec; pickle never crosses the worker
wire. The CPU evaluation provider reports one `evaluation.calls` usage receipt
per trial; `operationLimits` reserves one call for each evaluation and the
Campaign budget admits two. This is a workflow/recovery example, not model
training.

Install the standalone `gear-algorithm` wheel and `optuna==4.9.0` into a
Python 3.11+ environment. From this directory:

```sh
python make_config.py
node PATH_TO_GEAR/lib/algorithm/cli.js check gear.algorithm.json
node PATH_TO_GEAR/lib/algorithm/cli.js run gear.algorithm.json
node PATH_TO_GEAR/lib/algorithm/cli.js resume gear.algorithm.json
```

The same generated config and `checkpoint.key` must be kept for resume. The
key is a local trusted-provider checkpoint integrity key, not a sandbox or a
credential for an external service. The example uses a small study because
the current artifact bridge caps a checkpoint below 2 MiB.
