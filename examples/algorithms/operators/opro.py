"""One OPRO-style prompt update using explicit evidence and exact edits.

This is an authoring example, not a reproduction of OPRO's search schedule.
Use a Pi project and a small seed scope. The independent Gear gate owns release.
"""

from gear.canonical import digest
from gear.core import (
    ArtifactInput,
    CandidateRef,
    EditPlan,
    FileContent,
    FileEdit,
    MaterializeCandidate,
    MaterializeInput,
    Meta,
    MetaInput,
    ReadArtifact,
)
from gear.evaluation import (
    CompareCandidates,
    ComparisonInput,
    ComparisonPlan,
    Evaluate,
    EvidenceSet,
    ExecutionInput,
    SamplePlan,
    TaskSamples,
)
from gear.search import Algorithm, Decision, Terminal


class PromptSearch(Algorithm):
    def __init__(
        self,
        proposer=None,
        reader=None,
        editor=None,
        evaluator=None,
        ranker=None,
        confirmation=False,
    ):
        self.proposer = (
            proposer
            if proposer is not None
            else Meta(
                "Improve the authorized AGENTS.md prompt using the supplied scored history. "
                "Return its complete replacement text. Preserve the target interface.",
                {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
            )
        )
        self.reader = (
            reader if reader is not None else ReadArtifact(max_bytes=1024 * 1024)
        )
        self.editor = editor if editor is not None else MaterializeCandidate()
        self.evaluator = evaluator if evaluator is not None else Evaluate()
        self.ranker = ranker if ranker is not None else CompareCandidates()
        self.confirmation = confirmation

    def step(self, view, state):
        phase = state.data.get("phase", 0)
        tasks = tuple(
            TaskSamples(task.id, tuple(range(view.budget["repetitions"])))
            for task in view.tasks
        )
        data = {}
        if phase:
            result = view.results.require(state.data["pending"])
            if result.status != "succeeded":
                return Decision(
                    state,
                    reason="effect failed",
                    terminal=Terminal("stop", outcome=result.error),
                )
        if phase == 0:
            call = self.evaluator(
                ExecutionInput(view.anchor, SamplePlan(tasks)), key="baseline"
            )
        elif phase == 1:
            evidence = EvidenceSet.from_dict(result.value)
            if not evidence.loaded:
                return Decision(
                    state,
                    reason="example needs a smaller seed scope",
                    terminal=Terminal("stop"),
                )
            data["baseline"] = result.value
            call = self.reader(
                ArtifactInput(view.anchor, "AGENTS.md"), key="prompt-source"
            )
        elif phase == 2:
            if not result.value["complete"]:
                return Decision(
                    state,
                    reason="example needs a prompt below 1 MiB",
                    terminal=Terminal("stop"),
                )
            data["original_digest"] = result.value["content_digest"]
            baseline = EvidenceSet.from_dict(state.data["baseline"])
            call = self.proposer(
                MetaInput(
                    view.anchor,
                    tuple(task.id for task in view.tasks),
                    (baseline.ref,),
                    {
                        "history": [
                            {"candidate": view.anchor, "evidence_set": baseline.ref}
                        ]
                    },
                ),
                key="propose",
            )
        elif phase == 3:
            call = self.editor(
                MaterializeInput(
                    view.anchor,
                    EditPlan(
                        (
                            FileEdit(
                                "replace",
                                "AGENTS.md",
                                state.data["original_digest"],
                                FileContent(result.value["text"]),
                            ),
                        )
                    ),
                ),
                key="materialize",
            )
        elif phase == 4:
            candidate = CandidateRef(**result.value["candidate"])
            data["candidate"] = candidate
            call = self.evaluator(
                ExecutionInput(candidate, SamplePlan(tasks)), key="candidate-evidence"
            )
        elif phase in (5, 7):
            candidate = CandidateRef(**state.data["candidate"])
            baseline = EvidenceSet.from_dict(state.data["baseline"])
            evidence = EvidenceSet.from_dict(result.value)
            plan = ComparisonPlan(
                (view.anchor, candidate),
                (baseline.ref, evidence.ref),
                baseline.spec.task_weights,
                tasks,
                digest(view.objective),
            )
            ranking = self.ranker(
                ComparisonInput(plan, (baseline, evidence), view.objective, view.anchor)
            )
            scores = dict(ranking.scores)
            improved = (
                not ranking.incomplete
                and not ranking.unloaded
                and not ranking.ineligible
                and scores.get(candidate.candidate_id, float("-inf"))
                > scores.get(view.anchor.candidate_id, float("inf"))
            )
            if not improved:
                return Decision(
                    state,
                    reason="no complete common-scope improvement",
                    terminal=Terminal("stop"),
                )
            if phase == 5 and self.confirmation:
                # A new plan for each candidate. These samples never overwrite the initial set.
                call = self.evaluator(
                    ExecutionInput(
                        view.anchor, SamplePlan(tasks, mode="fresh", plan_id=None)
                    ),
                    key="confirm-baseline",
                )
                data["initial_candidate_evidence"] = evidence.ref
            else:
                return Decision(
                    state,
                    reason="explicit common-scope improvement",
                    terminal=Terminal("nominate", candidate, {"selected": candidate}),
                    records=(
                        {
                            "kind": "internally_selected",
                            "candidate": candidate,
                            "evidence_set": evidence.ref,
                        },
                    ),
                )
        else:
            data["baseline"] = result.value
            candidate = CandidateRef(**state.data["candidate"])
            call = self.evaluator(
                ExecutionInput(
                    candidate, SamplePlan(tasks, mode="fresh", plan_id=None)
                ),
                key="confirm-candidate",
            )
        return Decision(
            state.updated(phase=phase + 1, pending=call.ref, **data),
            (call,),
            "advance prompt search",
        )
