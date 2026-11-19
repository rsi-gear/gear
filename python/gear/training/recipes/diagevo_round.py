"""Caller-owned, recoverable DiagEvo memory maintenance for one solver round.

This composes the diagnostic operators and joint state transition. It does not
sample responses, update model weights, or authenticate native training captures.
The two model-specific conversions are ordinary caller functions, not adapters
in curriculum. Unknown external outcomes are reconciled before any resubmission.
"""

from __future__ import annotations

import copy
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from gear.canonical import JSON, digest
from gear.core import clone
from gear.core._json import json_object, json_value
from gear.curriculum import ModelInput
from gear.training.contracts import TrainingContext
from gear.training.recipes import diagevo, diagevo_memory
from gear.training.recipes.diagevo import (
    Cause,
    ConstructionVote,
    DiagEvoPolicy,
    FailureAttribution,
    GenerationDirective,
    OptimizationGroup,
    _memory,
    _text,
)
from gear.training.recipes.diagevo_memory import (
    DiagEvoDiagnostician,
    DiagnosisPair,
    SkillNode,
    _nodes,
)
from gear.training.runtime.implementation import stage_identity
from gear.training.storage.loop_journal import _MISSING, _read, _write
from gear.training.storage.state import lock

ModelCall = Callable[[str, ModelInput], Awaitable[JSON]]
EmbeddingCall = Callable[[str, str], Awaitable[Sequence[float]]]
# completed: {state, output}; not_submitted/unknown: {state}. Only the backend
# can authoritatively prove not_submitted; a network error is always unknown.
RecoverCall = Callable[[str], Awaitable[dict[str, JSON]]]


@dataclass(frozen=True)
class RoundEvidence:
    votes: tuple[ConstructionVote, ...]
    generation: dict[str, GenerationDirective]
    groups: tuple[OptimizationGroup, ...]
    questions: dict[str, str]
    trajectory_texts: dict[str, str]


def _freeze(path: Path, value: dict[str, JSON]) -> None:
    old = _read(path)
    if old is not _MISSING and old != value:
        raise ValueError("frozen DiagEvo round artifact changed: " + str(path))
    if old is _MISSING:
        _write(path, value)


def _saved_calls(root: Path, round_digest: str) -> tuple[set[str], dict[str, JSON]]:
    intents = {path.parent.name: path for path in (root / "calls").glob("*/intent.json")}
    results = {path.parent.name: path for path in (root / "calls").glob("*/result.json")}
    if not set(results) <= set(intents):
        raise ValueError("external result has no original submission intent")
    completed: dict[str, JSON] = {}
    for key, path in intents.items():
        intent = _read(path)
        if (
            intent is _MISSING
            or set(intent) != {"key", "round_digest", "kind", "label", "input"}
            or intent["key"] != key
            or intent["round_digest"] != round_digest
            or intent["kind"] not in ("diagnosis", "embedding")
            or digest({k: v for k, v in intent.items() if k != "key"}).removeprefix("sha256:")
            != key
        ):
            raise ValueError("external submission intent changed")
        if key in results:
            saved = _read(results[key])
            if (
                saved is _MISSING
                or set(saved) != {"request_digest", "output_digest", "output"}
                or saved["request_digest"] != digest(intent)
                or saved["output_digest"] != digest(saved["output"])
            ):
                raise ValueError("external call result changed")
            completed[key] = digest(saved)
    return set(intents), completed


class DiagEvoMemoryUpdater:
    """Run after solver optimization with its original construction evidence.

    ``diagnose(key, ModelInput)`` returns the parsed model JSON;
    ``embed(key, text)`` returns one vector. Each recovery function inspects the
    exact original key and returns completed/output, not_submitted, or unknown.
    Backend identities must include actual model/configuration versions. Native
    IDs, authorization, token/cost receipts and transport recovery stay there.
    """

    stage_id = "gear.diagevo.memory-update:v1"
    source_dependencies = (Path(diagevo.__file__), Path(diagevo_memory.__file__))

    def __init__(
        self,
        *,
        diagnose: ModelCall,
        embed: EmbeddingCall,
        recover_diagnosis: RecoverCall,
        recover_embedding: RecoverCall,
        diagnosis_identity: dict[str, JSON],
        embedding_identity: dict[str, JSON],
        policy: DiagEvoPolicy | None = None,
        diagnostician: DiagEvoDiagnostician | None = None,
        max_diagnoses: int = 256,
        max_embeddings: int = 256,
    ) -> None:
        if (
            not diagnosis_identity
            or not embedding_identity
            or any(type(n) is not int or n < 1 for n in (max_diagnoses, max_embeddings))
            or not all(callable(f) for f in (diagnose, embed, recover_diagnosis, recover_embedding))
        ):
            raise ValueError(
                "explicit backend identities, recovery functions and budgets are required"
            )
        self.diagnose, self.embed = diagnose, embed
        self.recover_diagnosis, self.recover_embedding = recover_diagnosis, recover_embedding
        self.diagnosis_identity = json_object(diagnosis_identity)
        self.embedding_identity = json_object(embedding_identity)
        self.policy = policy or DiagEvoPolicy()
        self.diagnostician = diagnostician or DiagEvoDiagnostician()
        self.max_diagnoses, self.max_embeddings = max_diagnoses, max_embeddings

    @staticmethod
    def _inputs(
        evidence: RoundEvidence,
        memory: Sequence[Cause],
        nodes: Sequence[SkillNode],
        policy: DiagEvoPolicy,
    ) -> tuple[Cause, ...]:
        _nodes(nodes, memory)
        # Recompute votes, validate complete pool coverage, groups and promotion
        # before the first paid call. No proposed diagnostic state is committed.
        promoted = policy.update(
            memory,
            votes=evidence.votes,
            generation=dict(evidence.generation),
            groups=evidence.groups,
            attributions=(),
        )
        if set(evidence.questions) != {vote.question_id for vote in evidence.votes} or any(
            not _text(text) for text in evidence.questions.values()
        ):
            raise ValueError("question text must cover the complete construction pool")
        required, references = set(), set()
        old_failures = {key for cause in memory for key in cause.failure_ids}
        for group in evidence.groups:
            for sample, reward in zip(group.samples, group.rewards, strict=True):
                if reward >= 0:
                    continue
                if sample.sample_id in old_failures:
                    raise ValueError("a previous failure cannot be counted in another round")
                required.add(sample.trajectory_ref)
                reference = next(
                    item.trajectory_ref
                    for item in group.vote.samples
                    if item.sample_id == group.vote.reference_sample_id
                )
                required.add(reference)
                references.add(reference)
        if (
            set(evidence.trajectory_texts) != required
            or any(not isinstance(text, str) for text in evidence.trajectory_texts.values())
            or any(not _text(evidence.trajectory_texts[ref]) for ref in references)
        ):
            raise ValueError("diagnostic text must cover exactly the failed and reference captures")
        return promoted

    @staticmethod
    def verify(workspace: Path, *, operation_id: str) -> dict[str, JSON]:
        """Check the saved round and every call before reusing a completed stage."""
        root = Path(workspace) / "diagevo-memory"
        identity, result = _read(root / "input.json"), _read(root / "result.json")
        if (
            identity is _MISSING
            or result is _MISSING
            or set(result) != {"input_digest", "output_digest", "output", "calls"}
            or identity.get("operation_id") != operation_id
            or result.get("input_digest") != digest(identity)
            or result.get("output_digest") != digest(result.get("output"))
        ):
            raise ValueError("completed memory update has missing or changed identity/result")
        records = result.get("calls")
        if not isinstance(records, dict):
            raise ValueError("completed memory update is missing its call manifest")
        intents, completed = _saved_calls(root, digest(identity))
        if intents != set(records) or completed != records:
            raise ValueError("completed memory update has missing, changed or extra call evidence")
        return json_object(result["output"])

    async def update(
        self,
        ctx: TrainingContext,
        evidence: RoundEvidence,
        *,
        memory: Sequence[Cause],
        nodes: Sequence[SkillNode],
    ) -> dict[str, JSON]:
        # Snapshot ordinary caller inputs before yielding to external models.
        evidence, memory, nodes = copy.deepcopy((evidence, tuple(memory), tuple(nodes)))
        policy, diagnostician = clone(self.policy), clone(self.diagnostician)
        promoted = self._inputs(evidence, memory, nodes, policy)
        diagnostician._parameters()
        identity = {
            "operation_id": ctx.operation_id,
            "round_index": ctx.round_index,
            "checkpoint": json_value(ctx.checkpoint),
            "history_digest": digest(json_value(ctx.history)),
            "parameters": json_value(ctx.config.parameters),
            "implementation": stage_identity(self),
            "policy": policy.describe().to_dict(),
            "diagnostician": diagnostician.describe().to_dict(),
            "diagnosis_backend": self.diagnosis_identity,
            "embedding_backend": self.embedding_identity,
            "budgets": {"diagnosis": self.max_diagnoses, "embedding": self.max_embeddings},
            "evidence": json_value(evidence),
            "memory": json_value(memory),
            "nodes": json_value(nodes),
        }
        identity = json_object(identity)
        root = Path(ctx.workspace) / "diagevo-memory"
        with lock(root / "update.lock", blocking=False):
            if _read(root / "input.json") is _MISSING and (
                (root / "result.json").exists() or any((root / "calls").glob("*/*.json"))
            ):
                raise ValueError("memory update lost its original input identity")
            _freeze(root / "input.json", identity)
            _saved_calls(root, digest(identity))
            if (root / "result.json").exists():
                self.verify(ctx.workspace, operation_id=ctx.operation_id)
            return await self._run(
                ctx, root, identity, evidence, memory, nodes, promoted, policy, diagnostician
            )

    async def _run(
        self,
        ctx: TrainingContext,
        root: Path,
        identity: dict[str, JSON],
        evidence: RoundEvidence,
        memory: tuple[Cause, ...],
        nodes: tuple[SkillNode, ...],
        current: tuple[Cause, ...],
        policy: DiagEvoPolicy,
        diagnostician: DiagEvoDiagnostician,
    ) -> dict[str, JSON]:
        round_digest = digest(identity)
        calls: dict[str, JSON] = {}
        model_call, embedding_call = self.diagnose, self.embed
        recover_model, recover_embedding = self.recover_diagnosis, self.recover_embedding
        budgets = cast(dict[str, int], identity["budgets"])

        async def external(kind: str, label: str, payload: JSON) -> tuple[JSON, str]:
            body = {"round_digest": round_digest, "kind": kind, "label": label, "input": payload}
            key = digest(body).removeprefix("sha256:")
            intent = {"key": key, **body}
            directory = root / "calls" / key
            prior, saved = _read(directory / "intent.json"), _read(directory / "result.json")
            if prior is not _MISSING and prior != intent:
                raise ValueError("external call identity changed")
            if saved is not _MISSING:
                if (
                    prior is _MISSING
                    or saved.get("request_digest") != digest(intent)
                    or saved.get("output_digest") != digest(saved.get("output"))
                ):
                    raise ValueError("external result differs from its original intent")
                calls[key] = digest(saved)
                return saved["output"], "diagevo-call/" + key
            if prior is not _MISSING:
                recovery = recover_model if kind == "diagnosis" else recover_embedding
                recovered = json_object(await recovery(key))
                if recovered.get("state") == "completed" and set(recovered) == {"state", "output"}:
                    output = recovered["output"]
                    saved = {
                        "request_digest": digest(intent),
                        "output_digest": digest(output),
                        "output": output,
                    }
                    _freeze(directory / "result.json", saved)
                    calls[key] = digest(saved)
                    return output, "diagevo-call/" + key
                if recovered != {"state": "not_submitted"}:
                    raise RuntimeError(
                        "unknown external outcome; reconcile the original call before resubmitting"
                    )
            else:
                limit = budgets[kind]
                existing = [_read(path) for path in (root / "calls").glob("*/intent.json")]
                if (
                    sum(row is not _MISSING and row.get("kind") == kind for row in existing)
                    >= limit
                ):
                    raise RuntimeError("DiagEvo " + kind + " call budget exhausted")
                _freeze(directory / "intent.json", intent)
            if kind == "diagnosis":
                value = cast(dict[str, Any], payload)
                output = await model_call(key, ModelInput(**copy.deepcopy(value)))
            else:
                output = json_value(await embedding_call(key, cast(str, payload)))
            output = json_value(output)
            saved = {
                "request_digest": digest(intent),
                "output_digest": digest(output),
                "output": output,
            }
            _freeze(directory / "result.json", saved)
            calls[key] = digest(saved)
            return output, "diagevo-call/" + key

        async def diagnose(label: str, request: ModelInput) -> tuple[JSON, str]:
            return await external("diagnosis", label, json_value(request))

        async def embedding(text: str) -> tuple[float, ...]:
            value, _ = await external("embedding", digest(text), text)
            if not isinstance(value, list):
                raise ValueError("embedding backend must return a vector")
            # cause_similarities/merge_candidates perform numeric/dimension checks.
            return cast(tuple[float, ...], tuple(value))

        attributions: list[FailureAttribution] = []
        unattributed: list[str] = []
        node_map = {node.node_id: node for node in nodes}
        failures = sorted(
            (
                (sample.sample_id, group, sample)
                for group in evidence.groups
                for sample, reward in zip(group.samples, group.rewards, strict=True)
                if reward < 0
            ),
            key=lambda row: row[0],
        )
        for sample_id, group, sample in failures:
            reference = next(
                item
                for item in group.vote.samples
                if item.sample_id == group.vote.reference_sample_id
            )
            pair = DiagnosisPair(
                group,
                sample_id,
                evidence.questions[group.vote.question_id],
                evidence.trajectory_texts[reference.trajectory_ref],
                evidence.trajectory_texts[sample.trajectory_ref],
                evidence.generation[group.vote.question_id],
            )
            request = diagnostician.prepare_extraction(pair, policy=policy, memory=memory)
            response, extraction_ref = await diagnose("extract/" + sample_id, request)
            extracted = diagnostician.parse_extraction(
                response, pair=pair, policy=policy, memory=memory
            )
            matched = _memory(current).get(extracted.matched_cause_id or "")
            refs = [*extracted.evidence_refs, extraction_ref]
            if extracted.error_cause is not None:
                description = extracted.error_cause
                similarities = (
                    diagnostician.cause_similarities(
                        current,
                        query_embedding=await embedding(description),
                        cause_embeddings={
                            cause.cause_id: await embedding(cause.description) for cause in current
                        },
                    )
                    if current
                    else {}
                )
                if any(
                    score > diagnostician.duplicate_threshold for score in similarities.values()
                ):
                    request = diagnostician.prepare_deduplication(
                        description, memory=current, similarities=similarities
                    )
                    response, ref = await diagnose("deduplicate/" + sample_id, request)
                    refs.append(ref)
                    matched = diagnostician.parse_deduplication(
                        response, description=description, memory=current, similarities=similarities
                    )
                if matched is None:
                    request = diagnostician.prepare_assignment(
                        description,
                        nodes=tuple(node_map.values()),
                        memory=current,
                        similarities=similarities,
                    )
                    response, ref = await diagnose("assign/" + sample_id, request)
                    refs.append(ref)
                    identifier = digest([round_digest, sample_id, description]).removeprefix(
                        "sha256:"
                    )
                    node = diagnostician.parse_assignment(
                        response,
                        description=description,
                        nodes=tuple(node_map.values()),
                        memory=current,
                        similarities=similarities,
                        new_node_id="node-" + identifier,
                    )
                    node_map[node.node_id] = node
                    attributions.append(
                        FailureAttribution(
                            sample_id, "cause-" + identifier, node.node_id, description, tuple(refs)
                        )
                    )
            if matched is not None:
                attributions.append(
                    FailureAttribution(
                        sample_id,
                        matched.cause_id,
                        matched.node_id,
                        matched.description,
                        tuple(refs),
                    )
                )
            elif extracted.error_cause is None:
                unattributed.append(sample_id)
            # Recompute from the original round once per prefix. Earlier diagnostic
            # decisions are visible to deduplication without incrementing them twice.
            current = policy.update(
                memory,
                votes=evidence.votes,
                generation=dict(evidence.generation),
                groups=evidence.groups,
                attributions=attributions,
            )

        candidates = (
            diagnostician.merge_candidates(
                tuple(node_map.values()),
                memory=current,
                node_embeddings={
                    key: await embedding(node_map[key].label) for key in sorted(node_map)
                },
            )
            if len(node_map) > 1
            else ()
        )
        aliases = {key: key for key in node_map}
        seen_pairs = set()
        for left, right in candidates:
            left, right = aliases[left], aliases[right]
            if left == right:
                continue
            request = diagnostician.prepare_consolidation(
                left, right, nodes=tuple(node_map.values()), memory=current
            )
            pair_identity = digest(json_value(request))
            if pair_identity in seen_pairs:
                continue
            seen_pairs.add(pair_identity)
            response, _ = await diagnose("consolidate/" + pair_identity, request)
            merged_nodes, current = diagnostician.parse_consolidation(
                response,
                left=left,
                right=right,
                nodes=tuple(node_map.values()),
                memory=current,
            )
            node_map = {node.node_id: node for node in merged_nodes}
            if len({left, right}.intersection(node_map)) == 1:
                survivor = min(left, right)
                aliases = {
                    key: survivor if value in (left, right) else value
                    for key, value in aliases.items()
                }
        output = json_object(
            {
                "memory": current,
                "nodes": tuple(node_map[key] for key in sorted(node_map)),
                "attributions": attributions,
                "unattributed_sample_ids": unattributed,
                "merge_candidates": candidates,
            }
        )
        _freeze(
            root / "result.json",
            {
                "input_digest": round_digest,
                "output_digest": digest(output),
                "output": output,
                "calls": calls,
            },
        )
        self.verify(ctx.workspace, operation_id=ctx.operation_id)
        return output
