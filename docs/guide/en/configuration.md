# Configuration reference

`gear init` creates project files. Named profiles contain execution settings;
credentials stay in the provider's supported authentication location.
Example `gear.yaml`:

```yaml
version: 1
benchmark: ./benchmark.yaml
target: {adapter: dsh, path: ./target, profile: default-target}
meta: {profile: default-meta}
algorithm: gepa
objective: {metric: pass_rate}
validation: {mode: holdout}
budget: {rounds: 1, max_evaluations: 40}
```

Paths are relative to the project root. Defaults < project configuration <
explicit CLI/SDK parameters. `gear config explain` shows resolved values and
budget and repair configuration origins. Unknown fields fail. Resume uses the sealed configuration;
editing a file cannot silently change a running experiment.

| Field | Current meaning |
| --- | --- |
| `target.adapter` | `dsh` or `pi` |
| `algorithm` | `gepa`, `random-search`, a Python entrypoint, or `{name: gepa, options: {promotion_widths: [2, 1], global_gate: no_regression}}`; the SDK also accepts configured policy instances |
| `objective.metric` | `{metric: pass_rate}` is the default shorthand; advanced objectives use `objective.terms` and `objective.constraints` |
| `validation.mode` | `holdout` requires independent tasks; explicit `research` labels shared-set research |
| `budget.rounds` | Defaults to 1 |
| `budget.max_candidates` | Candidate limit for the entire run, default 2 |
| `budget.repetitions` | Repetitions per task, default 1 |
| `budget.max_evaluations` | Physical attempt limit for the entire run, default 40, including baseline, candidates, final validation and failure repair |

GEPA's default `promotion_widths: [2, 1]` limits bridge and global candidates
within each parent batch. It does not set the generation budget or the number
of parent batches. The [4 → 2 → 1 example](example-algorithm.md)
sets `max_candidates: 4` explicitly; the project default remains 2. Algorithm
options are frozen at admission and preserved on resume.

Submissions with unknown outcomes keep their reservations. Resume keeps the
same ledger. The project API currently has no hard dollar limit; missing
usage is not zero. A report totals a field only when every potentially executed operation supplies it; any missing/null measurement or submission without a receipt keeps the total null. Unsubmitted reservations do not count as consumption. When the runtime reuses complete evidence in the current run without calling a provider, it explicitly records zero new usage. Price estimates remain separate from billed dollars. The decision-step limit applies to the entire run and does not reset on resume.

## Run plans and baseline reuse

`gear refine --dry-run --json`, `run.plan` and Python `plan_refine()` use the same
application service to check tasks, Target resources and provider capabilities.
The plan shows repetitions, candidate limits, physical attempts, generation limits
and required final-gate slots. It creates no run, executes no algorithm and makes
no model calls; model access remains `not_checked`. Timeouts come from provider/task
configuration; there is no additional run deadline or dollar hard limit. Ordinary
refine displays its admitted plan on stderr before execution. `--json` returns one
JSON response, with the frozen plan in the report's `plan` field.

`limits.timeouts` lists Target/Meta provider-call, Hitch evaluation and Codex
generation deadlines in milliseconds. Harbor task declarations are grouped by
seed/held-out count in seconds, without held-out IDs. Templates declare 600 seconds
for the agent, 60 for the verifier and 600 for each environment build; an LLM
verifier uses its request timeout plus 15 seconds. Native tasks retain their exact
task.toml values. Null means a runtime default, not unlimited. `taskRuntime: harbor`
identifies Harbor execution; arbitrary process providers use `provider-defined`,
so template declarations alone do not prove enforcement. A provider-call timeout
ends waiting and does not prove remote termination; reservations remain held.

A new refine may reuse seed observations from one completed run with the same
initial Target. Verification covers Target content and execution identity, the
full benchmark, seed, scoring implementation and raw metric/assertion contracts.
Changing Meta or only objective weights does not change raw Target observation
identity. Only valid slots within current task/repetition scope and with required
channels available qualify. Sources are selected by coverage, then recency, never
score. Invalid, incomplete, damaged or missing-channel observations are excluded;
this selection does not request additional projections from old runs.

A one-task smoke test is only partial baseline coverage. Reused slots retain source
proof and historical usage without consuming the new budget. Only missing slots
execute, and valid zeros are not retried for being low. Plans distinguish baseline
and final-gate shortfalls. Gate affordability is calculated after baseline only;
candidates and repairs also consume the same total allowance. Admission rechecks
inputs and freezes its choice; resume never selects a different history source.

## Generation and diagnosis budgets

`generation` limits Meta work within one run: `diagnose_seed`, `generate_candidate`, and every nested call, retry or context summary within those operations. It excludes Target rollouts and benchmark LLM scorers. Physical evaluations remain governed by `budget.max_evaluations`; task timeouts belong to benchmark/Target execution settings.

```yaml
generation:
  max_model_requests: 20
  max_tokens: 120000
  per_operation:
    max_model_requests: 4
    max_tokens: 24000
```

Each total and per-operation ceiling is optional and must be a positive safe integer when supplied. An omitted total is unlimited for that dimension. An omitted per-operation ceiling reserves the remaining total; a configured ceiling is clipped to the remaining amount. The entire operation batch must fit before any submission. `config explain` shows the source of these settings.

The Meta provider must declare `generationBudget: true` and enforce the operation allowance before each real model call, including internal retries and summaries. The bundled Codex CLI runner currently cannot provide that guarantee; configuring these limits produces `generation-budget-unsupported` before baseline submission. After-the-fact token observations are not enforcement. A process provider implementing this contract can use the limits.

The runtime persists `generationLimits` with the operation ID before side effects. Only valid, known actual usage releases unused allowance. Missing/null metering retains the full reservation; lost replies require inspecting the same operation. `tokens` means all input plus output tokens across the operation, counting cached input once and not adding reasoning tokens again when already included in output. Supplied breakdowns must agree with the total, and positive tokens cannot accompany zero model requests.

The report's `generation_budget` separates frozen limits, reserved/accounted upper bounds, unknown operations and remaining allowance. An upper bound is not measured consumption. A provider overrun or inconsistent counter is retained as a violation receipt in the journal, fences further submissions and cannot become algorithm evidence. Cancellation and resume preserve that record.

## Failed evaluation repair

The runtime retries only explicit `environment_failed` or `scoring_failed` slots. By default it allows two additional attempts after the original execution, waiting 15 and 60 seconds. Only failed task/repetition slots are submitted; the scoring denominator stays fixed. Advanced configuration:

```yaml
evaluation:
  repair:
    max_retries: 2
    max_projections: 2
    backoff_ms: [15000, 60000]
```

Set `max_retries: 0` to disable execution retries, or `max_projections: 0` to disable metric projection. Each count must be a nonnegative safe integer. The backoff list must be nonempty and contain integer delays from 0 to 2147483647 ms; additional attempts reuse the last delay. Policy and due times are sealed, so resume never resets them. Reservations and original receipts share the run ledger. Unknown submissions are inspected first, and every physical execution counts against `budget.max_evaluations`. An unaffordable batch of failed slots is not partially submitted.

Valid zeros are never rerun. If a valid execution lacks a metric required by the objective, constraints or task protection, a capable evaluation provider may read the original artifacts again. This projection has a separate limit of two attempts by default; it issues no target executions or model requests and adds no physical attempts. Only requested unavailable metrics can change. Outcomes, existing available metrics, contracts and original receipts stay fixed. Hitch accepts only additional artifact fields without rewriting any original fields. Unsupported or exhausted projections leave the metric unavailable, with a reason under `evidence_projections.blocked`; they never substitute zero or shrink the scoring denominator. Independent model-based process observations remain separate work. The same read-only projection supports missing protected assertions; existing passed, failed and excluded results cannot be rewritten.

## Weighted objectives and protected tasks

Declare raw measurement contracts in `metrics` and scoring weights in `objective.terms`. Both are sealed independently: changing weights never rewrites observations. Parent frontiers, ranking, the final gate and reports use the same Python projection.

```yaml
metrics:
  - id: process_quality
    revision: '1'
    unit: points
    direction: maximize
    source: {path: originalResult.process_quality, extractor: number-v1}
    range: {min: 0, max: 100}
    granularity: trial
    repetitionReducer: mean
    taskReducer: weighted-mean
    comparisonPrecision: 0.000000001
objective:
  terms:
    - {metric: pass_rate, weight: 0.5}
    - {metric: process_quality, weight: 0.5, scale: 100}
  constraints:
    - {metric: pass_rate, rule: no_regression, reference: initial_baseline}
protection:
  - {task_id: seed-critical, partition: seed, metric: pass_rate, rule: no_new_violation}
```

The provider must actually supply `process_quality`. `originalResult.*` reads the original trial manifest. For independent Hitch verifier process observations, use `source: {path: verifier.process.score, extractor: number-v1}`; component ratios normally use `unit: ratio`, `range: {min: 0, max: 1}` and `scale: 1`. The `verifier.*` namespace is supplied only after source validation. Missing, unsupported and invalid sources retain those statuses, without zero filling or an implicit model judge. Stock `pass_rate` counts only scorer values exactly equal to 1. Custom process providers receive sealed `metrics` in evaluation requests and return `raw_metrics` with matching contracts and source evidence digests for every available value.

Every process provider must declare the boolean capability `evidenceProjection`. When true, it must handle `project_evidence` separately from `submit`, and persist receipts for `inspect`. The request binds the original operation/request/provenance, immediate source receipt, missing channels and attempt number. Its `evidence` contains only the source slots to complete; this request goes to the evaluation provider. Return an ordinary receipt with unchanged outcomes and existing channels, `physicalAttempts: 0`, explicit `usage.model_requests: 0`, and zero for every other reported usage field. Unknown usage is insufficient for this read-only contract. Codex Meta declares this capability false.

Terms allow negative penalty weights and require positive scales. Constraints support `minimum` and `no_regression` against `initial_baseline`, with optional nonnegative tolerance. Thresholds follow each metric's maximize/minimize direction. Task protection additionally supports `no_new_violation` for positive boolean/equality predicates: a task passed by the baseline must remain passed. Protected tasks must belong to their declared partition. Held-out protection is checked only by the final gate; its task IDs are absent from algorithm and Meta inputs.

Promotion requires all requested slots, selected metrics and protection evidence. A valid zero remains valid. Usage metrics require a `measurement` contract specifying measurement kind, provider/model, accounting and retry boundaries, and a price snapshot where relevant. Unknown cost cannot be optimized as zero. Reports include raw aggregates, weighted contributions and rule outcomes.

## Provider profiles

The default directory is `~/.config/gear/profiles/`; `GEAR_PROFILE_ROOT` can
override it. A `default-meta` reference reads `default-meta.json`. An external
process profile has these fields; replace the placeholders with a real implementation:

```json
{
  "command": ["/absolute/path/to/provider"],
  "workingDirectory": "/absolute/path/to/provider-workspace",
  "passEnv": ["PROVIDER_API_KEY"],
  "configuration": {},
  "timeoutMs": 300000
}
```

The process must report its actual implementation identity and capabilities,
and durably implement submit/inspect/cancel. Naming an executable alone is not
a working provider. `passEnv` lists variable names; values do not enter project locks.

A Target may instead use a `kind: "hitch"` profile with `executable`, `root`,
`harnessRef`, `model`, `baseImage`, `passEnv`, `timeoutMs`, and optional `maxConcurrent`, `setupTimeoutMs`, `preparationTimeoutMs`. New Target profiles default to DSH `0.1.5-rc.3` or Pi `0.84.1`; existing profiles retain their exact revision. The current DSH release pins its HMR dependency upstream, without a Gear-only override. DSH requires an
exact `deepseek@version:...` or commit; Pi uses `pi@version:...` or commit.
Custom runtime repositories may use `deepseek@git+file:///absolute/repository#<full-commit>` or the corresponding `pi@` reference. Git selectors require a full lowercase 40-character SHA-1 commit ID; branches, short hashes and 64-character SHA-256 IDs are rejected when validating the profile. Hitch's current Git cache and artifact builder support SHA-1 repositories only. The file URL must be canonical (percent-encode spaces). Hitch exports and builds the pinned tree, including its locked dependencies. This supports custom provider plugins without changing Gear or relying on a mutable installed runtime.

Hitch profiles may also set `agentArgs`, a JSON array of native argument strings.
Gear appends these after the Target adapter's own arguments; it keeps the DSH
Target patch and then applies additional overlays in their supplied order.
For example, add `--agent-args-json '["--patch","/opt/provider.json"]'` to profile
creation, or include `"agentArgs": ["--patch", "/opt/provider.json"]` in an imported
profile. The referenced file must already exist inside the task image. Argument
order enters the frozen provider identity and result checks, so changes require
a new run. Arguments are public execution configuration: keep secret values in
environment variables named by `passEnv`, never in `agentArgs` or image files.

The image must use an OCI sha256 digest. Gear checks the resolved harness source
identity, capabilities and daemon status before execution. Fresh worker observation v2
binds the observed Hitch controller, Harbor executable and Docker engine. Evaluations
explicitly select `local-docker`; Gear checks for drift before new submissions and
before saving receipts, and checks the result plan controller/runtime provider. Result admission and
artifact projection also verify the executed model, native arguments, environment
variable names, attempts, concurrency, retries and timeout against the frozen request.
Mismatches are rejected. Prepared artifacts in the logical plan, result and work
items must agree on identities, entrypoint/tree digests, task membership and
platform/Node contracts. Repetitions cannot use different dependencies on the
same platform; artifact projection retains the original evidence.

When Hitch supplies optional probe diagnostics, Gear validates their bounded stage, outcome, elapsed time, exit code and signal fields. Unavailable Harbor or Docker observations produce `provider-environment-unavailable` with this safe metadata in the persisted error message, including during SDK preparation checks. Raw tool output is excluded. Diagnostics do not enter environment identity, and Gear still rejects changed controller or engine identities. Older observations without diagnostics remain supported.

When connecting the provider for a run plan, Gear uses that Hitch installation's public SDK to compile task platform declarations and prepare the corresponding Harbor artifacts. Preparation checks the SDK controller and Docker/Harbor environment against daemon observations before and after the work. Artifact and entrypoint/tree digests, with per-task platform bindings, enter the provider/evaluation identity used for baseline comparison. New physical submissions verify the cached files; receipts must match the frozen bindings. Initial preparation may download packages and run Docker builders. Preparation/verification uses the profile’s `preparationTimeoutMs` budget (30 minutes by default) and creates no evaluation jobs or model requests. `doctor` stays read-only and does not build artifacts.

Platform planning materializes task configuration, Compose declarations and Dockerfiles, without expanding native source trees or verifier payloads. Physical evaluations still receive complete independent files. During each compilation, a bounded 32 MiB cache avoids repeated decoding and hashing of identical frozen native blobs. Linux filesystems that support reflinks also avoid rewriting shared data blocks; other filesystems fall back to independent copies. Hardlinks are not used. This reduces preparation work without sharing writable task state; ordinary filesystems still incur full writes for execution datasets.

For explicitly declared image-only inputs, the optional `python -m gear.benchmark.shared_runtime` producer can move common build prefixes into pinned OCI images before import. The resulting native dataset contains task-specific inputs and retains private writable container layers. Existing frozen datasets and the host Harbor executor are unchanged. See [shared task runtime preparation (Chinese)](../../shared-task-runtime.zh-CN.md) for declarations, build/bind steps, supported syntax and validation.

Hitch must advertise `evaluation_environment_binding: "3"` and `evaluation_preparation: "1"`; the existing 0.2.16 release alone does not provide this guarantee. Gear calls the resident daemon’s `eval bind` and includes the private HMAC binding of its environment, model, variable names, frozen helper output, Harbor Python contents and supported environment file references in the execution identity. Hitch validates it at admission and before Harbor starts; receipts must carry the same binding. Dependency file changes invalidate the binding even when package versions are unchanged; normal generated bytecode caches preserve identity. Standard certificate and credential configuration files are checked automatically. Declare custom host file variables in the daemon environment using `HITCH_EVALUATION_FILE_ENV_JSON='["MY_PROVIDER_CONFIG"]'`, with absolute file paths. Credentials stay outside Gear locks and public receipts. Expired or changed bindings require a new run. See the [companion implementation and file coverage](../../testing/hitch-environment-files.zh-CN.md).

New Hitch profiles explicitly default to `maxConcurrent: 4`, matching Hitch. Existing profiles without the field retain concurrency 1. Set `--max-concurrent N` when creating a profile to request higher task concurrency; the daemon’s actual resource capacity still controls admission. Executed concurrency is checked against the frozen profile before evidence is accepted. Concurrency is part of the frozen provider identity, so changing it requires a new run and does not permit reuse of evidence under the old identity.

`--preparation-timeout-ms` controls artifact preparation/verification, environment binding, and submission admission (which also verifies the Python runtime). `--setup-timeout-ms` sets Harbor's Agent setup override (`agent.override_setup_timeout_sec`) and defaults to 1,800,000 ms. Harbor's task environment build/start deadline is separate: it comes from `task.config.environment.build_timeout_sec` in the compiled task and otherwise uses Harbor's default. Increasing Agent setup does not extend environment startup. Gear preserves declared task limits and leaves unspecified native defaults unknown in its frozen task contract. The task `timeoutMs` plus Agent `setupTimeoutMs` must fit Hitch’s 24-hour bound; use explicit zero Agent setup allowance for a full-day task. These settings are positive integer milliseconds except setup, which may be zero. Preparation deadlines must fit a Node timer. Waiting for a whole evaluation group allows every task its setup and execution budget even when available daemon capacity is lower than requested concurrency. Cancellation and ambiguous-submission recovery retain the original evaluation identity.

Gear also requires `evaluation_artifact_pins: "1"`. Each submission carries the artifact ID, tree digest and entrypoint digest for its task platforms. Hitch checks these after preparation and before Harbor execution; recovery and retries retain the original pins. Receipts must still match. See the [protocol and validation scope](../../testing/hitch-artifact-pins.zh-CN.md).

This does not pin arbitrary environment-referenced files, resources dynamically loaded outside the inventoried paths, every system shared library, or concurrent host changes during execution. Keep dependencies unchanged while a run executes. See the [acceptance audit](../../refactor-acceptance.zh-CN.md).

Create native profiles with `gear profile create NAME --kind hitch|codex --model MODEL`; Hitch also requires `--adapter dsh|pi`.
Omit creation flags for the terminal wizard. Harness versions and local image digests are pinned automatically; choose your own model explicitly.
Import a custom process configuration with `gear profile create NAME --from FILE.json`. Existing names cannot be overwritten.
`gear profile list` lists profiles. `gear profile use NAME --role target|meta` updates the current project;
add `--default` to select defaults for future `init` calls. `init` accepts `--target-profile` and `--meta-profile` overrides.
Selection checks role and Target adapter; existing runs retain their frozen settings.

Authenticate Meta and Target separately. A native `kind: "codex"` profile resolves the
[packaged operation runner](../../codex-meta-runner.zh-CN.md) from the current installation.
For hosts that require an upstream HTTP proxy, explicitly add `HTTP_PROXY`, `HTTPS_PROXY`, and optionally `NO_PROXY` to the Codex profile's `passEnv` (CLI: `--pass-env HTTP_PROXY,HTTPS_PROXY,NO_PROXY`). Only names are persisted. The trusted worker chains its filtered network proxy through these values; Codex receives the sandbox proxy endpoints, not upstream proxy credentials. `allowedDomains` still restricts destinations, including when `NO_PROXY` bypasses the upstream proxy. Proxy variables are not inherited by default. For API-key authentication, include the required key variable in the same list.
Codex persists a validated execution `receipt.json` before resource cleanup, so a receipt may be visible while the operation lock is still held. Private `cleanup-started.json` and `cleanup.json` record cleanup separately; `fallback-required` means a step failed or exceeded its deadline, not that the timed-out step completed. Credential removal, trajectory disposal, sandbox reset and root removal have independent deadlines (500/500/1500/1000 ms), with 250 ms per status write and a 4500 ms worker exit watchdog after cleanup begins. Only the dedicated operation worker may terminate its verified own process group, reclaiming its CONNECT sockets and proxy bridge children; direct library calls never terminate their host group.

A guard-only acknowledgment certifies model group termination before any receipt. A killed guard or missing acknowledgment leaves the operation `unknown` without replay. Unknown model state retains the private temporary root, whose credentials/root stages are `unconfirmed`; it may still contain temporary authentication files and needs investigation with the original journal. Cancellation still requires both a durable receipt and a released execution lock within its existing 5-second confirmation wait; a deadline alone does not confirm stopping. The runner asset, guard and cleanup code are part of the frozen implementation identity, so this update does not silently resume an older frozen run with new code.

Doctor checks local login files or environment variable presence; it makes no model calls and does not verify remote authorization.
Custom processes report `provider_managed` authentication. Python `Project` exposes `profiles()`, `create_profile()`, `use_profile()` and `doctor()`, with async equivalents.
Managed environments live under `GEAR_HOME` (default `~/.local/share/gear`); `GEAR_PYTHON` explicitly overrides worker selection.

## Independent assertions

Task scores and independent verifier assertions remain separate. The provider must actually supply the declared source field. An absent observation stays missing; Gear does not infer it from the task score.

```yaml
assertions:
  - id: tool_sequence
    revision: '1'
    source:
      path: originalResult.assertions.tool_sequence
      extractor: assertion-status-v1
assertion_protection:
  - task_id: sum-01
    partition: seed
    assertion_id: tool_sequence
    rule: must_pass
```

`assertion-status-v1` reads `passed`, `failed` or `excluded`. `boolean-v1` reads actual booleans, never numeric 0/1. Configuration resolution generates the contract digest; changing the revision or source changes its identity.

`must_pass` requires the candidate assertion to pass in every repetition; excluded does not satisfy it. `no_new_violation` prevents a baseline assertion that was not failed from becoming failed. It does not itself require fixing an already failed baseline assertion. Both rules require independent baseline and candidate observations. Missing, invalid and unsupported evidence leaves protection incomplete. Each task/assertion has one rule; held-out rules belong only to the final gate.

`scores.*.<partition>.assertions` reports every declared assertion by task and repetition, including assertions without protection. `assertion_protection` reports each protected slot's result. Read-only projection may complete unavailable assertions from original artifacts. Existing passed/failed/excluded observations remain immutable, and assertion failures never cause valid executions to be rerun.

## Preparation budgets and Linux isolation

Set `GEAR_BENCHMARK_LIMITS_JSON` in the Gear process to override known preparation budgets. Python import/compilation, TypeScript plan validation, and frozen dataset hashing use the same defaults: `maxFiles: 200000`, `maxDirectories: 100000`, `maxUniqueBytes: 67108864`, `maxMaterializedBytes: 4294967296`, `authorTimeoutMs: 300000`, and `maxOutputBytes: 134217728`. For example, `GEAR_BENCHMARK_LIMITS_JSON='{"maxFiles":300000,"authorTimeoutMs":600000}'` adjusts any supported dataset without a dataset-specific exception. Values must be positive safe integers and the timeout must fit a Node timer. Raising budgets does not disable content or path validation. A timeout/cancellation waits for the author child process to exit; on POSIX its process group is terminated too.

Linux isolation defaults to `seccomp`. On hosts whose AppArmor policy forbids the helper’s nested namespace, explicitly select `sandbox: {linux_isolation: bubblewrap-only}` in `gear.yaml`. This applies to the Python algorithm and native Codex Meta and is frozen with the run. The compatibility mode keeps filesystem, PID and network namespace isolation, but does not filter Unix socket creation with seccomp; private host control sockets must be outside the read allowlist. `gear doctor` probes the selected mode. There is no automatic fallback or disabled-isolation mode. See the [platform isolation checks](../../plugin-installation-and-usage.md).
