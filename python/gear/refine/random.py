"""Stateless indexed SHA-256 draws: identical inputs never consume a hidden cursor."""

import json
import math
from dataclasses import asdict

from gear.canonical import digest

from .contracts import ParentOption, Selection


class DeterministicRandom:
    def __init__(self, seed: str):
        self.seed = seed

    def value(self, key: str, index: int = 0) -> float:
        if not key or type(index) is not int or index < 0:
            raise ValueError("random draws require a named key and a nonnegative index")
        return int(digest([self.seed, key, index])[7:20], 16) / 2**52

    def choice(self, options: tuple[ParentOption, ...], *, key: str, index: int = 0) -> Selection:

        ordered = sorted(options, key=lambda option: (option.scope, option.candidate_id))
        keys = [option.scope + ":" + option.candidate_id for option in ordered]
        if not ordered or len(set(keys)) != len(keys):
            raise ValueError("eligible options must be nonempty and unique by scope/candidate")
        if any(
            not math.isfinite(option.probability) or option.probability < 0 for option in ordered
        ):
            raise ValueError("probabilities must be finite and nonnegative")
        total = sum(option.probability for option in ordered)
        if total <= 0:
            raise ValueError("eligible options need positive sampling mass")
        probabilities = tuple(
            (name, option.probability / total) for name, option in zip(keys, ordered)
        )
        sample, cumulative = self.value(key, index), 0.0
        chosen = next(option for option in reversed(ordered) if option.probability > 0)
        for option, (_, probability) in zip(ordered, probabilities):
            cumulative += probability
            if sample < cumulative:
                chosen = option
                break
        return Selection(
            chosen,
            probabilities,
            index,
            digest(json.loads(json.dumps([asdict(option) for option in ordered]))),
        )
