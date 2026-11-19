"""Bind fresh challenger questions to committed updates and captured memory prompts.

The caller owns sampling, authorization and the native ledger. This builder
replays stored data joins; it neither runs a model nor authenticates a producer.
"""

from __future__ import annotations

from collections.abc import Sequence
from copy import deepcopy
from dataclasses import asdict, dataclass
from pathlib import Path

from gear.core import Module, clone
from gear.core._json import json_value
from gear.training.data.trajectories import RawTrajectory
from gear.training.recipes import diagevo, diagevo_challenger, diagevo_data, diagevo_memory
from gear.training.recipes.diagevo import (
    Cause,
    GenerationDirective,
    _generation_causes,
    _memory,
    _text,
)
from gear.training.recipes.diagevo_challenger import ChallengerSample
from gear.training.recipes.diagevo_data import (
    _capture,
    _committed_batches,
    _native_groups,
    _solver_identity,
)
from gear.training.recipes.diagevo_memory import SkillNode, _nodes
from gear.training.runtime.implementation import stage_identity
from gear.training.storage.content import digest_json, require


@dataclass
class DiagEvoQuestionPrompt(Module):
    """Recipe-local text prompts; native request conversion stays with the caller."""

    system: str = (
        "Create an original, difficult competition mathematics problem. Use only your mathematical "
        "knowledge and the supplied skill context. Make the problem self-contained and aim for "
        "fewer than 30 percent of advanced high-school students to solve it. Emit only its statement "
        "between <question> and </question>; omit solutions and reasoning."
    )
    free: str = "Propose one new mathematics problem using the required question tags."
    targeted: str = (
        "Design one problem whose solution requires correcting the following active reasoning "
        "weakness. The skill label provides context. Return the problem in the required tags."
    )
    stitched: str = (
        "Combine the active weakness and the mastered skill into one mathematical problem. "
        "Both skills must contribute to the same solution. Mastered indicates high solver "
        "self-consistency, not verified correctness. Return the problem in the required tags."
    )

    def messages(
        self,
        directive: GenerationDirective,
        *,
        memory: Sequence[Cause],
        nodes: Sequence[SkillNode],
    ) -> list[dict[str, str]]:
        if not all(
            _text(value) for value in (self.system, self.free, self.targeted, self.stitched)
        ):
            raise ValueError("question prompts must be nonempty")
        by_node = _nodes(nodes, memory)
        causes = _generation_causes(directive, _memory(memory))
        user = self.free
        if causes:
            # JSON delimiters preserve the exact descriptions without treating
            # a cause's punctuation as prompt-template syntax.
            from gear.training.storage.content import canonical

            user = (
                (self.targeted if directive.mode == "targeted" else self.stitched)
                + "\n"
                + canonical(
                    {
                        "skill": by_node[causes[0].node_id].label,
                        "causes": [
                            {
                                "id": cause.cause_id,
                                "state": cause.state,
                                "description": cause.description,
                            }
                            for cause in causes
                        ],
                    }
                )
            )
        return [{"role": "system", "content": self.system}, {"role": "user", "content": user}]


class DiagEvoGenerationBuilder:
    stage_id = "gear.diagevo.fresh-generation:v1"
    source_dependencies = tuple(
        Path(module.__file__)
        for module in (diagevo, diagevo_challenger, diagevo_data, diagevo_memory)
    )
    package_dependencies = ("nltk", "scikit-learn")

    def __init__(self, challenger, *, prompt=None):
        self.challenger = challenger
        self.store = challenger.store
        self.prompt = clone(prompt if prompt is not None else DiagEvoQuestionPrompt())

    def _value(self, inputs):
        store, challenger = self.store, self.challenger
        memory = tuple(
            Cause(
                **{
                    **row,
                    "failure_ids": tuple(row["failure_ids"]),
                    "episode_failure_ids": tuple(row["episode_failure_ids"]),
                }
            )
            for row in inputs["memory"]
        )
        nodes = tuple(SkillNode(**row) for row in inputs["nodes"])
        generation = {
            key: GenerationDirective(row["mode"], tuple(row["cause_ids"]))
            for key, row in inputs["generation"].items()
        }
        require(
            set(generation) == {task["id"] for task in challenger.request["trainDataset"]["tasks"]}
            and _text(inputs["solverPolicyId"]),
            "diagevo-generation-coverage",
            "generation directives must cover the admitted challenger tasks and name the frozen solver",
        )
        messages = {
            key: self.prompt.messages(row, memory=memory, nodes=nodes)
            for key, row in generation.items()
        }
        seen, policies, solver_identities = set(), set(), set()

        def check_prompt(values):
            _, context, _, body, _ = values
            require(
                context["taskId"] in messages and body["messages"] == messages[context["taskId"]],
                "diagevo-generation-prompt-drift",
                "challenger captures must contain the exact declared memory prompt",
            )

        batches = _committed_batches(store, challenger.request, inputs["commitRefs"])
        for batch_ref, _, before in batches:
            batch = store.read_json(batch_ref)
            samples = store.read_json(batch["samplesRef"])
            proof = store.read_json(samples[0][0]["metadata"]["curriculumRewardRef"])
            require(
                proof.get("kind") == "diagevo-challenger-rewards"
                and proof.get("solverPolicyId") == inputs["solverPolicyId"]
                and proof["lease"]["synchronizedWeightsRef"] == before,
                "diagevo-challenger-commit-drift",
                "committed challenger data must use the frozen solver and its pre-update model",
            )
            groups = [[RawTrajectory(**raw) for raw in group] for group in proof["groups"]]
            answers = {
                key: [RawTrajectory(**raw) for raw in rows]
                for key, rows in proof["solverTrajectories"].items()
            }
            rebuilt = challenger.build(
                groups,
                lease=proof["lease"],
                solver_policy_id=inputs["solverPolicyId"],
                solver_trajectories=answers,
                answer_classes_ref=proof["answerClassesRef"],
            )
            require(
                rebuilt == batch_ref,
                "diagevo-challenger-commit-drift",
                "committed challenger batch must reproduce exactly",
            )
            policies.add(proof["lease"]["policyVersion"])
            for group in groups:
                for raw in group:
                    check_prompt(_capture(store, raw, seen))
            for rows in answers.values():
                for raw in rows:
                    _, context, _, body, _ = _capture(store, raw, seen)
                    solver_identities.add(_solver_identity(context, body))
        require(
            len(solver_identities) <= 1,
            "diagevo-solver-policy-drift",
            "all challenger updates require one frozen solver instruction and sampling contract",
        )
        lease = inputs["lease"]
        require(
            lease["synchronizedWeightsRef"] == batches[-1][1]["hfExportRef"]
            and lease["policyVersion"] not in policies,
            "diagevo-stale-challenger",
            "the curriculum must be sampled after the final challenger update",
        )
        groups = [[RawTrajectory(**raw) for raw in group] for group in inputs["groups"]]
        captured = _native_groups(store, challenger.request, groups, lease, seen)
        samples, directives = [], {}
        for group in captured:
            for values in group:
                check_prompt(values)
                _, context, identity, body, response = values
                samples.append(
                    ChallengerSample(
                        context["id"],
                        context["groupId"],
                        digest_json(body["messages"]),
                        context["policyVersion"],
                        response,
                        identity,
                    )
                )
                directives[context["id"]] = generation[context["taskId"]]
        questions = dict(challenger.objective.questions(samples))
        value = {
            "schemaVersion": 1,
            "kind": "diagevo-fresh-questions",
            "implementation": stage_identity(self),
            "challengerImplementation": stage_identity(challenger),
            "requestDigest": digest_json(challenger.request),
            "prompt": self.prompt.describe().to_dict(),
            "objective": challenger.objective.describe().to_dict(),
            "input": inputs,
            "questions": questions,
            "generation": json_value({key: asdict(directives[key]) for key in questions}),
            "solverIdentity": json_value(next(iter(solver_identities)))
            if solver_identities
            else None,
        }
        return value, seen

    def seal(self, groups, *, lease, commit_refs, memory, nodes, generation, solver_policy_id):
        inputs = {
            "groups": [[asdict(raw) for raw in group] for group in groups],
            "lease": deepcopy(lease),
            "commitRefs": deepcopy(commit_refs),
            "memory": json_value([asdict(row) for row in memory]),
            "nodes": json_value([asdict(row) for row in nodes]),
            "generation": json_value({key: asdict(row) for key, row in generation.items()}),
            "solverPolicyId": solver_policy_id,
        }
        return self.store.put_json(self._value(inputs)[0])

    def read(self, ref):
        saved = self.store.read_json(ref)
        value, seen = self._value(saved["input"])
        require(
            saved == value,
            "diagevo-generation-drift",
            "fresh generation evidence or configuration changed",
        )
        return value, seen
