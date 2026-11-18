---
name: data-analysis
description: Analyze public tabular data, validate modeling choices and deliver predictions with ordinary Python and file tools.
---

# Data analysis

Read the task instructions and effective parameter configuration first. Use the task's declared input and output paths, columns, row identifiers and limits. Public training data may contain labels; private verifier labels are never modeling inputs.

Start with a small working baseline. Inspect schema, missing values, duplicates, class balance, related groups, temporal order and possible leakage. Choose training-internal validation appropriate to the data within the allowed method parameters. Fit learned preprocessing only on each training partition. Keep notes and runnable code as ordinary workspace files; there is no required stage state machine or pipeline factory.

Use normal sklearn estimators, pipelines, other supported libraries or standalone training scripts. Bound searches by the task's resources and declared limits. Save candidate configurations and internal validation results with their data and method identity. Internal CV results are diagnostic evidence, not the official external score. If a method parameter is editable, use the declared submission channel before starting that training action. Rejected changes do not change effective values.

When no trusted training capability is enabled, fit counts and CV descriptions are observations or self-reports, not proof of enforced constraints. Do not claim zero fits when the count is unknown. When a task binds a trusted capability, use its documented supported interface and retain its evidence; do not work around it.

Select a method from legitimate training evidence, then perform any necessary final training and generate the requested prediction file in this same session. Ordinary tasks do not require model serialization; save weights or a reproducible program when the delivery contract requires them. If selection freezing is enabled, follow the declared capability before final training.

Validate the delivery schema, finite values, row identifiers and ordering against the public contract. Do not infer official test accuracy from unlabeled prediction data. Leave a concise explanation of the selected method, internal validation, limitations, and paths to code and deliverables. On failure preserve the actual exit status and bounded stderr so the operator can diagnose it.
