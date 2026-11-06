"""GEPA frontier membership and optional champion mixture, over seed scopes only."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, replace

from ..contracts import (
    ParentAllocation,
    ParentInput,
    ParentOption,
    ParentPlan,
    RandomSource,
)


def frontier_options(view: ParentInput) -> tuple[ParentOption, ...]:
    groups: dict[str, list[ParentOption]] = defaultdict(list)
    for option in view.eligible:
        groups[option.scope].append(option)
    distributions: list[list[ParentOption]] = []
    equivalences: set[tuple[tuple[str, ...], tuple[tuple[str, float], ...]]] = set()
    for scope, members in sorted(groups.items()):
        equivalence = (members[0].task_ids, members[0].weights)
        if equivalence in equivalences:
            continue
        equivalences.add(equivalence)
        representatives: dict[str, ParentOption] = {}
        for option in sorted(members, key=lambda item: item.candidate_id):
            representatives.setdefault(option.content_digest or option.candidate_id, option)
        eligible = list(representatives.values())
        values = {
            option.candidate_id: dict(option.task_scores or (("aggregate", option.score),))
            for option in eligible
        }
        tasks = set.intersection(*(set(scores) for scores in values.values())) if values else set()
        weights = dict(members[0].weights) if members[0].task_scores else {"aggregate": 1.0}
        fronts: list[tuple[float, set[str]]] = []
        for task in sorted(tasks):
            high = max(scores[task] for scores in values.values())
            winners = {candidate for candidate, scores in values.items() if scores[task] == high}
            weight = weights.get(task, 1 / len(tasks))
            if len(winners) != len(values) and weight > 0:
                fronts.append((weight, winners))
        live = {option.candidate_id for option in eligible}
        # Remove redundant frontier members from worst aggregate to best. Ties
        # are stable; a unique task winner always survives.
        for option in sorted(eligible, key=lambda item: (item.score, item.candidate_id)):
            if fronts and all(
                winners & (live - {option.candidate_id})
                for _, winners in fronts
                if option.candidate_id in winners
            ):
                live.remove(option.candidate_id)
        masses: dict[str, float] = defaultdict(float)
        if fronts:
            for weight, winners in fronts:
                for candidate in winners & live:
                    masses[candidate] += weight
        elif eligible:
            fallback = next(
                (option for option in eligible if option.candidate_id == view.champion_id),
                min(eligible, key=lambda item: (-item.score, item.candidate_id)),
            )
            masses[fallback.candidate_id] = 1
        total = math.fsum(masses.values())
        if total:
            distributions.append(
                [
                    replace(option, probability=masses.get(option.candidate_id, 0) / total)
                    for option in eligible
                ]
            )
    count = len(distributions)
    return tuple(
        replace(option, probability=option.probability / count)
        for group in distributions
        for option in group
    )


@dataclass(frozen=True)
class ScopedFrontier:
    batch_count: int = 1
    champion_probability: float = 0.0

    def __call__(self, view: ParentInput, rng: RandomSource) -> ParentPlan:
        if not view.eligible or view.candidate_limit < 1:
            return ParentPlan.abstain("no eligible parent")
        if type(self.batch_count) is not int or self.batch_count < 1:
            raise ValueError("batch_count must be a positive integer")
        if not math.isfinite(self.champion_probability) or not 0 <= self.champion_probability <= 1:
            raise ValueError("champion_probability must be between zero and one")
        options = list(frontier_options(view))
        if self.champion_probability:
            champion = sorted(
                (option for option in view.eligible if option.candidate_id == view.champion_id),
                key=lambda item: (-len(item.task_ids), item.scope),
            )
            if not champion:
                raise ValueError("champion has no complete eligible seed scope")
            chosen = champion[0]
            options = [
                replace(
                    option,
                    probability=option.probability * (1 - self.champion_probability),
                )
                for option in options
            ]
            index = next(
                (
                    i
                    for i, option in enumerate(options)
                    if (option.scope, option.candidate_id) == (chosen.scope, chosen.candidate_id)
                ),
                None,
            )
            if index is None:
                options.append(replace(chosen, probability=self.champion_probability))
            else:
                options[index] = replace(
                    options[index],
                    probability=options[index].probability + self.champion_probability,
                )
        batches = min(self.batch_count, view.candidate_limit)
        allocations = tuple(
            ParentAllocation(
                rng.choice(tuple(options), key="parent", index=index),
                view.candidate_limit // batches + (index < view.candidate_limit % batches),
            )
            for index in range(batches)
        )
        return ParentPlan(
            allocations,
            "seed frontier membership"
            if not self.champion_probability
            else "champion/frontier mixture",
        )


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    return ScopedFrontier()(view, rng)
