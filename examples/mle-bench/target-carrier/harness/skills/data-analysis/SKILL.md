# Tabular research

Inspect schema, class balance, missingness, duplicates and group/time structure.
Form a hypothesis before modifying a solution. Use the locked validation plan,
and compare fixed-scorer results on the shared held-out validation set.
Check leakage and train/query feature differences. Preprocessing that learns any
statistics must fit on the supplied training rows. You may use internal CV or
tuning within those rows, or train directly; validation labels are not available.
Record both negative and
positive findings. Preserve previous working source when a new experiment fails.

For MLE-bench tasks, honor prediction.metric and all targetColumns. AUC needs
probabilities, not thresholded labels. Mean-column-wise RMSLE needs nonnegative
predictions for each target; lower raw RMSLE is better. The selection policy
compares validationUtility. Training diagnostics do not replace the fixed score.
Public row assets are relative to the directory containing --train: train/<id>/
and test/<id>/. The driver remaps held-out validation-row assets to test/<id>/
and hides the original query assets during research. IDs can overlap across splits.
Handle absent, empty and missing values in every supplied feature consistently.
Inspect visible train/query missingness before choosing preprocessing; never use
query labels or fit feature statistics on query rows. Use --seed deterministically.
