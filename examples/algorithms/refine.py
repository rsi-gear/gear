"""Run from a project after copying parent_policy.py beside this script."""

from parent_policy import select_parent

from gear import Project
from gear.algorithms import GEPA
from gear.algorithms.testkit import test_parent_policy, toy_round

if __name__ == "__main__":
    print(test_parent_policy(select_parent))
    algorithm = GEPA(parent_policy=select_parent)
    print(toy_round(algorithm))
    print(Project.open().refine(algorithm=algorithm, rounds=1).report.summary)
