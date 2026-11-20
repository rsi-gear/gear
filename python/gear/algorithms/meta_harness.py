"""History-driven harness refinement using Gear's composable Python operators."""

from __future__ import annotations

from typing import Any, cast

from gear.canonical import JSON, digest
from gear.core import (
    ArtifactRef,
    Call,
    CandidateRef,
    GenerateCandidate,
    GenerateInput,
    Meta,
    MetaInput,
    StateTree,
)
from gear.core._json import json_value
from gear.evaluation import (
    CompareCandidates,
    ComparisonInput,
    ComparisonPlan,
    Evaluate,
    EvidenceSet,
    EvidenceSetSpec,
    ExecutionInput,
    ReadEvidence,
    ReadEvidenceInput,
    SamplePlan,
    TaskSamples,
)
from gear.search import Algorithm, Decision, SearchView, Terminal

_DIAGNOSIS_PROMPT = """You are the analysis proposer in the pinned Meta-Harness Terminal-Bench 2 workflow.
Inspect the authorized source of every evaluated seed candidate, including candidates that were
not selected. Use the scores, per-task outcomes, and successful and failed seed trajectories.
Open the supplied source materials to inspect complete candidate files and captured trajectories.
Report missing captures explicitly. Do not infer that missing evidence means a mechanism failed.

Choose any complete evaluated candidate as the implementation base, including a lower-scoring
candidate when its mechanism is useful; do not default to the highest aggregate score. Propose one
general mechanism that may improve the harness across tasks. Do not
encode task answers, task identifiers, hidden tests, or held-out information. Do not edit files in
this step. Return a concise summary, the chosen base_candidate_id, and one actionable hypothesis."""

_DIAGNOSIS_SCHEMA: dict[str, JSON] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "summary": {"type": "string", "minLength": 1},
        "base_candidate_id": {"type": "string", "minLength": 1},
        "hypothesis": {"type": "string", "minLength": 1},
    },
    "required": ["summary", "base_candidate_id", "hypothesis"],
}


class MetaHarness(Algorithm):
    """Adapt the TB2 one-candidate loop to Gear's seed-only Python algorithm API."""

    def __init__(
        self,
        proposer: Any = None,
        generator: Any = None,
        evaluator: Any = None,
        ranker: Any = None,
        evidence_reader: Any = None,
    ) -> None:
        self.proposer = (
            proposer if proposer is not None else Meta(_DIAGNOSIS_PROMPT, _DIAGNOSIS_SCHEMA)
        )
        self.generator = generator if generator is not None else GenerateCandidate()
        self.evaluator = evaluator if evaluator is not None else Evaluate()
        self.ranker = ranker if ranker is not None else CompareCandidates()
        self.evidence_reader = evidence_reader if evidence_reader is not None else ReadEvidence()

    @staticmethod
    def _tasks(view: SearchView) -> tuple[TaskSamples, ...]:
        repetitions = view.budget.get("repetitions", 1)
        if type(repetitions) is not int or repetitions < 1:
            raise ValueError("Meta-Harness requires a positive repetition budget")
        return tuple(TaskSamples(task.id, tuple(range(repetitions))) for task in view.tasks)

    @staticmethod
    def _can_start_candidate(view: SearchView) -> bool:
        candidates = view.budget.get("candidates_remaining", 0)
        requests = view.budget.get("generation_requests_remaining")
        return (
            type(candidates) is int
            and candidates > 0
            and (requests is None or (type(requests) is int and requests > 0))
        )

    @staticmethod
    def _call(state: StateTree, phase: str, call: Call[Any], **values: Any) -> Decision:
        return Decision(state.updated(phase=phase, pending=call.ref, **values), (call,), phase)

    def _evaluate_anchor(self, view: SearchView, state: StateTree) -> Decision:
        return self._call(
            state,
            "baseline",
            self.evaluator(ExecutionInput(view.anchor, SamplePlan(self._tasks(view))), key="baseline"),
            round=0,
        )

    def _comparison(
        self, view: SearchView, evidence_sets: tuple[EvidenceSet, ...]
    ) -> Any:
        if not evidence_sets:
            raise ValueError("Meta-Harness cannot compare an empty evidence set")
        plan = ComparisonPlan(
            tuple(item.spec.candidate for item in evidence_sets),
            tuple(item.ref for item in evidence_sets),
            evidence_sets[0].spec.task_weights,
            self._tasks(view),
            digest(view.objective),
        )
        return self.ranker(ComparisonInput(plan, evidence_sets, view.objective, view.anchor))

    def _entry(
        self,
        view: SearchView,
        candidate: CandidateRef,
        evidence: EvidenceSet,
        anchor_evidence: EvidenceSet | None = None,
    ) -> dict[str, JSON]:
        compared = (
            (evidence,)
            if candidate == view.anchor or anchor_evidence is None
            else (anchor_evidence, evidence)
        )
        result = self._comparison(view, compared)
        score = dict(result.scores).get(candidate.candidate_id)
        complete = (
            candidate.candidate_id not in result.incomplete
            and candidate.candidate_id not in result.unloaded
        )
        return json_value(
            {
                "candidate": candidate,
                "score": score,
                "ineligible": candidate.candidate_id in result.ineligible,
                "complete": complete,
                "evidence_ref": evidence.ref,
                "task_results": [
                    {
                        "task_id": record.task_id,
                        "slot": record.slot,
                        "score": record.score,
                        "status": record.status,
                    }
                    for record in evidence.records
                ],
            }
        )

    @staticmethod
    def _history(state: StateTree) -> list[dict[str, Any]]:
        return cast(list[dict[str, Any]], state.data.get("history", []))

    @staticmethod
    def _remember_trajectories(
        state: StateTree, artifacts: tuple[ArtifactRef, ...]
    ) -> StateTree:
        captured = list(state.data.get("trajectory_artifacts", []))
        known = {item["digest"] for item in captured}
        for artifact in artifacts:
            item = json_value(artifact)
            if (
                item["visibility"] in ("agent", "optimization")
                and item["kind"] == "target_trajectory"
                and item["digest"] not in known
            ):
                captured.append(item)
                known.add(item["digest"])
        return state.updated(trajectory_artifacts=captured)

    @staticmethod
    def _has_authorized_trajectory(artifacts: tuple[ArtifactRef, ...]) -> bool:
        return any(
            artifact.visibility in ("agent", "optimization")
            and artifact.kind == "target_trajectory"
            for artifact in artifacts
        )

    @staticmethod
    def _execution_trajectories(value: dict[str, Any]) -> tuple[ArtifactRef, ...]:
        """Read authorized trajectory refs carried in Execute's result value.

        The runtime omits per-execution artifacts from ``CallResult.artifacts``.
        It returns their references in ``value.executions[*].trajectory``.
        """
        executions = value.get("executions", [])
        if not isinstance(executions, list):
            raise ValueError("Meta-Harness execution records must be a list")
        refs: list[ArtifactRef] = []
        for execution in executions:
            if not isinstance(execution, dict):
                raise ValueError("Meta-Harness execution record must be an object")
            trajectory = execution.get("trajectory")
            if trajectory is None:
                continue
            if not isinstance(trajectory, dict):
                raise ValueError("Meta-Harness trajectory reference must be an object")
            artifact = ArtifactRef(**trajectory)
            if artifact.kind == "target_trajectory" and artifact.visibility in (
                "agent",
                "optimization",
            ):
                refs.append(artifact)
        return tuple(refs)

    def _diagnose(self, view: SearchView, state: StateTree) -> Decision:
        data = state.data
        if not self._can_start_candidate(view):
            return self._finish(view, state, "Meta-Harness generation budget exhausted")
        history = self._history(state)
        complete = [item for item in history if item.get("complete") is True]
        if not complete:
            return self._finish(view, state, "no complete seed evaluations are available")
        candidate_map = {item.candidate_id: item for item in view.candidates}
        offered = [item for item in complete if item["candidate"]["candidate_id"] in candidate_map]
        if len(offered) != len(complete):
            raise ValueError("Meta-Harness history contains a candidate outside the run view")

        # Candidate refs resolve to complete authorized source snapshots. Trajectory refs
        # come from Execute's per-sample result records and remain seed-only.
        sources: list[CandidateRef | ArtifactRef] = [
            CandidateRef(**item["candidate"]) for item in history
        ]
        sources.extend(
            ArtifactRef(**item)
            for item in data.get("trajectory_artifacts", [])
            if item.get("visibility") in ("agent", "optimization")
            and item.get("kind") == "target_trajectory"
        )
        sources = list(
            {(type(item).__name__, item.digest): item for item in sources}.values()
        )
        diagnosis_data = {
            "variant": "Meta-Harness Terminal-Bench 2",
            "round": data["round"],
            "seed_task_ids": [task.id for task in view.tasks],
            "baseline_trajectory_capture": data.get(
                "baseline_trajectory_capture", "not_captured"
            ),
            "eligible_base_candidates": [
                {
                    "candidate_id": item["candidate"]["candidate_id"],
                    "digest": item["candidate"]["digest"],
                    "score": item["score"],
                    "ineligible_for_nomination": item["ineligible"],
                    "task_results": item["task_results"],
                }
                for item in offered
            ],
            "evaluated_candidates": [
                {
                    "candidate_id": item["candidate"]["candidate_id"],
                    "score": item.get("score"),
                    "complete": item.get("complete", False),
                    "status": item.get("status", "complete"),
                    "task_results": item.get("task_results", []),
                }
                for item in history
            ],
            "history_candidate_ids": [item["candidate"]["candidate_id"] for item in history],
            "instruction": "Review the whole seed archive and choose one base and one mechanism.",
        }
        return self._call(
            state,
            "diagnose",
            self.proposer(
                MetaInput(
                    view.anchor,
                    tuple(task.id for task in view.tasks),
                    tuple(sources),
                    json_value(diagnosis_data),
                ),
                key=f"round-{data['round']}/diagnose",
            ),
        )

    def _generate(self, view: SearchView, state: StateTree, diagnosis: dict[str, Any]) -> Decision:
        history = self._history(state)
        eligible = [
            item["candidate"]["candidate_id"]
            for item in history
            if item.get("complete") is True
        ]
        base_id, hypothesis, summary = (
            diagnosis.get("base_candidate_id"),
            diagnosis.get("hypothesis"),
            diagnosis.get("summary"),
        )
        if not isinstance(base_id, str) or base_id not in eligible:
            raise ValueError("Meta-Harness proposer selected a base outside complete seed history")
        if not isinstance(hypothesis, str) or not hypothesis.strip():
            raise ValueError("Meta-Harness proposer returned an empty hypothesis")
        if not isinstance(summary, str) or not summary.strip():
            raise ValueError("Meta-Harness proposer returned an empty summary")
        candidates = {item.candidate_id: item for item in view.candidates}
        base = candidates.get(base_id)
        if base is None:
            raise ValueError("Meta-Harness base candidate is outside the authorized run view")
        return self._call(
            state,
            "generate",
            self.generator(
                GenerateInput(
                    base,
                    hypothesis,
                    tuple(task.id for task in view.tasks),
                    tuple(item for item in view.candidates),
                    json_value(
                        {
                            "variant": "Meta-Harness Terminal-Bench 2",
                            "round": state.data["round"],
                            "base_candidate_id": base_id,
                            "summary": summary,
                            "hypothesis": hypothesis,
                        }
                    ),
                ),
                key=f"round-{state.data['round']}/generate",
            ),
            diagnosis=diagnosis,
        )

    @staticmethod
    def _evidence_key(
        state: StateTree, candidate: CandidateRef, phase: str, page: int
    ) -> str:
        return (
            f"round-{state.data.get('round', 0)}/evidence/"
            f"{phase}/{candidate.candidate_id}/{candidate.digest}/{page}"
        )

    def _read_evidence(
        self,
        state: StateTree,
        evidence: EvidenceSet,
        phase: str,
        artifacts: tuple[ArtifactRef, ...],
    ) -> Decision:
        return self._call(
            state,
            "read_evidence",
            self.evidence_reader(
                ReadEvidenceInput(evidence.spec),
                key=self._evidence_key(
                    state, evidence.spec.candidate, phase, 0
                ),
            ),
            evidence_spec=json_value(evidence.spec),
            pages=[],
            resume_phase=phase,
            candidate=json_value(evidence.spec.candidate),
            evaluation_artifacts=json_value(artifacts),
        )

    def _after_evidence(
        self,
        view: SearchView,
        state: StateTree,
        value: dict[str, Any],
        artifacts: tuple[ArtifactRef, ...],
    ) -> Decision:
        evidence = EvidenceSet.from_dict(value)
        if not evidence.loaded:
            return self._read_evidence(state, evidence, state.data["phase"], artifacts)
        candidate = CandidateRef(
            **cast(dict[str, Any], state.data.get("candidate", json_value(view.anchor)))
        )
        anchor_value = state.data.get("anchor_evidence")
        anchor_evidence = EvidenceSet.from_dict(anchor_value) if isinstance(anchor_value, dict) else None
        entry = self._entry(view, candidate, evidence, anchor_evidence)
        history = [*self._history(state), entry]
        changes: dict[str, Any] = {"history": history}
        state = self._remember_trajectories(state, artifacts)
        if state.data["phase"] == "baseline":
            changes["anchor_evidence"] = json_value(evidence)
            changes["baseline_trajectory_capture"] = (
                "available"
                if self._has_authorized_trajectory(artifacts)
                else "not_captured"
            )
            return self._diagnose(view, state.updated(**changes))
        return self._next_round(view, state.updated(**changes), "configured Meta-Harness iterations complete")

    def _finish(self, view: SearchView, state: StateTree, reason: str) -> Decision:
        history = self._history(state)
        anchor = view.anchor.candidate_id
        complete = [item for item in history if item.get("complete") and item.get("score") is not None]
        if not complete:
            return Decision(state, reason=reason, terminal=Terminal("stop"))
        anchor_entry = next((item for item in complete if item["candidate"]["candidate_id"] == anchor), None)
        candidates = [item for item in complete if not item["ineligible"]]
        if not candidates:
            return Decision(state, reason=reason, terminal=Terminal("stop"))
        best = max(candidates, key=lambda item: (item["score"], item["candidate"]["candidate_id"]))
        improves = anchor_entry is None or anchor_entry["ineligible"] or best["score"] > anchor_entry["score"]
        outcome = json_value(
            {
                "selected": best["candidate"],
                "scores": [
                    (item["candidate"]["candidate_id"], item["score"])
                    for item in complete
                ],
            }
        )
        if not improves or best["candidate"]["candidate_id"] == anchor:
            return Decision(state, reason=reason, terminal=Terminal("stop", outcome=outcome))
        return Decision(state, reason=reason, terminal=Terminal("nominate", CandidateRef(**best["candidate"]), outcome))

    def _next_round(self, view: SearchView, state: StateTree, reason: str) -> Decision:
        next_round = cast(int, state.data.get("round", 0)) + 1
        next_state = state.updated(round=next_round)
        if (
            next_round < cast(int, view.budget.get("rounds", 0))
            and self._can_start_candidate(view)
        ):
            return self._diagnose(view, next_state)
        return self._finish(view, next_state, reason)

    def step(self, view: SearchView, state: StateTree) -> Decision:
        phase = state.data.get("phase", "start")
        if phase == "start":
            if (
                not view.tasks
                or cast(int, view.budget.get("rounds", 0)) < 1
                or not self._can_start_candidate(view)
            ):
                return Decision(
                    state,
                    reason="no seed tasks or Meta-Harness rounds admitted",
                    terminal=Terminal("stop"),
                )
            return self._evaluate_anchor(view, state)

        pending = view.results.require(state.data["pending"])
        if pending.status != "succeeded":
            if phase == "baseline":
                return Decision(
                    state,
                    reason="baseline evaluation failed",
                    terminal=Terminal(
                        "stop",
                        outcome=json_value(
                            {"status": "failed", "phase": phase, "error": pending.error}
                        ),
                    ),
                )
            if phase == "evaluate":
                failed = {
                    "candidate": state.data["candidate"],
                    "score": None,
                    "complete": False,
                    "ineligible": False,
                    "status": "evaluation_failed",
                }
                state = state.updated(history=[*self._history(state), failed])
            return self._next_round(view, state, f"{phase} operation failed")
        value = pending.value
        if phase == "diagnose":
            # OperatorRuntime.settle exposes the Meta payload directly. A declined
            # proposer has no payload, so the public value is null.
            if value is None:
                return self._next_round(view, state, "Meta-Harness proposer declined")
            if not isinstance(value, dict):
                raise ValueError("Meta-Harness diagnosis result must be an object")
            return self._generate(view, state, value)
        if not isinstance(value, dict):
            raise ValueError("Meta-Harness operator result must be an object")

        if phase in ("baseline", "evaluate"):
            artifacts = tuple(ArtifactRef(**item) for item in pending.to_dict()["artifacts"])
            artifacts += self._execution_trajectories(value)
            if phase == "baseline":
                state = state.updated(candidate=json_value(view.anchor))
            return self._after_evidence(view, state, value, artifacts)

        if phase == "read_evidence":
            pages = [*state.data["pages"], value]
            if not value.get("complete"):
                spec_value = cast(dict[str, Any], state.data["evidence_spec"])
                spec = EvidenceSetSpec(
                    CandidateRef(**spec_value["candidate"]),
                    tuple(ArtifactRef(**item) for item in spec_value["assessments"]),
                    tuple(TaskSamples(item["task_id"], tuple(item["slots"])) for item in spec_value["tasks"]),
                    tuple(tuple(item) for item in spec_value["task_weights"]),
                    spec_value["objective_ref"],
                    spec_value["reducer_ref"],
                    spec_value["missing_policy"],
                )
                return self._call(
                    state,
                    "read_evidence",
                    self.evidence_reader(
                        ReadEvidenceInput(spec, value["cursor"]),
                        key=self._evidence_key(
                            state, spec.candidate, state.data["resume_phase"], len(pages)
                        ),
                    ),
                    pages=pages,
                )
            evidence = EvidenceSet.from_pages(tuple(pages))
            candidate = CandidateRef(**state.data["candidate"])
            anchor_evidence = (
                EvidenceSet.from_dict(state.data["anchor_evidence"])
                if state.data.get("anchor_evidence") is not None
                else None
            )
            entry = self._entry(view, candidate, evidence, anchor_evidence)
            state = self._remember_trajectories(
                state, tuple(ArtifactRef(**item) for item in state.data["evaluation_artifacts"])
            ).updated(history=[*self._history(state), entry])
            if state.data["resume_phase"] == "baseline":
                artifacts = tuple(
                    ArtifactRef(**item) for item in state.data["evaluation_artifacts"]
                )
                state = state.updated(
                    anchor_evidence=json_value(evidence),
                    baseline_trajectory_capture=(
                        "available"
                        if self._has_authorized_trajectory(artifacts)
                        else "not_captured"
                    ),
                )
                return self._diagnose(view, state)
            return self._next_round(view, state, "configured Meta-Harness iterations complete")

        if phase == "generate":
            candidate = value.get("candidate")
            if not isinstance(candidate, dict):
                raise ValueError("Meta-Harness generation returned no candidate")
            candidate_ref = CandidateRef(**candidate)
            state = state.updated(candidate=candidate)
            return self._call(
                state,
                "evaluate",
                self.evaluator(
                    ExecutionInput(candidate_ref, SamplePlan(self._tasks(view))),
                    key=f"round-{state.data['round']}/evaluate",
                ),
            )
        raise ValueError("unknown Meta-Harness phase")
