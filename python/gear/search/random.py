"""Composable search policies and flows."""

import json
import math
from dataclasses import asdict

from gear.canonical import digest
from gear.core.random import DeterministicRandom as IndexedRandom
from gear.search.contracts_v1 import ParentOption, Selection


class DeterministicRandom(IndexedRandom):
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
