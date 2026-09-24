# TypeScript recipe + one Python policy hook (experimental)

The recipe is implemented once in `recipe.mjs` with the public `defineWorkflow` and `task` helpers from `rsi-gear/algorithm`. Its only configurable policy is `choose.py`, which declares the exact input/output schema and scope. Install the lightweight `gear-algorithm` wheel into the Python interpreter named in `gear.algorithm.json`, and install a Gear package exposing the experimental `./algorithm` export in this project's `node_modules`. The current checkout awaits that package wiring; an isolated candidate package was used to verify this example. Then run `node PATH_TO_GEAR/lib/algorithm/cli.js check gear.algorithm.json`, followed by the same command with `run` and `resume`.

`check` imports the Python module, validates schema/scope and freezes observed source/environment identity. A committed `policy.decide` result is reused on resume. If a process dies after starting a hook but before its result is sealed, the operation stays `unknown` for reconciliation; Gear does not silently invoke it again. These trusted local workers are not an OS sandbox.

When copying this checked-in example, assign a fresh globally unique `campaignId` and matching `stateDir` before its first run. `algorithm init` does that automatically.
