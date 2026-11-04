"""The paper's multi-signal SeedGate as the default seed rule."""

import unittest
from dataclasses import asdict

from gear.algorithms import GEPA, AlgorithmState, Budget, Candidate, Evidence, SearchView, Task
from gear.algorithms.gepa.parents import ScopedFrontier
from gear.algorithms.projection import compare_candidates
from gear.canonical import digest


def configuration(process=None, ranges=False):
    """The default pass-rate objective with declared process groups and their directions."""
    process = {"process_score": "maximize"} if process is None else process
    bounds = {"range": {"min": 0, "max": 1}} if ranges else {}
    return {
        "definition": {
            "terms": [
                {"metric": "pass_rate", "metricContractDigest": "pass", "weight": 1, "scale": 1}
            ],
            "constraints": [],
            "comparisonPrecision": 1e-9,
        },
        "metrics": [
            {
                "id": "pass_rate",
                "digest": "pass",
                "unit": "ratio",
                "direction": "maximize",
                "comparisonPrecision": 1e-9,
                **bounds,
            },
            *(
                {
                    "id": name,
                    "digest": name,
                    "unit": "ratio",
                    "direction": direction,
                    "comparisonPrecision": 1e-9,
                    **bounds,
                }
                for name, direction in process.items()
            ),
        ],
        "protection": [],
        "seed_rule": {"rule": "multisignal-v1", "outcome": "pass_rate", "process": list(process)},
    }


def metric(name, value):
    if value is None:
        return {"contractDigest": name, "unit": "ratio", "status": "missing", "evidenceRefs": []}
    return {
        "contractDigest": name,
        "unit": "ratio",
        "status": "available",
        "value": value,
        "evidenceRefs": ["raw"],
    }


def cells(candidate, passed, **process):
    """One trial per task; a None process value is a declared channel with no evidence."""
    return tuple(
        Evidence(
            candidate,
            task,
            0,
            score,
            "valid",
            "global",
            raw_metrics={name: metric(name, values[index]) for name, values in process.items()},
        )
        for index, (task, score) in enumerate(zip("ab", passed))
    )


def compare(objective, *evidence, reference=None, partition="seed"):
    return compare_candidates(
        {
            "evidence": [asdict(cell) for group in evidence for cell in group],
            "task_ids": ["a", "b"],
            "repetitions": 1,
            "candidate_id": "candidate",
            "anchor_id": "anchor",
            **({"reference_id": reference} if reference else {}),
            "partition": partition,
            "objective": objective,
        }
    )


class SeedGateTests(unittest.TestCase):
    def test_seed_rule_matches_the_paper_on_five_cases(self):
        anchor = cells("anchor", (1, 0), process_score=(0.8, 0.6))
        cases = [
            ("pass up, process down", (1, 1), (0.5, 0.5), False),
            ("pass tied, process up", (1, 0), (0.9, 0.7), True),
            ("both up", (1, 1), (0.9, 0.7), True),
            ("pass down, process up", (0, 0), (0.9, 0.9), False),
            ("both tied", (1, 0), (0.8, 0.6), False),
        ]
        for name, passed, process, improved in cases:
            with self.subTest(name):
                result = compare(
                    configuration(), anchor, cells("candidate", passed, process_score=process)
                )
                self.assertTrue(result["complete"])
                self.assertEqual(result["improved"], improved)
        result = compare(
            configuration(), anchor, cells("candidate", (1, 0), process_score=(0.9, 0.7))
        )
        self.assertEqual(
            result["signals"],
            [{"metric": "pass_rate", "gain": 0}, {"metric": "process_score", "gain": 0.1}],
        )

    def test_every_process_group_must_not_regress_in_its_own_direction(self):
        objective = configuration({"checklist": "maximize", "violations": "minimize"})
        anchor = cells("anchor", (1, 0), checklist=(0.5, 0.5), violations=(0.5, 0.5))
        cases = [
            ("one group up, one worse", (0.7, 0.7), (0.7, 0.7), False),
            ("one group up, one better", (0.7, 0.7), (0.3, 0.3), True),
            ("only the minimized group better", (0.5, 0.5), (0.3, 0.3), True),
            ("one group down, one better", (0.3, 0.3), (0.3, 0.3), False),
        ]
        for name, checklist, violations, improved in cases:
            with self.subTest(name):
                candidate = cells("candidate", (1, 0), checklist=checklist, violations=violations)
                result = compare(objective, anchor, candidate)
                self.assertTrue(result["complete"])
                self.assertEqual(result["improved"], improved)

    def test_missing_declared_process_evidence_is_incomplete(self):
        anchor = cells("anchor", (0, 0), process_score=(0.5, 0.5))
        cases = [
            (
                "candidate trial missing",
                anchor,
                cells("candidate", (1, 1), process_score=(0.9, None)),
            ),
            ("candidate channel absent", anchor, cells("candidate", (1, 1))),
            (
                "reference trial missing",
                cells("anchor", (0, 0), process_score=(0.5, None)),
                cells("candidate", (1, 1), process_score=(0.9, 0.9)),
            ),
        ]
        for name, reference, candidate in cases:
            with self.subTest(name):
                result = compare(configuration(), reference, candidate)
                self.assertFalse(result["complete"])
                self.assertFalse(result["improved"])

    def test_no_declared_process_group_reduces_to_an_outcome_gain(self):
        anchor = cells("anchor", (1, 0))
        for passed, improved in [((1, 1), True), ((1, 0), False), ((0, 0), False)]:
            with self.subTest(passed=passed):
                result = compare(configuration({}), anchor, cells("candidate", passed))
                self.assertTrue(result["complete"])
                self.assertEqual(result["improved"], improved)

    def test_reference_is_the_current_champion_and_protection_stays_on_the_anchor(self):
        objective = configuration()
        objective["protection"] = [
            {
                "partition": "seed",
                "task_id": "a",
                "metric": "process_score",
                "rule": "no_regression",
                "tolerance": 0,
            }
        ]
        anchor = cells("anchor", (1, 0), process_score=(0.5, 0.0))
        champion = cells("champion", (1, 0), process_score=(0.9, 0.1))
        better = cells("candidate", (1, 0), process_score=(0.6, 0.6))
        # Task a regresses against the champion but not against the run anchor.
        result = compare(objective, anchor, champion, better, reference="champion")
        self.assertEqual((result["complete"], result["constraints_passed"]), (True, True))
        self.assertTrue(result["improved"])
        worse = cells("candidate", (1, 0), process_score=(0.55, 0.0))
        self.assertTrue(compare(objective, anchor, worse)["improved"])
        self.assertFalse(
            compare(objective, anchor, champion, worse, reference="champion")["improved"]
        )

    def test_explicit_objectives_keep_their_objective_gain(self):
        objective = configuration({"total_tokens": "minimize"})
        del objective["seed_rule"]
        objective["definition"]["terms"].append(
            {
                "metric": "total_tokens",
                "metricContractDigest": "total_tokens",
                "weight": -1,
                "scale": 1,
            }
        )
        anchor = cells("anchor", (1, 0), total_tokens=(0.5, 0.5))
        # Fewer tokens at the same pass rate is a plain objective gain, no seed rule.
        result = compare(objective, anchor, cells("candidate", (1, 0), total_tokens=(0.3, 0.3)))
        self.assertNotIn("improved", result)
        self.assertEqual((result["complete"], result["gain"]), (True, 0.2))

    def test_held_out_validation_forbids_any_signal_regression_but_allows_ties(self):
        objective = configuration({"checklist": "maximize", "violations": "minimize"})
        anchor = cells("anchor", (1, 0), checklist=(0.5, 0.5), violations=(0.5, 0.5))
        cases = [
            ("all signals tied", (1, 0), (0.5, 0.5), (0.5, 0.5), False),
            ("all signals better", (1, 1), (0.7, 0.7), (0.3, 0.3), False),
            ("outcome regresses", (0, 0), (0.7, 0.7), (0.3, 0.3), True),
            ("maximized group regresses", (1, 1), (0.4, 0.4), (0.3, 0.3), True),
            ("minimized group regresses", (1, 1), (0.7, 0.7), (0.6, 0.6), True),
        ]
        for name, passed, checklist, violations, regressed in cases:
            with self.subTest(name):
                candidate = cells("candidate", passed, checklist=checklist, violations=violations)
                result = compare(objective, anchor, candidate, partition="held_out")
                self.assertTrue(result["complete"])
                self.assertEqual(result["regressed"], regressed)
        missing = cells("candidate", (1, 1), checklist=(0.7, None), violations=(0.3, 0.3))
        result = compare(objective, anchor, missing, partition="held_out")
        self.assertEqual((result["complete"], result["regressed"]), (False, False))


class SeedChampionTests(unittest.TestCase):
    tasks = tuple(Task(name, "family") for name in "ab")

    def view(self, profiles, objective, candidates=4):
        names = list(profiles)
        return SearchView(
            "seed-gate",
            3,
            "fixed",
            self.tasks,
            tuple(
                Candidate(name, digest(name), None if name == "anchor" else names[index - 1])
                for index, name in enumerate(names)
            ),
            tuple(
                cell
                for name, (passed, process) in profiles.items()
                for cell in cells(name, passed, process_score=process)
            ),
            (),
            Budget(100, candidates, 3),
            "anchor",
            objective,
        )

    def step(self, view):
        seen = []

        def policy(parents, rng):
            seen.append(parents.champion_id)
            return ScopedFrontier(champion_probability=1)(parents, rng)

        state = AlgorithmState(data={"phase": "parents", "round": 1})
        return GEPA(parent_policy=policy).step(view, state), seen

    def test_each_round_is_gated_against_the_current_champion(self):
        profiles = {
            "anchor": ((0, 0), (0.2, 0.2)),
            "first": ((1, 0), (0.4, 0.4)),
            "second": ((1, 0), (0.6, 0.6)),
            # Beats the anchor and leads on pass rate, but regresses the champion's process.
            "third": ((1, 1), (0.5, 0.5)),
        }
        decision, seen = self.step(self.view(profiles, configuration()))
        self.assertEqual(seen, ["second"])
        self.assertEqual(decision.research[0].data["champion"], "second")
        self.assertEqual(
            (decision.operations[0].kind, decision.operations[0].candidate_id),
            ("diagnose_seed", "second"),
        )
        decision, _ = self.step(self.view(profiles, configuration(), candidates=0))
        self.assertEqual(
            (decision.operations[0].kind, decision.operations[0].candidate_id),
            ("nominate", "second"),
        )

    def test_a_pass_rate_leader_that_regresses_process_is_not_nominated(self):
        profiles = {"anchor": ((1, 0), (0.5, 0.5)), "leader": ((1, 1), (0.4, 0.4))}
        decision, _ = self.step(self.view(profiles, configuration(), candidates=0))
        self.assertEqual(decision.operations[0].kind, "stop")

    def test_the_pass_rate_ceiling_alone_does_not_stop_a_process_gain(self):
        objective = configuration(ranges=True)
        profiles = {"anchor": ((0, 0), (0.4, 0.4)), "leader": ((1, 1), (0.5, 0.5))}
        decision, seen = self.step(self.view(profiles, objective))
        self.assertEqual(seen, ["leader"])
        self.assertEqual(decision.operations[0].kind, "diagnose_seed")
        profiles["leader"] = ((1, 1), (1, 1))
        decision, seen = self.step(self.view(profiles, objective))
        self.assertEqual(
            (decision.operations[0].kind, decision.operations[0].candidate_id),
            ("nominate", "leader"),
        )


if __name__ == "__main__":
    unittest.main()
