"""Score-guided prompt optimization with explicit, resumable iterations."""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any, cast

from gear.canonical import digest
from gear.core import (
    ApplyInput,
    ArtifactInput,
    ArtifactRef,
    Call,
    CandidateRef,
    EditCheckInput,
    EditPlan,
    FileContent,
    FileEdit,
    MaterializeCandidate,
    MaterializeInput,
    Meta,
    MetaInput,
    ReadArtifact,
    StateTree,
    decode_artifact_pages,
)
from gear.core._json import json_value
from gear.core.artifacts import relative_path
from gear.evaluation import (
    CompareCandidates,
    ComparisonInput,
    ComparisonPlan,
    ComparisonResult,
    Evaluate,
    EvidenceSet,
    ExecutionInput,
    SamplePlan,
    TaskSamples,
)
from gear.search import Algorithm, Decision, ScreenInput, SearchView, Terminal


class OPRO(Algorithm):
    """Optimize a prompt from scored history for ``Project.refine(rounds=N)``.

    Set prompt_path to prompts/system.md for a standard DSH target, or use
    the default AGENTS.md for Pi. All operators can be replaced independently.
    """

    default_confirmation = False

    def __init__(
        self,
        prompt_path: str = "AGENTS.md",
        proposer: Any = None,
        reader: Any = None,
        editor: Any = None,
        evaluator: Any = None,
        ranker: Any = None,
        confirmation: bool | None = None,
    ) -> None:
        self.prompt_path = relative_path(prompt_path)
        self.proposer = (
            proposer
            if proposer is not None
            else Meta(
                "Improve the target's working prompt using the supplied scored history. "
                "Return the complete replacement text for prompt_path. Preserve tool access, "
                "output conventions and task-independent instructions. Learn general rules; "
                "do not embed task IDs, expected answers or benchmark-specific solutions.",
                {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
            )
        )
        self.reader = reader if reader is not None else ReadArtifact(max_bytes=1024 * 1024)
        self.editor = editor if editor is not None else MaterializeCandidate()
        self.evaluator = evaluator if evaluator is not None else Evaluate()
        self.ranker = ranker if ranker is not None else CompareCandidates()
        self.confirmation = self.default_confirmation if confirmation is None else confirmation
        if type(self.confirmation) is not bool:
            raise ValueError("confirmation must be boolean")

    @staticmethod
    def _tasks(view: SearchView) -> tuple[TaskSamples, ...]:
        return tuple(
            TaskSamples(task.id, tuple(range(cast(int, view.budget["repetitions"]))))
            for task in view.tasks
        )

    @staticmethod
    def _call(state: StateTree, phase: str, call: Call[Any], **values: Any) -> Decision:
        return Decision(state.updated(phase=phase, pending=call.ref, **values), (call,), phase)

    def _read(self, state: StateTree) -> Decision:
        data = cast(dict[str, Any], state.data)
        return self._call(
            state,
            "read",
            self.reader(
                ArtifactInput(CandidateRef(**data["current"]), self.prompt_path),
                key=f"round-{data['round']}/read/0",
            ),
            pages=[],
        )

    def _proposal(self, value: dict[str, Any], data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        text = value["text"]
        if not isinstance(text, str) or not text.strip():
            raise ValueError("proposed prompt must contain nonempty text")
        return text, {}

    def _compare(
        self, view: SearchView, data: dict[str, Any], evidence: dict[str, Any]
    ) -> ComparisonResult:
        values = {}
        for value in (data["anchor_evidence"], data["current_evidence"], evidence):
            item = EvidenceSet.from_dict(value)
            values[item.spec.candidate.candidate_id] = item
        for value in data.get("confirmation_evidence", {}).values():
            item = EvidenceSet.from_dict(value)
            values[item.spec.candidate.candidate_id] = item
        sets = tuple(values.values())
        plan = ComparisonPlan(
            tuple(item.spec.candidate for item in sets),
            tuple(item.ref for item in sets),
            sets[0].spec.task_weights,
            self._tasks(view),
            digest(view.objective),
        )
        return cast(
            ComparisonResult, self.ranker(ComparisonInput(plan, sets, view.objective, view.anchor))
        )

    @staticmethod
    def _improved(result: ComparisonResult, data: dict[str, Any]) -> bool:
        scores = dict(result.scores)
        child, parent = data["candidate"]["candidate_id"], data["current"]["candidate_id"]
        unavailable = set(result.incomplete + result.unloaded)
        return (
            not unavailable.intersection((child, parent))
            and child not in result.ineligible
            and child in scores
            # Complete evidence can disqualify a parent without giving it a score.
            # Any eligible child improves on that constraint-failing parent.
            and (
                parent in result.ineligible or (parent in scores and scores[child] > scores[parent])
            )
        )

    def _finish_round(
        self,
        view: SearchView,
        state: StateTree,
        evidence: dict[str, Any] | None,
        result: ComparisonResult | None,
        reason: str,
    ) -> Decision:
        data = cast(dict[str, Any], state.data)
        accepted = result is not None and self._improved(result, data)
        history = [
            *data.get("history", []),
            {
                "candidate": data["candidate"],
                "accepted": accepted,
                "reason": reason,
                "scores": list(result.scores) if result else [],
                "evidence": evidence["ref"] if evidence else None,
            },
        ][-8:]
        changes: dict[str, Any] = {"history": history, "round": data["round"] + 1}
        if data.get("confirmation_evidence"):
            changes["anchor_evidence"] = data["confirmation_evidence"][view.anchor.candidate_id]
            changes["current_evidence"] = data["confirmation_evidence"][
                data["current"]["candidate_id"]
            ]
        if accepted:
            changes.update(current=data["candidate"], current_evidence=evidence)
            if "proposed_playbook" in data:
                changes["playbook"] = data["proposed_playbook"]
        next_state = state.updated(**changes, confirmation_evidence={})
        record = {
            "kind": "algorithm_iteration",
            "round": changes["round"],
            "candidate": data["candidate"],
            "accepted": accepted,
            "reason": reason,
        }
        if (
            changes["round"] < cast(int, view.budget["rounds"])
            and cast(int, view.budget["candidates_remaining"]) > 0
        ):
            return replace(self._read(next_state), records=(record,))
        current = CandidateRef(**cast(dict[str, Any], next_state.data)["current"])
        outcome = json_value(
            {"iterations": changes["round"], "selected": current, "history": history}
        )
        terminal = (
            Terminal("stop", outcome=outcome)
            if current == view.anchor
            else Terminal("nominate", current, outcome)
        )
        return Decision(
            next_state,
            reason="configured prompt iterations complete",
            terminal=terminal,
            records=(record,),
        )

    def _confirm(self, view: SearchView, state: StateTree) -> Decision:
        data = cast(dict[str, Any], state.data)
        index = len(data.get("confirmation_evidence", {}))
        candidate = CandidateRef(**data["confirmation_queue"][index])
        return self._call(
            state,
            "confirm",
            self.evaluator(
                ExecutionInput(
                    candidate, SamplePlan(self._tasks(view), mode="fresh", plan_id=None)
                ),
                key=f"round-{data['round']}/confirm/{index}",
            ),
        )

    def step(self, view: SearchView, state: StateTree) -> Decision:
        data = cast(dict[str, Any], state.data)
        phase = data.get("phase", "start")
        if phase == "start":
            if not view.tasks:
                return Decision(state, reason="no admitted tasks", terminal=Terminal("stop"))
            return self._call(
                state,
                "baseline",
                self.evaluator(
                    ExecutionInput(view.anchor, SamplePlan(self._tasks(view))), key="baseline"
                ),
                current=view.anchor,
                round=0,
                history=[],
            )

        if phase == "screen":
            before = FileContent(**data["before"])
            plan = EditPlan(
                (
                    FileEdit(
                        "replace",
                        self.prompt_path,
                        before.digest,
                        FileContent(data["proposed_text"]),
                    ),
                )
            )
            screen = getattr(self, "screen")
            screened = screen(
                ScreenInput(
                    ExecutionInput(
                        CandidateRef(**data["candidate"]), SamplePlan(self._tasks(view))
                    ),
                    EditCheckInput(ApplyInput({self.prompt_path: before}, plan)),
                ),
                view=view,
                state=data.get("screen_state"),
                key=f"round-{data['round']}/screen",
            )
            if not screened.done:
                return Decision(
                    state.updated(screen_state=screened.state),
                    screened.calls,
                    "screen proposed prompt",
                )
            if screened.result.status != "evaluated":
                return self._finish_round(view, state, None, None, screened.result.verdict.reason)
            phase, value = "evaluate", screened.result.evaluation
            state = state.updated(phase=phase)
        else:
            receipt = view.results.require(data["pending"])
            if receipt.status != "succeeded":
                return Decision(
                    state,
                    reason=f"{phase} failed",
                    terminal=Terminal(
                        "stop",
                        outcome=json_value(
                            {
                                "status": "failed",
                                "phase": phase,
                                "error": receipt.error,
                                "iterations": data["round"],
                            }
                        ),
                    ),
                )
            value = receipt.value

        if not isinstance(value, dict):
            raise ValueError("algorithm calls must return object results")
        if phase == "load_evidence":
            pages = [*data["pages"], value]
            if not value["complete"]:
                return self._call(
                    state,
                    phase,
                    self.reader(
                        ArtifactInput(ArtifactRef(**data["evidence_ref"]), cursor=value["cursor"]),
                        key=f"{data['evidence_read_key']}/{len(pages)}",
                    ),
                    pages=pages,
                )
            value = {
                **json.loads(decode_artifact_pages(tuple(pages))),
                "ref": data["evidence_ref"],
                "loaded": True,
            }
            phase = data["resume_phase"]
            state = state.updated(phase=phase, pages=[])
        if phase in ("baseline", "evaluate", "confirm") and not EvidenceSet.from_dict(value).loaded:
            read_key = f"round-{data['round']}/{phase}/evidence/{digest(value['ref'])}"
            return self._call(
                state,
                "load_evidence",
                self.reader(
                    ArtifactInput(ArtifactRef(**value["ref"])),
                    key=f"{read_key}/0",
                ),
                evidence_ref=value["ref"],
                evidence_read_key=read_key,
                resume_phase=phase,
                pages=[],
            )

        if phase == "baseline":
            return self._read(state.updated(anchor_evidence=value, current_evidence=value))
        if phase == "read":
            pages = [*data.get("pages", []), value]
            if not value["complete"]:
                return self._call(
                    state,
                    phase,
                    self.reader(
                        ArtifactInput(
                            CandidateRef(**data["current"]), self.prompt_path, value["cursor"]
                        ),
                        key=f"round-{data['round']}/read/{len(pages)}",
                    ),
                    pages=pages,
                )
            text = decode_artifact_pages(tuple(pages), max_bytes=1024 * 1024).decode("utf-8")
            current = CandidateRef(**data["current"])
            refs = {
                data["current_evidence"]["ref"]["digest"]: ArtifactRef(
                    **data["current_evidence"]["ref"]
                )
            }
            for item in data["history"]:
                if item["evidence"]:
                    refs[item["evidence"]["digest"]] = ArtifactRef(**item["evidence"])
            return self._call(
                state,
                "propose",
                self.proposer(
                    MetaInput(
                        current,
                        tuple(task.id for task in view.tasks),
                        (current, *refs.values()),
                        json_value(
                            {
                                "prompt_path": self.prompt_path,
                                "current_prompt": text,
                                "history": data["history"],
                                "playbook": data.get("playbook", []),
                            }
                        ),
                    ),
                    key=f"round-{data['round']}/propose",
                ),
                before=FileContent(text),
                base_prompt=data.get("base_prompt", text),
                pages=[],
            )
        if phase == "propose":
            text, changes = self._proposal(value, data)
            before = FileContent(**data["before"])
            if text == before.content:
                return self._finish_round(
                    view,
                    state.updated(candidate=data["current"]),
                    data["current_evidence"],
                    None,
                    "proposal leaves the prompt unchanged",
                )
            return self._call(
                state,
                "materialize",
                self.editor(
                    MaterializeInput(
                        CandidateRef(**data["current"]),
                        EditPlan(
                            (
                                FileEdit(
                                    "replace", self.prompt_path, before.digest, FileContent(text)
                                ),
                            )
                        ),
                    ),
                    key=f"round-{data['round']}/materialize",
                ),
                proposed_text=text,
                **changes,
            )
        if phase == "materialize":
            candidate = CandidateRef(**value["candidate"])
            state = state.updated(candidate=candidate)
            if getattr(self, "screen", None) is not None:
                return self.step(view, state.updated(phase="screen", screen_state=None))
            return self._call(
                state,
                "evaluate",
                self.evaluator(
                    ExecutionInput(candidate, SamplePlan(self._tasks(view))),
                    key=f"round-{data['round']}/evaluate",
                ),
            )
        if phase == "evaluate":
            result = self._compare(view, data, value)
            if self.confirmation and self._improved(result, data):
                queue = {
                    item["candidate_id"]: item
                    for item in (
                        cast(dict[str, Any], json_value(view.anchor)),
                        data["current"],
                        data["candidate"],
                    )
                }
                return self._confirm(
                    view,
                    state.updated(
                        confirmation_queue=list(queue.values()),
                        confirmation_evidence={},
                        provisional_evidence=value,
                    ),
                )
            return self._finish_round(view, state, value, result, "common-scope comparison")
        if phase == "confirm":
            evidence = EvidenceSet.from_dict(value)
            confirmed = {
                **data.get("confirmation_evidence", {}),
                evidence.spec.candidate.candidate_id: value,
            }
            state = state.updated(confirmation_evidence=confirmed)
            if len(confirmed) < len(data["confirmation_queue"]):
                return self._confirm(view, state)
            data = cast(dict[str, Any], state.data)
            candidate_evidence = confirmed[data["candidate"]["candidate_id"]]
            return self._finish_round(
                view,
                state,
                candidate_evidence,
                self._compare(view, data, candidate_evidence),
                "independent fresh-sample confirmation",
            )
        raise ValueError("unknown prompt optimization phase")
