"""Pure synthetic capacity probe using the real GEPA ranking and decision policies."""

import json
from dataclasses import asdict

from gear.algorithms import GEPA, AlgorithmState, Decision, RankingInput
from gear.algorithms.gepa.ranking import rank_candidates
from gear.canonical import digest


class CapacityProbe:
    def step(self, view, state):
        # Normalize tuple dataclass fields to their exact JSON wire representation.
        projection = json.loads(
            json.dumps({"view": asdict(view), "state": asdict(state)})
        )
        ranking = rank_candidates(
            RankingInput(
                tuple(candidate.id for candidate in view.candidates),
                tuple(task.id for task in view.tasks),
                view.evidence,
                view.budget.repetitions,
                objective=view.objective,
                anchor_id=view.anchor_id,
            )
        )
        decision = GEPA().step(view, state)
        return Decision(
            AlgorithmState(
                data={
                    # A full JSON string exercises a large response without making generic Json
                    # union validation of every nested verifier node the test's bottleneck.
                    "projection_json": json.dumps(
                        projection, ensure_ascii=False, separators=(",", ":")
                    ),
                    "projection_digest": digest(projection),
                    "ranking": json.loads(json.dumps(asdict(ranking))),
                    "gepa_decision": json.loads(json.dumps(asdict(decision))),
                }
            ),
            decision.operations,
            "complete capacity projection verified",
        )
