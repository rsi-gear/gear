"""Configuration for Regularized Recursive Self-Improvement."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class RRSIConfig:
    rounds: int = 20
    candidates: int = 2
    repetitions: int = 2
    min_edit_budget: int = 1
    max_edit_budget: int = 4
    stall_window: int = 3
    exploration_slots: int = 1
    noise_delta: float = 0.0
    beta0: float = 0.10
    beta1: float = 40.0
    score_weight: float = 100.0
    cost_weight: float = 15.0
    novelty_weight: float = 0.5
    prune_window: int = 4

    def __post_init__(self) -> None:
        if self.rounds < 1 or self.candidates < 1 or self.repetitions < 1:
            raise ValueError("rounds, candidates and repetitions must be positive")
        if self.min_edit_budget < 1 or self.max_edit_budget < self.min_edit_budget:
            raise ValueError("edit budget bounds are invalid")
        if self.stall_window < 1 or self.exploration_slots < 0 or self.prune_window < 1:
            raise ValueError("window and exploration settings are invalid")
        if self.noise_delta < 0 or self.beta0 < 0 or self.beta1 < 0:
            raise ValueError("selection thresholds must be nonnegative")

    def edit_budget(self, round_index: int) -> int:
        import math

        if self.rounds <= 0:
            return self.max_edit_budget
        t = max(0, min(round_index, self.rounds))
        value = self.min_edit_budget + (
            self.max_edit_budget - self.min_edit_budget
        ) * 0.5 * (1 + math.cos(math.pi * t / self.rounds))
        return int(math.ceil(round(value, 9)))

    def to_json(self) -> dict[str, int | float]:
        return asdict(self)
