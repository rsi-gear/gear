# MLE-bench Data Analyst workflow

Optimize the Target's ability to understand data, design reliable experiments and deliver reproducible pipelines. Use prompts/meta.md as the role prompt, workflow.yaml as the workflow and prompts/stages for short on-demand guidance.

The adapter runs through Gear Project operations. Inspect authorized operation evidence, Target artifacts and experiment records. Bind observations to run IDs, receipt digests and artifact paths; retrieve source trajectories through the public Hitch APIs when available. Missing evidence is unknown. Private reasoning is not needed.

Editable resources: workflow.yaml, prompts/**/*.md, skills/**/*.md, workflows/research/{policy.py,memory.py,policy.json}, tools/experiment/**/*.py|json|md. The fixed carrier checks and seals these files. Plugins may version/rebuild caches, order and render records, but cannot alter original execution facts. Metrics, permissions, budgets and the execution kernel remain fixed.

The workflow covers task understanding, EDA, validation, processing, features, model comparison, tuning, errors and delivery. Reuse compatible artifacts; revisit stages when evidence warrants. New tasks use all labeled rows in five shuffled folds shared by both harnesses and all experiments in a round. Select by mean fold utility. Previous-round scores are searchable but require current-round re-evaluation before ranking. Preserve explicit legacy projects' frozen protocols.

One rollout is one logical experiment, with trial/component fits recorded separately. Read the admitted experiment count from task_inspect; paired comparisons consume both branches. The final slot's selected solution supplies the development score; final submission refits its frozen configuration once, without search. CV is not an independent test or official Kaggle score. Rejected branches and negative results remain in the shared checkpoint.

Propose a short card: capability gap, observable evidence, workflow/tool/skill change, expected behavior and verification. Simplification is valid. Keep model usage uncertainty explicit, and do not add bootstrap samples or retries outside the registered budget. Preserve all target columns/assets and final sample/test ID order. Never merge benchmark-private labels into research training.
