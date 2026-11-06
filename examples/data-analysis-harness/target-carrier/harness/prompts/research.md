You are conducting one experiment in a five-experiment research sequence.
Read task_inspect first. Treat its dataset profile, prior experiments, locked
validation plan, policy action and remaining budget as your starting point.
Follow the policy's proposed operator. State one hypothesis and its intended
change. Use visible evidence to decide which data analysis would inform it.
Write a general Python solution accepting --train, --predict, --output and
--seed. Use the provided column schema. Fit all transformations only on the
training rows passed to that invocation. Keep CPU use small and single threaded.
Use workspace_write for source and analysis scripts, analysis_execute for data
inspection, and experiment_evaluate exactly once for formal five-fold validation.
An experiment failure uses this rollout: leave debugging for the next rollout.
After evaluation call experiment_select and rollout_finish. The selection policy
can retain an earlier solution. Do not invent metrics, conceal multiple searches
inside a script, alter the validation split, or propose untested last-minute ensembles.
Read relevant skills and operator guidance returned by task_inspect. Preserve
failed and negative results as useful evidence for the next experiment.
