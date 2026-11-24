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
from gear.core.base import construct_module
from gear.training.data import samples as native_samples
from gear.training.data.samples import seal_batch
from gear.training.data.trajectories import RawTrajectory
from gear.training.recipes import diagevo, diagevo_data, diagevo_generation, diagevo_round
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
    _committed_batches,
    _native_groups,
    _solver_identity,
)
from gear.training.recipes.diagevo_round import RoundEvidence
from gear.training.runtime.implementation import stage_identity
from gear.training.storage.content import digest_json, require


def native_component(spec):
    """Rebuild only the supported native recipe components from stored descriptions."""
    from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
    from gear.training.recipes.diagevo_generation import DiagEvoQuestionPrompt
    from gear.training.recipes.diagevo_memory import DiagEvoDiagnostician

    allowed = {
        cls.__module__ + ":" + cls.__qualname__: cls
        for cls in (
            DiagEvoPolicy,
            DiagEvoChallengerReward,
            DiagEvoQuestionPrompt,
            DiagEvoDiagnostician,
        )
    }

    def resolve(name):
        require(name in allowed, "diagevo-component", "unsupported native DiagEvo component")
        return allowed[name]

    return construct_module(spec, resolve)


def read_native_curriculum(store, curriculum_ref, challenger_request_ref, *, request=None):
    """Recompute the complete pool before task authoring or native optimization."""
    from gear.training.recipes.diagevo_answers import DiagEvoMathClassifier
    from gear.training.recipes.diagevo_data import DiagEvoChallengerDatasetBuilder

    pool = store.read_json(curriculum_ref)
    require(
        pool.get("kind") == "diagevo-solver-curriculum"
        and pool.get("schemaVersion") == 1
        and pool["input"].get("generationRef") is not None,
        "diagevo-generation-required",
        "native solver recipe requires a curriculum bound to fresh challenger generation",
    )
    origin = store.read_json(pool["input"]["generationRef"])
    challenger_request = store.read_json(challenger_request_ref)
    require(
        digest_json(challenger_request) == origin["requestDigest"],
        "diagevo-challenger-request-drift",
        "fresh question provenance must use the sealed challenger request",
    )
    generation = diagevo_generation.DiagEvoGenerationBuilder(
        DiagEvoChallengerDatasetBuilder(
            store, challenger_request, objective=native_component(origin["objective"])
        ),
        prompt=native_component(origin["prompt"]),
    )
    builder = DiagEvoSolverDatasetBuilder(
        store, request, policy=native_component(pool["policy"]), generation_builder=generation
    )
    builder._pool(curriculum_ref)
    require(
        pool["classifier"].get("kind") == DiagEvoMathClassifier.stage_id
        and isinstance(pool["classifier"].get("parameters"), dict),
        "diagevo-classifier-drift",
        "native solver recipe requires a mathematical classifier configuration",
    )
    classifier = DiagEvoMathClassifier(store, **pool["classifier"]["parameters"])
    require(
        classifier.identity() == pool["classifier"],
        "diagevo-classifier-drift",
        "native solver recipe requires the frozen Math-Verify classifier",
    )
    return builder, pool, classifier


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
        Path(diagevo_generation.__file__),
        Path(diagevo_round.__file__),
        Path(native_samples.__file__),
    )

    def __init__(self, store, request=None, *, policy=None, generation_builder=None):
        self.store, self.request = store, deepcopy(request)
        self.policy = clone(policy if policy is not None else DiagEvoPolicy())
        self.generation_builder = generation_builder
        # Curriculum construction precedes admission of its retained questions.
        # Only immutable curriculum operations are available without a request.
        if request is not None:
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
        origin, seen = None, set()
        require(
            (self.generation_builder is None) == (inputs["generationRef"] is None),
            "diagevo-generation-required",
            "a bound solver curriculum requires its fresh-generation builder and reference",
        )
        if self.generation_builder is not None:
            origin, seen = self.generation_builder.read(inputs["generationRef"])
            require(
                questions == origin["questions"]
                and inputs["generation"] == origin["generation"]
                and inputs["memory"] == origin["input"]["memory"]
                and inputs["constructionPolicyId"] == origin["input"]["solverPolicyId"]
                and self.policy.describe().to_dict()
                == self.generation_builder.challenger.objective.policy.describe().to_dict(),
                "diagevo-curriculum-origin-drift",
                "solver curriculum must use all fresh questions, their memory directives and frozen solver",
            )
        classification, labels = _answer_labels(self.store, inputs["answerClassesRef"])
        consumed, identities, texts, votes = set(), set(), {}, []
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
        require(
            origin is None
            or origin["solverIdentity"] is None
            or json_value(next(iter(identities))) == origin["solverIdentity"],
            "diagevo-construction-drift",
            "curriculum construction must keep the solver frozen during challenger updates",
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
        generation_ref=None,
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
            "generationRef": deepcopy(generation_ref),
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
        require(
            self.request is not None,
            "diagevo-solver-admission-required",
            "gradient batches require an admitted solver training request",
        )
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
        require(
            self.request is not None,
            "diagevo-solver-admission-required",
            "committed failures require an admitted solver training request",
        )
        pool, votes, generation, memory, seen = self._pool(curriculum_ref)
        request, store = self.request, self.store
        optimization, texts = [], dict(pool["trajectoryTexts"])
        for batch_ref, _, before in _committed_batches(store, request, commit_refs):
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
            optimization.extend(groups)
            texts.update(captured_texts)
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
