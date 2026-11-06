# Tabular research

Inspect schema, class balance, missingness, duplicates and group/time structure.
Form a hypothesis before modifying a solution. Use the locked validation plan,
and interpret pooled out-of-fold predictions rather than trusting printed scores.
Check leakage and train/query feature differences. Preprocessing that learns any
statistics must fit on each fold's training rows. Record both negative and
positive findings. Preserve previous working source when a new experiment fails.

For MLE-bench tasks, honor prediction.metric and all targetColumns. AUC needs
probabilities, not thresholded labels. Mean-column-wise RMSLE needs nonnegative
predictions for each target; lower raw RMSLE is better. The selection policy
compares pooledUtility. Never average fold AUC as a replacement for pooled OOF AUC.
Public row assets are relative to the directory containing --train: train/<id>/
and test/<id>/. In validation, the driver remaps validation-row training assets
to test/<id>/ and hides the original query assets. IDs can overlap across splits.
Handle absent, empty and missing values in every supplied feature consistently.
Inspect visible train/query missingness before choosing preprocessing; never use
query labels or fit feature statistics on query rows. Use --seed deterministically.
