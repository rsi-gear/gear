import unittest
from dataclasses import replace
from gear.algorithms import GEPA, RandomSearch, Evidence, RankingInput, ParentPlan
from gear.algorithms.gepa.ranking import rank_candidates
from gear.algorithms.testkit import toy_round, test_parent_policy
from gear.canonical import canonical, digest
from gear.refine.protocol import validate


class AlgorithmTests(unittest.TestCase):
    def test_large_candidate_allocations_finish_without_dropping_candidates(self):
        from gear.algorithms import SearchView, Budget, Candidate, Task, AlgorithmState
        from gear.algorithms.contracts import OperationResult
        from gear.algorithms.testkit import wire
        from gear.algorithms.limits import MAX_DECISION_OPERATIONS

        for count in (64, 129):
            with self.subTest(candidates=count):
                algorithm = RandomSearch()
                view = SearchView("large", 0, "fixed", (Task("a", "a"),),
                                  (Candidate("anchor", digest("anchor")),), (), (),
                                  Budget(count * 2 + 1, count, 1), "anchor")
                state = AlgorithmState()
                generated, evaluated = set(), set()
                for _ in range(50):
                    decision = algorithm.step(view, state)
                    validate("Decision", wire(decision))
                    self.assertLessEqual(len(decision.operations), MAX_DECISION_OPERATIONS)
                    state = decision.state
                    if decision.operations[0].kind in ("stop", "nominate"):
                        break
                    for index, operation in enumerate(decision.operations):
                        result = OperationResult(f"{view.step_id}:{index}", operation.kind,
                                                 "complete", operation.candidate_id)
                        if operation.kind == "diagnose_seed":
                            result = replace(result, data={"hypotheses": ["Improve accuracy"]})
                        elif operation.kind == "generate_candidate":
                            candidate = operation.candidate_id
                            self.assertNotIn(candidate, generated)
                            generated.add(candidate)
                            view = replace(view, candidates=view.candidates + (
                                Candidate(candidate, digest(candidate), operation.parent_id),),
                                budget=replace(view.budget,
                                               candidates_remaining=view.budget.candidates_remaining - 1))
                        elif operation.kind == "evaluate_seed":
                            candidate = operation.candidate_id
                            if candidate not in evaluated:
                                evaluated.add(candidate)
                                view = replace(view, evidence=view.evidence + (
                                    Evidence(candidate, "a", 0, 0 if candidate == "anchor" else 0.5,
                                             "valid", operation.scope),),
                                    budget=replace(view.budget,
                                                   evaluations_remaining=view.budget.evaluations_remaining - 1))
                        view = replace(view, completed=view.completed + (result,))
                    view = replace(view, step_id=view.step_id + 1)
                else:
                    self.fail("large candidate allocation did not reach a terminal decision")
                self.assertEqual(len(generated), count)
                self.assertEqual(evaluated, generated | {"anchor"})

    def test_many_solved_rounds_finish_without_recursive_decisions(self):
        from gear.algorithms import SearchView, Budget, Candidate, Task, AlgorithmState
        view = SearchView("solved", 1, "fixed", (Task("a", "a"),), (Candidate("anchor", digest("anchor")),),
            (Evidence("anchor", "a", 0, 1, "valid", "global"),), (), Budget(100, 100, 10000), "anchor")
        decision = GEPA().step(view, AlgorithmState(data={"phase": "parents", "round": 0}))
        self.assertEqual(decision.operations[0].kind, "stop")

    def test_recipes_share_interfaces_but_control_their_own_stages(self):
        gepa = toy_round(GEPA())
        random = toy_round(RandomSearch())
        self.assertIn("evaluate_seed:local", gepa["operations"])
        self.assertNotIn("evaluate_seed:local", random["operations"])
        self.assertIsNotNone(gepa["nominee"])
        self.assertIsNotNone(random["nominee"])

    def test_one_function_replaces_parent_policy(self):
        def policy(view, rng):
            if not view.eligible:
                return ParentPlan.abstain("empty")
            return ParentPlan.single(rng.choice(view.eligible, key="custom"), view.candidate_limit)

        self.assertEqual(test_parent_policy(policy)["status"], "passed")
        self.assertEqual(toy_round(GEPA(parent_policy=policy))["status"], "passed")

    def test_parent_policy_rejects_invalid_selections(self):
        for invalid in ("negative_probability", "modified_option"):
            with self.subTest(invalid=invalid):
                def policy(view, rng):
                    if not view.eligible:
                        return ParentPlan.abstain("empty")
                    selection = rng.choice(view.eligible, key="custom")
                    if invalid == "negative_probability":
                        selected = selection.option.scope + ":" + selection.option.candidate_id
                        selection = replace(selection, probabilities=tuple(
                            (key, 1.25 if key == selected else -0.25)
                            for key, _ in selection.probabilities
                        ))
                    else:
                        selection = replace(selection, option=replace(
                            selection.option, score=selection.option.score + 0.1
                        ))
                    return ParentPlan.single(selection, view.candidate_limit)

                with self.assertRaises(ValueError):
                    test_parent_policy(policy)

    def test_parent_policy_requires_a_reason_for_empty_eligibility(self):
        def policy(view, rng):
            if not view.eligible:
                return ParentPlan.abstain("")
            return ParentPlan.single(rng.choice(view.eligible, key="custom"), view.candidate_limit)

        with self.assertRaisesRegex(ValueError, "reason"):
            test_parent_policy(policy)

    def test_parent_policy_accepts_reweighted_eligible_options(self):
        def policy(view, rng):
            if not view.eligible:
                return ParentPlan.abstain("empty")
            options = tuple(replace(option, probability=index + 1)
                            for index, option in enumerate(view.eligible))
            return ParentPlan.single(rng.choice(options, key="weighted"), view.candidate_limit)

        self.assertEqual(test_parent_policy(policy)["status"], "passed")

    def test_invalid_slots_are_not_zero_and_complete_zero_is_retained(self):
        cells = (
            Evidence("a", "task", 0, 0, "valid", "all"),
            Evidence("b", "task", 0, None, "environment_failed", "all"),
        )
        ranked = rank_candidates(RankingInput(("a", "b"), ("task",), cells, 1))
        self.assertEqual(ranked.candidate_ids, ("a",))
        self.assertEqual(ranked.incomplete, ("b",))
        duplicate = rank_candidates(RankingInput(("a",), ("task",), cells + (cells[0],), 1))
        self.assertEqual(duplicate.incomplete, ("a",))

    def test_wire_rejects_unknown_operations_and_nonfinite_values(self):
        with self.assertRaises(ValueError):
            validate("OperationKind", "read_held_out")
        with self.assertRaises(ValueError):
            validate("Json", float("nan"))
        with self.assertRaises(ValueError):
            canonical(float("inf"))
        with self.assertRaises(ValueError):
            canonical(2**54)
        self.assertEqual(digest({"中文": 1, "a": []}), digest({"a": [], "中文": 1.0}))

    def test_frontier_preserves_specialists_and_prunes_redundant_parents(self):
        from gear.algorithms.contracts import ParentInput, ParentOption
        from gear.algorithms.gepa.parents import frontier_options

        options = tuple(
            ParentOption(
                candidate,
                "scope",
                ("a", "b"),
                sum(scores) / 2,
                task_scores=tuple(zip(("a", "b"), scores)),
            )
            for candidate, scores in [
                ("anchor", (0, 0)),
                ("arithmetic", (1, 0)),
                ("format", (0, 1)),
            ]
        )
        frontier = frontier_options(ParentInput(options, 2, "anchor"))
        probabilities = {option.candidate_id: option.probability for option in frontier}
        self.assertEqual(probabilities, {"anchor": 0, "arithmetic": 0.5, "format": 0.5})
        # A candidate winning both tasks makes the two specialists redundant.
        generalist = ParentOption(
            "generalist", "scope", ("a", "b"), 1, task_scores=(("a", 1), ("b", 1))
        )
        frontier = frontier_options(ParentInput(options + (generalist,), 2, "anchor"))
        self.assertEqual(
            {option.candidate_id for option in frontier if option.probability},
            {"generalist"},
        )

    def test_all_parent_allocations_are_consumed(self):
        from gear.algorithms.gepa.parents import ScopedFrontier

        result = toy_round(GEPA(parent_policy=ScopedFrontier(batch_count=2)))
        self.assertEqual(result["operations"].count("diagnose_seed:global"), 2)
        self.assertEqual(result["operations"].count("generate_candidate:global"), 2)

    def test_gepa_scope_weights_cost_strata_and_bridge_capacity(self):
        from gear.algorithms.contracts import Task, SamplingInput
        from gear.algorithms.gepa.sampling import GEPASampler
        from gear.algorithms.random import DeterministicRandom

        tasks = tuple(
            Task(
                str(i),
                "failure" if i < 200 else "control" if i < 500 else "cross",
                i + 1,
            )
            for i in range(1000)
        )
        plan = GEPASampler()(
            SamplingInput(
                tasks,
                tuple(str(i) for i in range(200)),
                "local",
                successful_controls=tuple(str(i) for i in range(200, 500)),
            ),
            DeterministicRandom("sampling"),
        )
        buckets = dict(plan.buckets)
        self.assertEqual(
            {name: len(ids) for name, ids in plan.buckets},
            {"shared": 40, "local": 80, "cross": 30},
        )
        self.assertEqual(len(set(plan.task_ids)), 150)
        for name, mass in [("shared", 0.25), ("local", 0.6), ("cross", 0.15)]:
            self.assertAlmostEqual(sum(dict(plan.weights)[key] for key in buckets[name]), mass)
        bridge = GEPASampler()(
            SamplingInput(tasks, (), "bridge", plan.task_ids),
            DeterministicRandom("sampling"),
        )
        self.assertEqual(len(bridge.task_ids), 400)
        self.assertTrue(set(plan.task_ids) <= set(bridge.task_ids))
        too_large = GEPASampler()(
            SamplingInput(tasks, (), "bridge", tuple(str(i) for i in range(401))),
            DeterministicRandom("sampling"),
        )
        self.assertEqual(too_large.task_ids, ())

    def test_weighted_ranking_does_not_flatten_buckets(self):
        cells = tuple(
            Evidence(candidate, task, 0, score, "valid", "local")
            for candidate, values in [("a", (1, 0)), ("b", (0, 1))]
            for task, score in zip(("important", "small"), values)
        )
        ranking = rank_candidates(
            RankingInput(
                ("a", "b"),
                ("important", "small"),
                cells,
                1,
                (("important", 0.8), ("small", 0.2)),
            )
        )
        self.assertEqual(ranking.scores, (("a", 0.8), ("b", 0.2)))

    def test_configured_policy_and_sampler_round_trip_through_sdk(self):
        from gear.project import Project
        from gear.refine.worker import make_algorithm
        from gear.algorithms.gepa.parents import ScopedFrontier
        from gear.algorithms.gepa.sampling import GEPASampler

        algorithm = GEPA(
            parent_policy=ScopedFrontier(batch_count=2, champion_probability=0.25),
            sampler=GEPASampler(bridge_ratio=0.75),
        )
        config = Project._describe_algorithm(algorithm)
        reconstructed = make_algorithm(config["algorithm"])
        self.assertEqual(reconstructed.parent_policy, algorithm.parent_policy)
        self.assertEqual(reconstructed.sampler.bridge_ratio, 0.75)
        self.assertEqual(
            toy_round(reconstructed)["operations"].count("generate_candidate:global"), 2
        )
