# Data-analysis harness development

The candidate is a general research method. The Target writes its own Python
solution during execution. Edit only the declared prompts, skills, research
policy and memory code; never install a task-specific solution in the harness.

One rollout is one experiment. One Gear cell contains five sequential rollouts,
one repetition, and an additional fixed, zero-model execution of C5. Five-fold
CV happens inside each experiment. Failure, debugging, confirmation and reuse
each consume their registered slot. Do not add independent repeated sequences.

Compare candidates only at the same starting checkpoint and incremental budget.
Read the ordered experiment facts, failed attempts, hypotheses, selection policy
trace and actual C1–C5 choices. Propose one measurable general mechanism. Explain
which next action or choice should change and under which conditions it should
not change. Check new instructions are actually loaded, rather than merely added.

The main score is the actual final C5 delivery. The pooled OOF metric is internal
feedback, not external generalization. A higher audited V or curve cannot rescue
a failed C5, choose a different submission or justify retroactive selections.
Audit metrics and their missing coverage are diagnostic. External scores,
promotion decisions and post-score explanations must not enter Target memory.

For single-task development, reuse-seed promotion is explicitly shared research;
there is no independent promotion test. Changing the public checkpoint creates
a new cohort and requires a fresh baseline. Rejected branches and failed
experiments remain in the stage's declared merge and total project cost.

Model usage-only profiles have no hard token/request cap. Their measured usage
is a lower bound when provider retries or missing usage cannot be verified;
unknown monetary cost is not zero. CPU, time, tools and five experiment slots
remain separate constraints. Do not describe an observational profile as a
hard model budget.

New Kaggle tasks use MLE-bench definitions and prepared public/private trees.
Keep raw metric and selection utility separate: accuracy/AUC use identity;
mean-column-wise RMSLE uses 1/(1+score), with lower raw error preferred.
The immutable grader computes metrics from full OOF predictions. Preserve all
target columns and public assets, and use the sample/test ID order for exports.
Never merge benchmark-private answers into research training. Official Kaggle
deployment inputs are a separately registered, zero-model refit scope.
