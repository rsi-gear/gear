"""Native MLE-bench grade(submission: DataFrame, answers: DataFrame) interface."""
from sklearn.metrics import accuracy_score
from mlebench.competitions.utils import prepare_for_accuracy_metric


def grade(submission, answers):
    values = prepare_for_accuracy_metric(submission, answers, target_column='Survived', id_column='PassengerId')
    return float(accuracy_score(values['y_true'], values['y_pred']))
