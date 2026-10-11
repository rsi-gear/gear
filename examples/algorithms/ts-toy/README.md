# TypeScript recipe + TypeScript hook (experimental)

This project uses built ESM exports (`recipe.mjs` and `choose.mjs`). The recipe imports the public `defineWorkflow` and `task` helpers from `rsi-gear/algorithm`. Install a Gear package with that experimental export in this project's `node_modules`, then run `check`, `run`, and `resume` with `node PATH_TO_GEAR/lib/algorithm/cli.js` and `gear.algorithm.json`. The current checkout's package manifest does not expose `./algorithm` until the package wiring stage; an isolated candidate package was used to verify this example. The hook is an ordinary `policy.decide` provider operation; the Campaign journal retains its completed choice.

When copying this checked-in example into a new project, assign it a fresh globally unique `campaignId` and matching `stateDir` before its first run. `algorithm init` does that automatically.
