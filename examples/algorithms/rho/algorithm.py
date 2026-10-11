"""One-file science-policy customization over the managed RHO recipe."""
from gear_algorithm.recipes.rho import Rho, select_coreset


def choose_history(judgments, size):
    # Swap only this strategy; evidence, tasks, rollouts and commits stay managed.
    return select_coreset(judgments, size, theta=0.7)


algorithm = Rho(selector=choose_history)
