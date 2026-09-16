# Configuration reference

Configure the first evolution explicitly. Gear seals experiment identity at admission and revalidates it when continuing.

## Required deployment choices

| Field | What to supply |
| --- | --- |
| `workspaceRoot`, `stateRoot` | Separate absolute workspace and durable state paths. |
| `dshRepository`, `targetRoot` | Target Git repository and editable tree, usually `harness`. |
| `dshBaseRef`, `initialChampion` | Bootstrap's exact substrate, champion commit and manifest digest. |
| `toolchainRef`, `sandboxProfileRef` | Stable identities for fixed build and isolation conditions. |
| `seedTaskRef`, `heldOutRef` | Versioned dataset references or local task directories. |
| `metaModel`, `metaSampling` | Meta provider/model and optional temperature/effort. |
| `metaAdapter` | Skill mode plus explicit external identity, or DSH-derived native identity. |
| `compiler` | Absolute executable, arguments, timeout and runtime validation contract. |
| `hitch` | CLI, root, Target model, attempts, task setup and concurrency. |

Use the complete [standalone template](../../harness-agnostic-refine-skill.md) or [DSH profile](../../../examples/dsh-codex-luna/profile.patch.yml). They are different configuration surfaces; do not paste a YAML plugin row into the JSON server configuration.

## Budgets have different scopes

| Setting | Scope |
| --- | --- |
| `taskBudgetMs` / `--budget` | One Target task attempt; default 3,600,000 ms. |
| `hitch.setupTimeoutMs` | Task environment setup. |
| `candidateGeneration.attemptTimeoutMs` | One Meta candidate attempt. |
| `candidateGeneration.maxAttemptsPerCandidate` | Generation attempts for a candidate. |
| `candidateGeneration.roundTimeoutMs` | Total candidate-generation deadline for the round. |
| `candidateGeneration.maxCandidates` | Candidate slots in a round. |
| `selection.survivors` | Number of research survivors selected from evaluated candidates. |

A deadline is not a monetary budget. Reconnection does not reset consumed time or requests. Keep model account limits and resource capacity in mind when choosing a small first run.

## Direct and daemon evaluations

```yaml
hitch:
  root: /absolute/hitch-state
  controlPlane:
    mode: direct
```

For a supported daemon deployment, start one daemon for that root and use `mode: daemon`. Hitch 0.2.6+ is required. A credential wrapper may support direct only; the bundled DSH OAuth example explicitly does. Never put secret values in a committed profile; `passEnv` lists variable names.

## Advanced paths

[Context offloading](../../dsh-meta-context-offloading-spec.zh-CN.md) applies to the native DSH Meta adapter and must be sealed before the evolution starts. [Algorithm settings](example-algorithm.md) belong to their specific search implementation. [Training configuration](training.md) is a separate controller contract. The [source schema](../../../src/config.ts) remains authoritative for this checkout.
