# Fake Python SFT/DPO provider

`provider.py` uses only the public `gear_algorithm` package. It computes a small JSON checkpoint artifact; it does not train a model, enforce GPU/token budgets, or claim paper reproduction. The Gear host supplies `GEAR_ALGORITHM_PROVIDER_RECORD_DIR` and an authorized artifact bridge. The provider retains a durable result per idempotency key; after a lost submit reply, `inspect` returns that result without recomputing it.

External services and long-running workers need their own provider `submit/inspect/cancel/collect` implementation and truthful usage receipts. `DurableLocalProvider` is only for synchronous, deterministic local calculations.
