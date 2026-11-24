"""DiagEvo challenger rewards, before native GRPO dataset construction.

This component does not authenticate captures, answer equivalence, or policy
identities. The training caller must bind these inputs to actual executions.
Completed format errors stay in their groups; missing executions are rejected.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from importlib import import_module
from typing import ClassVar

from gear.core import Module
from gear.training.recipes.diagevo import ConstructionVote, DiagEvoPolicy, _text, _unique


@dataclass(frozen=True)
class ChallengerSample:
    sample_id: str
    group_id: str
    prompt_id: str
    policy_id: str
    response: str
    trajectory_ref: str
    completed: bool = True


@dataclass(frozen=True)
class ChallengerReward:
    sample: ChallengerSample
    question: str | None
    vote: ConstructionVote | None
    cluster_sample_ids: tuple[str, ...]
    cluster_share: float
    uncertainty: float | None
    reward: float


def _question(response: str) -> str | None:
    match = re.fullmatch(r"\s*<question>(.*?)</question>\s*", response, re.DOTALL)
    if match is None:
        return None
    value = match.group(1).strip()
    if not value or re.search(r"</?question\b", value, re.IGNORECASE):
        return None
    return value


def _clusters(questions: Sequence[str], threshold: float) -> tuple[tuple[int, ...], ...]:
    if len(questions) < 2:
        return ((0,),) if questions else ()
    try:
        bleu = import_module("nltk.translate.bleu_score")
        cluster = import_module("sklearn.cluster")
    except ImportError as error:
        raise RuntimeError("challenger clustering requires nltk and scikit-learn") from error

    # R-Zero's ordered convention: the earlier question is the hypothesis;
    # mirror that single directional BLEU distance, not a two-way average.
    tokens = [question.split() for question in questions]
    smooth = bleu.SmoothingFunction().method1
    distances = [[0.0] * len(tokens) for _ in tokens]
    for earlier in range(len(tokens)):
        for later in range(earlier + 1, len(tokens)):
            distance = 1.0 - float(
                bleu.sentence_bleu([tokens[later]], tokens[earlier], smoothing_function=smooth)
            )
            distances[earlier][later] = distances[later][earlier] = distance
    labels = cluster.AgglomerativeClustering(
        n_clusters=None,
        metric="precomputed",
        linkage="average",
        distance_threshold=threshold,
    ).fit_predict(distances)
    members: dict[int, list[int]] = defaultdict(list)
    for index, label in enumerate(labels):
        members[int(label)].append(index)
    # Library-specific numeric labels are not stable evidence identities.
    return tuple(sorted((tuple(value) for value in members.values()), key=lambda row: row[0]))


@dataclass
class DiagEvoChallengerReward(Module):
    group_size: int = 8
    repetition_weight: float = 1.0
    distance_threshold: float = 0.5
    policy: DiagEvoPolicy = field(default_factory=DiagEvoPolicy)
    package_dependencies: ClassVar[tuple[str, ...]] = ("nltk", "scikit-learn")

    def _batch(self, samples: Sequence[ChallengerSample]) -> tuple[ChallengerSample, ...]:
        self.policy._parameters()
        if (
            type(self.group_size) is not int
            or self.group_size < 2
            or any(
                type(value) not in (int, float) or not math.isfinite(value)
                for value in (self.repetition_weight, self.distance_threshold)
            )
            or self.repetition_weight < 0
            or not 0 <= self.distance_threshold <= 1
        ):
            raise ValueError("invalid challenger group size or repetition parameters")
        values = tuple(samples)
        if (
            not values
            or not _unique([row.sample_id for row in values])
            or not _unique([row.trajectory_ref for row in values])
            or len({row.policy_id for row in values}) != 1
            or any(
                row.completed is not True
                or not isinstance(row.response, str)
                or not all(_text(value) for value in (row.group_id, row.prompt_id, row.policy_id))
                for row in values
            )
        ):
            raise ValueError(
                "challenger batch requires distinct completed captures from one policy"
            )
        groups: dict[str, list[ChallengerSample]] = defaultdict(list)
        for row in values:
            groups[row.group_id].append(row)
        if any(
            len(group) != self.group_size or len({row.prompt_id for row in group}) != 1
            for group in groups.values()
        ):
            raise ValueError("each challenger group must be complete and use one prompt")
        return values

    def questions(self, samples: Sequence[ChallengerSample]) -> tuple[tuple[str, str], ...]:
        """Validate the whole batch before the caller spends solver requests.

        Solver question IDs must be the corresponding challenger sample IDs.
        Distinct groups may share a prompt ID; never group by prompt text alone.
        """
        return tuple(
            (row.sample_id, question)
            for row in self._batch(samples)
            if (question := _question(row.response)) is not None
        )

    def score(
        self, samples: Sequence[ChallengerSample], votes: Sequence[ConstructionVote]
    ) -> tuple[ChallengerReward, ...]:
        values = self._batch(samples)
        questions = dict(self.questions(values))
        by_question: dict[str, ConstructionVote] = {}
        sample_ids = {row.sample_id for row in values}
        capture_refs = {row.trajectory_ref for row in values}
        for vote in votes:
            self.policy._vote(vote)
            ids = {row.sample_id for row in vote.samples}
            refs = {row.trajectory_ref for row in vote.samples}
            if (
                vote.question_id in by_question
                or sample_ids.intersection(ids)
                or capture_refs.intersection(refs)
            ):
                raise ValueError(
                    "solver evidence must use distinct questions, samples, and captures"
                )
            sample_ids.update(ids)
            capture_refs.update(refs)
            by_question[vote.question_id] = vote
        if set(by_question) != set(questions) or len({vote.policy_id for vote in votes}) > 1:
            raise ValueError("every valid question needs complete votes from one frozen solver")

        valid_ids = tuple(questions)
        memberships: dict[str, tuple[str, ...]] = {}
        for cluster in _clusters(tuple(questions.values()), self.distance_threshold):
            members = tuple(valid_ids[index] for index in cluster)
            for sample_id in members:
                memberships[sample_id] = members

        result = []
        for row in values:
            question = questions.get(row.sample_id)
            solver_vote = by_question.get(row.sample_id)
            members = memberships.get(row.sample_id, ())
            share = len(members) / len(values)
            uncertainty = 1 - 2 * abs(solver_vote.p1 - 0.5) if solver_vote is not None else None
            reward = (
                max(0.0, uncertainty - self.repetition_weight * share)
                if uncertainty is not None
                else 0.0
            )
            result.append(
                ChallengerReward(row, question, solver_vote, members, share, uncertainty, reward)
            )
        return tuple(result)
