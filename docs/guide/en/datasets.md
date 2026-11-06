# Tasks and scoring

`gear init` creates editable `tasks.csv` and `benchmark.yaml` files. CSV's base
columns are `id,instruction,expected,family,split`; JSONL is also supported.
Each task explicitly selects `seed` or `held_out`. A family or identical task
content cannot span both partitions.

```csv
id,instruction,expected,family,split
sum-01,Output only the result of 2 plus 3.,5,arithmetic,seed
word-01,Output the uppercase form of apple.,APPLE,case-conversion,held_out
```

This demonstration checks the workflow. Real performance evaluation needs
adequate task coverage and a documented split rationale.

| Template | `expected` | Rule |
| --- | --- | --- |
| `text` | String | Equality with explicit trim, casefold or collapse_whitespace |
| `json` | JSON Pointer/value map, such as `{"/count":2}` | Field values and JSON types match; booleans are distinct from numbers |
| `files` | JSON mapping of file paths to contents | Check content at the declared relative paths |

Use project-relative paths in `attachments`; separate CSV attachments with
semicolons. Compilation freezes attachment bytes and task identities and rejects
links or path escapes. Expected answers remain verifier resources, excluded
from Target instructions and Meta seed projections.

```sh
gear benchmark check
gear benchmark preview sum-01
gear evaluate --split seed --limit 1
```

`check` makes no model calls and checks data, splits, rules and deterministic
positive/negative fixtures. `preview` exposes author-only expected values and
must not become Meta input. A one-task evaluation exercises actual Target execution and scoring.

## Environment and scorer probes

```sh
gear benchmark probe --task sum-01
gear benchmark probe --task sum-01 --scorer
```

A probe builds and starts the seed task's Docker environment; building may download images or Dockerfile dependencies. It uses the selected Hitch Target profile's pinned base image, or resolves a local tag supplied with `--image IMAGE`. Deterministic and Python probes do not connect to a model or start a Hitch evaluation; explicit LLM `--scorer` probes contact the declared judge. The first seed task is the default; held-out tasks are rejected.

`--scorer` also places the frozen positive/negative outputs in containers and runs the actual verifier. Fixtures have separate output/log directories. The probe checks exit status and agreement between the structured score and reward; valid zero remains valid and missing/corrupt evidence is a scoring failure. Deterministic and Python verification containers have no network or model credentials; the LLM scope is described below. Without `--scorer`, only environment checks run.

Reports in `.gear/probes/` record benchmark, scorer, compiler and image identities, individual outcomes, model usage/cost and outstanding cleanup resources. Deterministic and Python probes have zero model requests/cost. A probe is not a baseline and never updates experiment budgets or promotion records. Cancellation attempts container cleanup; unconfirmed resources appear in `cleanup_required`. Python exposes `Project.probe_benchmark(...)` / `aprobe_benchmark(...)`; Skill uses `benchmark.probe`.

## Import and review partitions

```sh
gear benchmark import /path/to/tasks.jsonl --template text
# Review task IDs, grouping and validation_mode; use the returned plan_id:
gear benchmark import --apply import_REPLACE_WITH_RETURNED_DIGEST
gear benchmark check
```

CSV/JSONL may omit split annotations. The importer joins families and identical inputs into indivisible groups, preserves explicit annotations, and assigns about one fifth of the remaining groups to held_out in deterministic hash order. Fewer than two independent groups cannot support holdout; explicitly choose `--research` for shared-set research. Conflicting annotations are rejected.

Preview freezes source and attachment bytes in a private `.gear/imports/` proposal without changing the selected benchmark. Apply writes `benchmarks/import-<digest>/` with tasks, an explicit `splits.json`, resources and importer identity, then atomically switches `gear.yaml`. Original data remains. Changes to the original source after preview cannot alter the plan; changed project configuration or destination content cannot be overwritten. Checks never repartition data.

Attachments are relative to the source CSV/JSONL directory. Use `--resource-root DIRECTORY` for a shared source/resource root; both must be inside it. Each plan permits up to 16 MiB of source and resource bytes. JSONL diagnostics retain physical line numbers, including blank lines. Duplicate JSON fields and non-finite values fail before model calls.

Python provides `Project.import_benchmark(...)`, `apply_benchmark_import(plan_id)` and async equivalents; Skill uses `benchmark.import` and `benchmark.apply`.

## Native Harbor

```sh
gear benchmark import /path/to/harbor-tasks --template harbor
gear benchmark import --apply import_REPLACE_WITH_RETURNED_DIGEST
```

Import a single task or a dataset of single-step Linux Dockerfile/prebuilt-image tasks. Instructions, task configuration, environment, tests, solutions and empty directories are preserved. Directory structure participates in identity and retry checks, so Dockerfile COPY paths survive import. Family comes from metadata.family, metadata.domain, metadata.category or the task directory ID. Tests and solutions stay in the private verifier bundle, outside public tasks and Meta projections.

External FROM tags resolve through locally prepared Docker images. Missing images produce a setup action. A prebuilt image becomes a pinned Dockerfile base so the candidate carrier is still built into the environment. Single-step Linux Compose preserves main, sidecars, dependencies, health checks, explicit environment values and artifact service selection. Main may use its own build context; Gear appends the Target carrier to that context’s actual Dockerfile. Verifier and sidecar FROM references and image services are pinned too. Dynamic ARG images, multi-step/Windows tasks, host mounts, external Compose resources and host-variable interpolation require a self-contained export and are rejected. Current evaluation receipts require rewards in the 0–1 range.

Native payloads deduplicate bytes by digest: limits are 64 MiB of unique content, 4 GiB of materialized content, 100000 files and 100000 directories. Repeated runtime files are transported once. CSV/JSONL retains its 16 MiB limit.

Versioned producers may supply `benchmark.adapter.json`. Gear checks its exact task set, executable bits, file hashes and dataset digest, preserving scoring and raw_metrics contracts. Original `source-manifest.json` and `source-benchmark.adapter.json` remain available; the execution manifest is rebuilt after image normalization, task selection and Target materialization. Harbor v1 hashing uses its JavaScript JSON and sorting contract through a Node codec shipped in the Python package; this codec contains no search decisions. Resource-protocol v2 inputs need a native directory export from the corresponding producer/Hitch before import.

Native verifier scripts are not executed by static checks: `verifier_fixtures` and `environment` remain `not_run`. A probe builds and starts the native main and sidecars, waits for declared health checks, and cleans its Compose project after success, failure or cancellation. Native directories lack Gear-declared positive/negative fixtures, so `--scorer` still reports `not_run` with a reason. Use a seed evaluation to test actual execution and scoring. LLM rubrics use the separate declaration and paid probes below; native import or environment probe success does not verify model judging.

Deterministic and Python templates use a separate verifier container, transfer candidate `/app` artifacts, and set verifier networking to `no-network`. Native Harbor imports retain their original shared/separate verifier configuration.

## Custom Python scorers

Advanced mode freezes one UTF-8 Python source file returning `bool`: `True` passes and `False` is a valid zero. Numbers, null, exceptions and timeouts are scoring failures, not `pass_rate` values. Use only the standard library; sibling modules are not bundled automatically. This contract is offline and requires a declaration of zero model requests. Paid LLM rubrics use the separate contract in the next section.

```python
# scorers.py
def score(actual, expected, artifacts, *, seed):
    return actual.strip() == expected and artifacts.get("proof.txt") == "proof"
```

The entrypoint must name a top-level synchronous function with parameters `(actual, expected, artifacts, *, seed)`. `actual` contains `/app/answer.txt`; `expected` is private; `artifacts` contains only declared files that exist. The Python template preserves CSV expected strings, while JSONL may supply JSON values. Gear seeds the standard-library `random` module before importing the source and passes the seed to the function. Authors must still avoid clocks and other unfixed randomness.

```yaml
version: 1
source: tasks.jsonl
template: python
scorer:
  entrypoint: scorers.py:score
  version: "1"
  randomness: {seed: 7}
  cost: {model_requests: 0}
  artifacts: [proof.txt]
fixtures:
  sum-01:
    - actual: "5"
      artifacts: {proof.txt: proof}
      score: 1
    - actual: "wrong"
      artifacts: {proof.txt: proof}
      score: 0
```

Declare positive and negative fixtures for every task, including held-out tasks; this single-task fragment is not a complete independent validation dataset. Source paths are relative to the project root. Source, entrypoint, version, seed, cost declaration, artifact paths and fixtures all enter the frozen benchmark identity. Scorer source and expected values stay outside the Target environment.

`benchmark check` / `preview` parse the source and contract without importing Python or executing fixtures; `verifier_fixtures` remains `not_run`. Explicit `benchmark probe --scorer` executes the fixtures in Docker with no network/model credentials and with time/resource limits. The report records version, source digest, seed, cost declaration and individual results. Formal evaluation uses the same frozen implementation. Missing artifacts are absent from the map rather than substituted with empty files; the scorer decides whether that fails the task.

## LLM rubrics

`template: llm` explicitly uses a judge model to return pass/fail from the rubric, task, private expected value and candidate artifacts. Run `benchmark check` to see the model, rules, randomness and declared prices, then `benchmark preview TASK_ID` to review fixtures. Neither command reads credentials or calls a model. Formal evaluation and explicit `benchmark probe --scorer` may incur charges.

```yaml
version: 1
source: tasks.jsonl
template: llm
scorer:
  version: "rubric-1"
  protocol: chat-completions@1
  endpoint: https://api.openai.com/v1/chat/completions
  api_key_env: GEAR_SCORER_JUDGE_API_KEY
  model: YOUR_PINNED_MODEL_ID
  rubric: "Pass only when the output satisfies the task and agrees with the reference."
  randomness: {temperature: null, seed: null}
  cost:
    price_version: "replace-with-your-price-version"
    input_usd_per_million: 2
    cached_input_usd_per_million: 1
    output_usd_per_million: 4
  limits: {max_request_bytes: 65536, max_completion_tokens: 512, timeout_seconds: 30}
  artifacts: []
fixtures:
  sum-01:
    - {actual: "5", score: 1}
    - {actual: "wrong", score: 0}
```

Replace the model ID, prices and price version with actual settings; the prices above are protocol examples, not provider quotes. Every task needs positive/negative fixtures. Configuration, rubric, implementation version and fixtures enter the frozen identity. The model must support structured outputs, and its response model must exactly match the declaration; an alias resolving to another model is rejected. Null omits a sampling parameter. Explicit temperature/seed must be supported by the selected model, and a fixed seed does not guarantee determinism. See the [official Chat Completions protocol](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [structured outputs and refusals](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat).

Credentials use a dedicated `GEAR_SCORER_*_API_KEY` environment reference, never a value in the benchmark, candidate or lock file. Probes forward only that credential to the grader. For formal Hitch execution, configure it in the worker environment running the verifier, never in Target profile `passEnv`. LLM grading uses a separate networked verifier and a fixed HTTPS endpoint; redirects and inherited proxy settings are disabled. Python and deterministic scorers remain offline.

Each fixture/trial makes at most one request with bounded request bytes, completion tokens and execution time. A possibly charged failure is never automatically resent. HTTP errors, refusals, truncation, invalid structures and model identity changes are scoring failures, not valid zeros. A usage marker precedes the request; a lost response retains unknown calls/tokens/cost. Successful responses retain reported token counts. `estimated_model_cost_usd` uses declared rates; `model_cost_usd` does not pretend to be a confirmed bill, and no hard dollar cap is promised. Formal verifier usage markers remain in scorer stdout retained by Hitch. Overall Target usage reflects what the provider actually observes; missing values stay unknown.

For a test without model calls, set `GEAR_TEST_BENCHMARK_IMAGE` to a pinned Python image and run `npm run test:benchmark:llm`. A loopback HTTPS fixture service in real Docker covers pass, fail, refusal and lost response, writes a report and confirms cleanup. This does not verify real provider authentication or billing.
