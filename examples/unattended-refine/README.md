# Supervise an admitted refinement run

[English](README.md) | [简体中文](README.zh-CN.md)

From a Gear source checkout, install the Gear Python package and CLI from the
same revision, then run this example with the existing project and run ID:

```sh
python examples/unattended-refine/supervisor.py \
  --project /absolute/project \
  --run-id run_existing \
  --output /absolute/new-private-supervision-directory
```

The example calls the public `Project.report()` and `Project.resume()` APIs for
the same admitted run. It retains the frozen configuration and Gear's own
submission reconciliation. It allows at most 12 attempts, waits 30 seconds
between recoverable errors, and stops if ordinary free space falls below 8 GiB.
Only the explicit `RECOVERABLE` error-code set permits another attempt. Unknown
or malformed failures stop with `needs_attention`; the Python SDK itself does
not retry. Completed and cancelled runs finish supervision.

The output directory must be new. `status.json` records progress, successful
resume reports are saved as JSON, and `execution-N.stderr.log` preserves exact
failed-call diagnostics, including warnings before the terminal CLI error.
`ProjectError.from_stderr()` accepts only the final nonempty line when it is a
complete, flat Gear error object with `code`, `message`, and known optional
fields. Codes remain nonempty strings with their original worker spelling.
Nested objects, log prefixes, duplicate keys, and trailing log lines
cannot grant recovery. `ProjectError.stderr` holds the original bytes separately
from the normal exception message; these private logs may contain sensitive
provider diagnostics.

This is a foreground example. Select a fresh output directory for a deliberate
new supervision session; restarting it does not extend Gear's frozen evaluation
repair policy or trial budget.
