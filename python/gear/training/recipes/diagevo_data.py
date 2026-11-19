"""Bind DiagEvo challenger rewards to native captures and the existing GRPO batch.

The caller supplies authorized CAS artifacts and answer-equivalence decisions.
Content hashes verify integrity, not who produced an artifact or whether an
answer class is mathematically correct. No actor or solver is executed here.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, replace
from pathlib import Path

from gear.core import clone
from gear.core._json import json_value
from gear.training.data import samples as native_samples
from gear.training.data.samples import admit_group, build_episode, seal_batch
from gear.training.recipes import diagevo, diagevo_challenger
from gear.training.recipes.agent_grpo import sampling_params
from gear.training.recipes.diagevo import SolverSample, _text
from gear.training.recipes.diagevo_challenger import ChallengerSample, DiagEvoChallengerReward
from gear.training.runtime.implementation import stage_identity
from gear.training.storage.content import digest_json, require


def _capture(store, raw, seen):
    episode = store.read_json(raw.episode_ref)
    feedback = store.read_json(raw.feedback_ref)
    context = store.read_json(raw.context_ref)
    receipts = [store.read_json(ref) for ref in raw.receipt_refs]
    sample = build_episode(
        store,
        episode,
        receipts,
        feedback,
        context,
        assembly=store.read_json(raw.assembly_ref) if raw.assembly_ref else None,
    )
    require(
        len(receipts) == 1 and receipts[0]["finishReason"] == "stop",
        "diagevo-text-capture-required",
        "this question recipe requires one complete text generation per episode",
    )
    receipt = receipts[0]
    identity = digest_json(asdict(raw))
    for kind, value in (
        ("trajectory", identity),
        ("episode", episode["id"]),
        ("run", episode["runId"]),
        ("receipt", receipt["id"]),
        ("request", receipt["requestId"]),
    ):
        require(
            (kind, value) not in seen,
            "diagevo-reused-capture",
            "independent model responses cannot reuse " + kind,
        )
        seen.add((kind, value))
    request = store.read_json(receipt["rawRequestRef"])
    response = store.read_json(receipt["rawResponseRef"])
    choices = response.get("wire", {}).get("choices", [])
    require(
        isinstance(choices, list)
        and len(choices) == 1
        and choices[0].get("finish_reason") == "stop"
        and isinstance(choices[0].get("message"), dict),
        "diagevo-text-capture-required",
        "native response must have one complete assistant message",
    )
    message = choices[0]["message"]
    agent_request = request.get("agent", {})
    messages = agent_request.get("messages")
    require(
        message.get("role") == "assistant"
        and isinstance(message.get("content"), str)
        and not message.get("tool_calls")
        and isinstance(messages, list)
        and messages
        and all(isinstance(row, dict) and isinstance(row.get("content"), str) for row in messages)
        and messages[-1].get("role") == "user"
        and not agent_request.get("tools")
        and all(row.get("role") in ("system", "developer") for row in messages[:-1]),
        "diagevo-text-capture-required",
        "question and response must come from the captured text exchange",
    )
    return sample, context, identity, agent_request, message["content"]


class DiagEvoChallengerDatasetBuilder:
    """Use full native groups; preserve tokens, masks, behavior policy and feedback.

    ``questions`` validates captures before frozen-solver requests. ``build``
    recomputes votes/rewards, records their evidence, and calls the existing
    ``seal_batch``. The caller closes/seals its policy ledger and invokes the
    existing Slime updater; this class never bypasses that lifecycle.
    """

    stage_id = "gear.diagevo.challenger-dataset:v1"
    source_dependencies = (
        Path(diagevo.__file__),
        Path(diagevo_challenger.__file__),
        Path(native_samples.__file__),
    )
    package_dependencies = ("nltk", "scikit-learn")

    def __init__(self, store, request, *, objective=None):
        self.store = store
        self.request = deepcopy(request)
        self.objective = clone(objective if objective is not None else DiagEvoChallengerReward())
        require(
            request.get("schemaVersion") == 2
            and request["trainer"].get("recipe", "agent-grpo-v1") == "agent-grpo-v1"
            and request["rollout"]["zeroVarianceGroup"] == "keep"
            and request["rollout"]["groupSize"] == self.objective.group_size,
            "diagevo-training-contract",
            "challenger needs v2 GRPO, matching group size, and zeroVarianceGroup=keep",
        )
        sampling_params(request["rollout"])

    def _challengers(self, groups, lease, seen):
        request = self.request
        require(
            lease.get("state") == "closed"
            and lease.get("trainingRunId") == request["trainingRunId"]
            and lease.get("samplingDigest") == digest_json(sampling_params(request["rollout"]))
            and len(groups) == request["trainer"]["rolloutBatchSize"],
            "diagevo-batch-not-ready",
            "challenger needs the full batch under its closed training lease",
        )
        tasks = {task["id"]: task for task in request["trainDataset"]["tasks"]}
        policy = request["parentModel"]
        native, challengers, group_ids = [], [], set()
        for group in groups:
            built = []
            for raw in group:
                sample, context, identity, body, response = _capture(self.store, raw, seen)
                task = tasks.get(context["taskId"])
                require(
                    task is not None
                    and context["taskRef"] == task["taskRef"]
                    and context["environmentRef"] == task["environmentRef"]
                    and context["harnessRef"] == request["fixedHarness"]["manifestRef"]
                    and context["verifierVersion"] == request["verifier"]["digest"]
                    and context["trainingRunId"] == request["trainingRunId"]
                    and context["batchId"] == lease["batchId"]
                    and context["policyVersion"] == lease["policyVersion"]
                    and context["runtimeInstanceId"] == lease["runtimeInstanceId"]
                    and context["tokenizerDigest"] == policy["tokenizerDigest"]
                    and context["chatTemplateDigest"] == policy["chatTemplateDigest"]
                    and context["sampling"] == sampling_params(request["rollout"])
                    and context["maxContextTokens"]
                    <= request["rollout"]["sampling"]["maxContextTokens"]
                    and context["maxEpisodeSteps"] <= request["budgets"]["maxEpisodeSteps"],
                    "diagevo-challenger-context-drift",
                    "challenger capture differs from the authorized task, runtime or policy",
                )
                built.append(sample)
                challengers.append(
                    ChallengerSample(
                        context["id"],
                        context["groupId"],
                        digest_json(body["messages"]),
                        context["policyVersion"],
                        response,
                        identity,
                    )
                )
            admit_group(built, self.objective.group_size, "keep")
            group_id = built[0].metadata["groupId"]
            require(
                group_id not in group_ids,
                "diagevo-reused-group",
                "challenger batches cannot repeat a group identity",
            )
            group_ids.add(group_id)
            native.append(built)
        self.objective.questions(challengers)
        return tuple(challengers), native

    def questions(self, groups, *, lease):
        challengers, _ = self._challengers(groups, lease, set())
        return self.objective.questions(challengers)

    def build(self, groups, *, lease, solver_policy_id, solver_trajectories, answer_classes_ref):
        seen = set()
        challengers, native = self._challengers(groups, lease, seen)
        questions = dict(self.objective.questions(challengers))
        require(
            set(solver_trajectories) == set(questions)
            and (not questions or _text(solver_policy_id)),
            "diagevo-solver-coverage",
            "valid questions need complete construction captures and an explicit frozen solver",
        )
        classification = self.store.read_json(answer_classes_ref)
        require(
            isinstance(classification, dict)
            and set(classification) == {"schemaVersion", "kind", "classifier", "labels"}
            and classification["schemaVersion"] == 1
            and classification["kind"] == "diagevo-answer-classes"
            and isinstance(classification["classifier"], dict)
            and bool(classification["classifier"])
            and isinstance(classification["labels"], list),
            "diagevo-answer-evidence",
            "answer equivalence requires a sealed classifier identity and complete labels",
        )
        labels = {}
        for label in classification["labels"]:
            require(
                isinstance(label, dict)
                and set(label) == {"trajectoryDigest", "answerKey", "evidenceRef"}
                and _text(label["trajectoryDigest"])
                and _text(label["answerKey"])
                and label["trajectoryDigest"] not in labels,
                "diagevo-answer-evidence",
                "answer labels must uniquely bind native trajectories",
            )
            self.store.read_bytes(label["evidenceRef"])
            labels[label["trajectoryDigest"]] = label["answerKey"]

        votes, consumed, solver_policies = [], set(), set()
        evidence = [ref for group in groups for raw in group for ref in raw.refs()]
        for question_id, question in questions.items():
            answers = []
            for raw in solver_trajectories[question_id]:
                _, context, identity, body, _ = _capture(self.store, raw, seen)
                require(
                    body["messages"][-1]["content"] == question and identity in labels,
                    "diagevo-solver-question-drift",
                    "solver must answer the exact generated question and have a bound answer class",
                )
                consumed.add(identity)
                solver_policies.add(
                    (
                        *(
                            context[key]
                            for key in (
                                "policyVersion",
                                "runtimeInstanceId",
                                "tokenizerDigest",
                                "chatTemplateDigest",
                            )
                        ),
                        digest_json(context["sampling"]),
                        digest_json(body["messages"][:-1]),
                    )
                )
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
                evidence.extend(raw.refs())
            votes.append(self.objective.policy.construction(answers))
        require(
            consumed == set(labels)
            and len(solver_policies) <= 1
            and all(identity[0] == solver_policy_id for identity in solver_policies),
            "diagevo-solver-policy-drift",
            "all and only construction captures must use one frozen solver identity",
        )
        rewards = self.objective.score(challengers, votes)
        proof = self.store.put_json(
            {
                "schemaVersion": 1,
                "kind": "diagevo-challenger-rewards",
                "implementation": stage_identity(self),
                "objective": self.objective.describe().to_dict(),
                "trainingRunId": self.request["trainingRunId"],
                "recipeDigest": self.request["recipeDigest"],
                "datasetSplitDigest": self.request["datasetSplitDigest"],
                "lease": lease,
                "solverPolicyId": solver_policy_id,
                "groups": [[asdict(raw) for raw in group] for group in groups],
                "solverTrajectories": {
                    key: [asdict(raw) for raw in solver_trajectories[key]] for key in questions
                },
                "answerClassesRef": answer_classes_ref,
                "rewards": json_value([asdict(row) for row in rewards]),
            }
        )
        by_id = {row.sample.sample_id: row for row in rewards}
        scored = [
            [
                replace(
                    sample,
                    reward=by_id[sample.metadata["episodeId"]].reward,
                    metadata={
                        **sample.metadata,
                        "originalVerifierReward": sample.reward,
                        "rewardSource": "diagevo-challenger-v1",
                        "curriculumRewardRef": proof,
                    },
                )
                for sample in group
            ]
            for group in native
        ]
        return seal_batch(self.store, scored, self.request, lease, [*evidence, proof])
