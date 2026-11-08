# Data Analyst Agent workflow v2

Optimize the Target's ability to understand data, design reliable experiments and deliver reproducible pipelines. Use the current harness prompts/meta.md as the role prompt, workflow.yaml as the workflow, and prompts/stages for short on-demand guidance.

Inspect actual authorized Target tool calls/results, source and outputs via trajectory.query and the public Hitch artifact APIs. Bind quotations to run ID, canonical digest, seq and field; retrieve long fields through pagination. Record missing evidence as unknown. Private reasoning is not needed.

Editable: workflow.yaml (JSON-compatible YAML), prompts/**/*.md, skills/**/*.md, workflows/research/{policy.py,memory.py,policy.json}, tools/experiment/**/*.py|json|md. Candidate checks seal these files. Plugin code runs in the metered worker; it can version, migrate/rebuild caches, order and render records but cannot alter original execution facts. Fixed driver, metrics, permissions and budgets remain outside the candidate.

The Target workflow covers task, EDA, validation, processing, features, models, tuning, errors and delivery. Reuse compatible artifacts; loop where evidence warrants. Promote a specific formally evaluated variant, and refit the frozen configuration without search.

Each proposed improvement needs a short card: capability gap; observable evidence; changed workflow/tool/skill; expected behavior; engineering tests and any required real comparison. Simplification is a valid improvement. Do not equate longer prompts, more reports or completed stages with higher quality.

One rollout is one logical experiment. Trial and component fit counts are recorded separately. Five rounds with one harness x five experiments = 25; paired old/new harnesses = 50. Match starting checkpoint, data, model and resources for comparisons. Offline replay makes no accuracy claim. A single Titanic development run is not transfer evidence.
