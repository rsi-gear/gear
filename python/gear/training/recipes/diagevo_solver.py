"""Captured solver curriculum, native GRPO batches, and committed-round diagnosis.

The caller owns question generation, task admission, answer equivalence, native
job provenance, and model execution. These methods verify their stored joins;
CAS integrity does not authenticate an untrusted producer or prove correctness.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, replace
from pathlib import Path

from gear.core import clone
from gear.core._json import json_value
from gear.training.data import samples as native_samples
from gear.training.data.samples import seal_batch
from gear.training.data.trajectories import RawTrajectory
from gear.training.recipes import diagevo, diagevo_data, diagevo_round
from gear.training.recipes.agent_grpo import sampling_params
from gear.training.recipes.diagevo import (
    Cause,
    DiagEvoPolicy,
    GenerationDirective,
    SolverSample,
    _text,
)
from gear.training.recipes.diagevo_data import (
    _answer_labels,
    _capture,
    _native_groups,
    _solver_identity,
)
from gear.training.recipes.diagevo_round import RoundEvidence
from gear.training.runtime.implementation import stage_identity
from gear.training.runtime.preflight import compatibility_digest
from gear.training.storage.content import require


def _cause(row):
    return Cause(
        **{
            **row,
            "failure_ids": tuple(row["failure_ids"]),
            "episode_failure_ids": tuple(row["episode_failure_ids"]),
        }
    )


class DiagEvoSolverDatasetBuilder:
    stage_id = "gear.diagevo.solver-dataset:v1"
    source_dependencies = (
        Path(diagevo.__file__),
        Path(diagevo_data.__file__),
        Path(diagevo_round.__file__),
        Path(native_samples.__file__),
    )

    def __init__(self, store, request, *, policy=None):
        self.store, self.request = store, deepcopy(request)
        self.policy = clone(policy if policy is not None else DiagEvoPolicy())
        require(
            request.get("schemaVersion") == 2
            and request["trainer"].get("recipe", "agent-grpo-v1") == "agent-grpo-v1"
            and request["rollout"]["zeroVarianceGroup"] == "keep"
            and request["rollout"]["groupSize"] == self.policy.optimization_group_size,
            "diagevo-training-contract",
            "solver needs v2 GRPO, matching optimization group size, and zeroVarianceGroup=keep",
        )
        sampling_params(request["rollout"])

    def _curriculum(self, inputs):
        questions, construction = inputs["questions"], inputs["construction"]
        generation = {
            key: GenerationDirective(row["mode"], tuple(row["cause_ids"]))
            for key, row in inputs["generation"].items()
        }
        memory = tuple(_cause(row) for row in inputs["memory"])
        require(
            questions
            and set(questions) == set(construction) == set(generation)
            and all(_text(key) and _text(text) for key, text in questions.items())
            and _text(inputs["constructionPolicyId"]),
            "diagevo-curriculum-coverage",
            "curriculum needs the entire question pool, generation directives, and frozen solver",
        )
        classification, labels = _answer_labels(self.store, inputs["answerClassesRef"])
        seen, consumed, identities, texts, votes = set(), set(), set(), {}, []
        for question_id in sorted(questions):
            answers = []
            for value in construction[question_id]:
                raw = RawTrajectory(**value)
                _, context, identity, body, response = _capture(self.store, raw, seen)
                require(
                    body["messages"][-1]["content"] == questions[question_id]
                    and context["policyVersion"] == inputs["constructionPolicyId"]
                    and identity in labels,
                    "diagevo-construction-drift",
                    "construction must answer the exact curriculum question under the frozen solver",
                )
                consumed.add(identity)
                identities.add(_solver_identity(context, body))
                texts[identity] = response
                answers.append(
                    SolverSample(
                        context["id"],
                        question_id,
                        context["policyVersion"],
                        "construction",
                        labels[identity],
                        identity,
                    )
                )
            vote = self.policy.construction(answers)
            reference = next(row for row in answers if row.sample_id == vote.reference_sample_id)
            require(
                not vote.retained or _text(texts[reference.trajectory_ref]),
                "diagevo-empty-reference",
                "a retained pseudo-label needs a nonempty captured diagnostic reference",
            )
            votes.append(vote)
        require(
            consumed == set(labels) and len(identities) == 1,
            "diagevo-construction-drift",
            "construction labels must cover one frozen solver and one instruction/sampling contract",
        )
        self.policy.update(memory, votes=votes, generation=generation, groups=(), attributions=())
        value = {
            "schemaVersion": 1,
            "kind": "diagevo-solver-curriculum",
            "implementation": stage_identity(self),
            "policy": self.policy.describe().to_dict(),
            "input": inputs,
            "classifier": classification["classifier"],
            "solverIdentity": json_value(next(iter(identities))),
            "votes": json_value([asdict(vote) for vote in votes]),
            "trajectoryTexts": texts,
        }
        return value, tuple(votes), generation, memory, seen

    def seal_curriculum(
        self,
        questions,
        construction,
        *,
        generation,
        memory,
        construction_policy_id,
        answer_classes_ref,
    ):
        """Keep filtered candidates too: promotion uses the full construction pool."""
        inputs = {
            "questions": deepcopy(questions),
            "construction": {
                key: [asdict(raw) for raw in construction[key]] for key in construction
            },
            "generation": json_value({key: asdict(row) for key, row in generation.items()}),
            "memory": json_value([asdict(row) for row in memory]),
            "constructionPolicyId": construction_policy_id,
            "answerClassesRef": deepcopy(answer_classes_ref),
        }
        return self.store.put_json(self._curriculum(inputs)[0])

    def _pool(self, ref):
        saved = self.store.read_json(ref)
        actual = self._curriculum(saved["input"])
        require(
            saved == actual[0], "diagevo-curriculum-drift", "frozen curriculum evidence changed"
        )
        return actual

    def _build(self, groups, *, lease, curriculum_ref, answer_classes_ref):
        pool, votes, generation, memory, seen = self._pool(curriculum_ref)
        construction_seen = set(seen)
        classification, labels = _answer_labels(
            self.store, answer_classes_ref, curriculum_ref=curriculum_ref
        )
        require(
            classification["classifier"] == pool["classifier"],
            "diagevo-classifier-drift",
            "optimization must keep the curriculum's answer-equivalence convention",
        )
        captured = _native_groups(self.store, self.request, groups, lease, seen)
        by_question = {vote.question_id: vote for vote in votes}
        consumed, optimization, texts = set(), [], {}
        for group in captured:
            question_id = group[0][1]["taskId"]
            vote = by_question.get(question_id)
            require(
                vote is not None and vote.retained,
                "diagevo-unretained-question",
                "solver optimization requires a question retained by double confidence",
            )
            answers = []
            for _, context, identity, body, response in group:
                require(
                    context["taskId"] == question_id
                    and body["messages"][-1]["content"] == pool["input"]["questions"][question_id]
                    and list(_solver_identity(context, body)[2:]) == pool["solverIdentity"][2:]
                    and identity in labels,
                    "diagevo-optimization-drift",
                    "optimization must keep the question, tokenizer, instructions and sampling contract",
                )
                consumed.add(identity)
                texts[identity] = response
                answers.append(
                    SolverSample(
                        context["id"],
                        question_id,
                        context["policyVersion"],
                        "optimization",
                        labels[identity],
                        identity,
                    )
                )
            optimization.append(self.policy.optimization(vote, answers))
        require(
            consumed == set(labels),
            "diagevo-optimization-coverage",
            "optimization labels must cover exactly the complete native batch",
        )
        self.policy.update(
            memory,
            votes=votes,
            generation=generation,
            groups=optimization,
            attributions=(),
        )
        proof = self.store.put_json(
            {
                "schemaVersion": 1,
                "kind": "diagevo-solver-rewards",
                "implementation": stage_identity(self),
                "curriculumRef": curriculum_ref,
                "lease": lease,
                "groups": [[asdict(raw) for raw in group] for group in groups],
                "answerClassesRef": answer_classes_ref,
                "optimization": json_value([asdict(group) for group in optimization]),
            }
        )
        scored = []
        for group, decision in zip(captured, optimization, strict=True):
            scored.append(
                [
                    replace(
                        row[0],
                        reward=reward,
                        metadata={
                            **row[0].metadata,
                            "originalVerifierReward": row[0].reward,
                            "rewardSource": "diagevo-solver-v1",
                            "curriculumRewardRef": proof,
                        },
                    )
                    for row, reward in zip(group, decision.rewards, strict=True)
                ]
            )
        evidence = [ref for group in groups for raw in group for ref in raw.refs()]
        batch = seal_batch(
            self.store, scored, self.request, lease, [*evidence, curriculum_ref, proof]
        )
        return batch, tuple(optimization), texts, seen - construction_seen

    def build(self, groups, *, lease, curriculum_ref, answer_classes_ref):
        return self._build(
            groups,
            lease=lease,
            curriculum_ref=curriculum_ref,
            answer_classes_ref=answer_classes_ref,
        )[0]

    def round_evidence(self, commit_refs, *, curriculum_ref):
        """Use the complete committed job, never an unconsumed or omitted batch.

        Native job/commit provenance must be authenticated by the caller. This
        checks the artifact chain and replays data construction before exposing
        captured failure/reference text to the existing memory updater.
        """
        pool, votes, generation, memory, seen = self._pool(curriculum_ref)
        request, store = self.request, self.store
        require(
            commit_refs and len(commit_refs) == request["trainer"]["updatesPerCandidate"],
            "diagevo-incomplete-job",
            "diagnosis requires every planned native update in this solver job",
        )
        before = request["parentModel"]["hfSnapshotRef"]
        parent_ref = request.get("resumeCheckpointRef")
        parent = store.read_json(parent_ref) if parent_ref else None
        if parent is not None:
            require(
                parent.get("schemaVersion") == 1
                and parent.get("compatibilityDigest") == compatibility_digest(request)
                and parent.get("hfExportRef") == before
                and isinstance(parent.get("actorStateRef"), dict)
                and parent.get("actorStateRef")
                == parent.get("optimizerStateRef")
                == parent.get("schedulerAndRngRef")
                and isinstance(parent.get("dataCursorRef"), dict)
                and type(parent.get("committedUpdate")) is int
                and parent["committedUpdate"] >= 0,
                "diagevo-parent-state-drift",
                "resume requires the complete compatible parent state and its exported model",
            )
        start = parent["committedUpdate"] if parent else 0
        previous, consumed, optimization, texts = None, set(), [], dict(pool["trajectoryTexts"])
        for index, ref in enumerate(commit_refs):
            commit = store.read_json(ref)
            number = start + index + 1
            require(
                commit.get("schemaVersion") == 1
                and commit.get("trainingRunId") == request["trainingRunId"]
                and commit.get("committedUpdate") == number
                and commit.get("previousCommitRef") == previous
                and commit.get("consumedBatchDigest") not in consumed,
                "diagevo-commit-chain-drift",
                "solver commits must form the complete contiguous consumed-batch chain",
            )
            checkpoint = store.read_json(commit["checkpointRef"])
            cursor = store.read_json(commit["dataCursorRef"])
            batch_ref = cursor["batchRef"]
            require(
                checkpoint.get("schemaVersion") == 1
                and checkpoint.get("committedUpdate") == cursor.get("committedUpdate") == number
                and checkpoint.get("compatibilityDigest") == compatibility_digest(request)
                and checkpoint.get("actorStateRef")
                == checkpoint.get("optimizerStateRef")
                == checkpoint.get("schedulerAndRngRef")
                == commit.get("rngRef")
                and checkpoint.get("dataCursorRef") == commit["dataCursorRef"]
                and batch_ref["digest"] == commit["consumedBatchDigest"],
                "diagevo-commit-state-drift",
                "solver checkpoint, optimizer, RNG, cursor and consumed batch must agree",
            )
            store.read_json(checkpoint["actorStateRef"])
            exported = store.read_json(checkpoint["hfExportRef"])
            require(
                exported.get("weightsDigest") == checkpoint.get("actorWeightsDigest"),
                "diagevo-export-drift",
                "checkpoint and exported weights must agree",
            )
            batch = store.read_json(batch_ref)
            samples = store.read_json(batch["samplesRef"])
            proof_ref = samples[0][0]["metadata"]["curriculumRewardRef"]
            proof = store.read_json(proof_ref)
            require(
                proof.get("kind") == "diagevo-solver-rewards"
                and proof.get("curriculumRef") == curriculum_ref
                and proof["lease"]["synchronizedWeightsRef"] == before,
                "diagevo-committed-reward-drift",
                "committed solver data must retain this curriculum and its pre-update model",
            )
            rebuilt, groups, captured_texts, identities = self._build(
                [[RawTrajectory(**raw) for raw in group] for group in proof["groups"]],
                lease=proof["lease"],
                curriculum_ref=curriculum_ref,
                answer_classes_ref=proof["answerClassesRef"],
            )
            require(
                rebuilt == batch_ref and not seen.intersection(identities),
                "diagevo-committed-reward-drift",
                "committed batches must reproduce exactly and cannot reuse earlier captures",
            )
            seen.update(identities)
            consumed.add(batch_ref["digest"])
            optimization.extend(groups)
            texts.update(captured_texts)
            previous, before = ref, checkpoint["hfExportRef"]
        self.policy.update(
            memory,
            votes=votes,
            generation=generation,
            groups=optimization,
            attributions=(),
        )
        needed = set()
        for group in optimization:
            for sample, reward in zip(group.samples, group.rewards, strict=True):
                if reward < 0:
                    needed.add(sample.trajectory_ref)
                    needed.add(
                        next(
                            row.trajectory_ref
                            for row in group.vote.samples
                            if row.sample_id == group.vote.reference_sample_id
                        )
                    )
        return RoundEvidence(
            votes,
            generation,
            tuple(optimization),
            deepcopy(pool["input"]["questions"]),
            {key: texts[key] for key in sorted(needed)},
        )
