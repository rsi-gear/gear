"""Offline RRSI contract example; no Docker, benchmark or model credentials."""

from gear.algorithms import RRSI, RRSIConfig
from gear.algorithms.testkit import toy_round


if __name__ == "__main__":
    algorithm = RRSI(
        config=RRSIConfig(
            rounds=2,
            candidates=2,
            min_edit_budget=1,
            max_edit_budget=3,
        )
    )
    print(toy_round(algorithm))
