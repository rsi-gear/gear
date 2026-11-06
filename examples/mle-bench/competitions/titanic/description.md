# Titanic: survival prediction

Predict whether each passenger survived. The target is `Survived`, with labels
`0` and `1`; the ID column is `PassengerId`. The metric is accuracy (higher is
better). Submit exactly `PassengerId,Survived`, in `sample_submission.csv` order.

`train.csv` contains labeled training examples. `test.csv` contains a locally
held-out subset of the original labeled training data. Its labels are private.
The public files may contain missing numeric values and unseen categories.
Fit preprocessing on the training rows supplied to each invocation.

This task is a local MLE-bench format extension. It is not an official member of
the MLE-bench 75-competition or Lite suites. Its benchmark test is not Kaggle's
official 418-row test set. No medal thresholds or Kaggle test score are available.
