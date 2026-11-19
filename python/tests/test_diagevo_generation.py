"""Native capture/commit fixtures; no actual actor update or LLM effect claim."""

import copy
import importlib.util
import unittest
from dataclasses import asdict, replace

import test_diagevo_solver as solver_tests
from gear.core import clone
from gear.training.recipes.diagevo import Cause, GenerationDirective
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_data import DiagEvoChallengerDatasetBuilder
from gear.training.recipes.diagevo_generation import DiagEvoGenerationBuilder, DiagEvoQuestionPrompt
from gear.training.recipes.diagevo_memory import SkillNode
from gear.training.recipes.diagevo_solver import DiagEvoSolverDatasetBuilder
from gear.training.storage.content import ContractError


class QuestionPromptTests(unittest.TestCase):
    def test_three_modes_bind_exact_context_without_leaking_memory_into_free_exploration(self):
        active = Cause("active", "skill", solver_tests.CAUSE, "active", ("f1",), ("f1",))
        mastered = Cause(
            "mastered",
            "skill",
            "Apply domain constraints before removing common terms from both sides of equations",
            "mastered",
            (),
            ("f2",),
        )
        memory = (active, mastered)
        nodes = (SkillNode("skill", solver_tests.NODE),)
        prompt = clone(DiagEvoQuestionPrompt())
        free = prompt.messages(GenerationDirective("free"), memory=memory, nodes=nodes)
        self.assertNotIn(active.description, str(free))
        self.assertNotIn(nodes[0].label, str(free))
        targeted = prompt.messages(
            GenerationDirective("targeted", ("active",)), memory=memory, nodes=nodes
        )
        stitched = prompt.messages(
            GenerationDirective("stitched", ("active", "mastered")), memory=memory, nodes=nodes
        )
        self.assertEqual(free[0], targeted[0])
        self.assertEqual(free[0], stitched[0])
        self.assertIn(active.description, targeted[1]["content"])
        self.assertNotIn(mastered.description, targeted[1]["content"])
        self.assertIn(mastered.description, stitched[1]["content"])
        self.assertIn(nodes[0].label, stitched[1]["content"])
        for directive in (
            GenerationDirective("free", ("active",)),
            GenerationDirective("targeted", ("mastered",)),
            GenerationDirective("stitched", ("mastered", "active")),
        ):
            with self.subTest(directive=directive), self.assertRaises(ValueError):
                prompt.messages(directive, memory=memory, nodes=nodes)


@unittest.skipUnless(
    all(importlib.util.find_spec(name) is not None for name in ("nltk", "sklearn")),
    "install training-metrics to replay committed challenger rewards",
)
class FreshGenerationTests(unittest.TestCase):
    def setUp(self):
        self.native = solver_tests.SolverBatchTests()
        self.native.setUp()
        self.addCleanup(self.native.doCleanups)
        self.fixture = self.native.fixture
        self.store, self.fixed = self.native.store, self.native.fixed
        self.solver_request = copy.deepcopy(self.native.request)
        self.request = copy.deepcopy(self.solver_request)
        self.request["trainingRunId"] = "train-challenger"
        self.request["trainDataset"] = copy.deepcopy(self.fixture.request["trainDataset"])
        self.native.request = self.request
        self.memory, self.nodes = self.native.memory, (SkillNode("node", solver_tests.NODE),)
        self.directives = {"generate": GenerationDirective("targeted", ("cause",))}
        self.prompt = DiagEvoQuestionPrompt()
        objective = DiagEvoChallengerReward(group_size=2, policy=self.native.policy)
        self.challenger = DiagEvoChallengerDatasetBuilder(
            self.store, self.request, objective=objective
        )
        self.builder = DiagEvoGenerationBuilder(self.challenger, prompt=self.prompt)
        self.commits, self.old_groups = [], []
        before = self.fixed
        for step in range(2):
            batch, group = self.training_batch(step, before)
            commit, before = self.native.commit(
                batch, step + 1, self.commits[-1] if self.commits else None
            )
            self.commits.append(commit)
            self.old_groups.append(group)
        self.updated_hf = before
        self.fresh = self.group(2)
        self.lease = self.policy_lease(2, self.updated_hf)
        self.ref = self.seal()

    def group(self, step, *, responses=None):
        messages = self.prompt.messages(
            self.directives["generate"], memory=self.memory, nodes=self.nodes
        )
        rows = []
        for slot, response in enumerate(
            responses
            or (
                "<question>alpha beta gamma delta</question>",
                "<question>one two three four</question>",
            )
        ):
            raw = self.fixture.capture(
                f"challenger/{step}/{slot}",
                messages[-1]["content"],
                response,
                system=messages[0]["content"],
                slot=slot,
                policy=f"challenger-step-{step}",
            )
            context = self.store.read_json(raw.context_ref)
            context.update(batchId=f"batch-{step}", groupId=f"challenger-group-{step}")
            episode = self.store.read_json(raw.episode_ref)
            episode["groupId"] = context["groupId"]
            rows.append(
                replace(
                    raw,
                    context_ref=self.store.put_json(context),
                    episode_ref=self.store.put_json(episode),
                )
            )
        return tuple(rows)

    def policy_lease(self, step, before):
        return {
            **self.fixture.lease,
            "batchId": f"batch-{step}",
            "policyVersion": f"challenger-step-{step}",
            "synchronizedWeightsRef": before,
        }

    def training_batch(self, step, before, *, solver_system="solve"):
        group = self.group(step)
        lease = self.policy_lease(step, before)
        answers, labels = {}, []
        for key, question in self.challenger.questions((group,), lease=lease):
            classes = "a" * 9 + "b" * 3
            rows = tuple(
                self.fixture.capture(
                    f"judging/{key}/{i}",
                    question,
                    "answer " + answer,
                    solver=True,
                    slot=i,
                    system=solver_system,
                )
                for i, answer in enumerate(classes)
            )
            answers[key] = rows
            labels.extend(self.native.labels(rows, classes))
        batch = self.challenger.build(
            (group,),
            lease=lease,
            solver_policy_id="solver-v1",
            solver_trajectories=answers,
            answer_classes_ref=self.native.classify(labels),
        )
        return batch, group

    def seal(self, **changes):
        options = dict(
            lease=self.lease,
            commit_refs=self.commits,
            memory=self.memory,
            nodes=self.nodes,
            generation=self.directives,
            solver_policy_id="solver-v1",
        )
        options.update(changes)
        return self.builder.seal((self.fresh,), **options)

    def solver_pool(self):
        origin, _ = self.builder.read(self.ref)
        questions = origin["questions"]
        request = copy.deepcopy(self.solver_request)
        request["trainDataset"]["tasks"] = [
            {"id": key, "taskRef": self.fixed, "environmentRef": self.fixed} for key in questions
        ]
        self.native.request, self.native.questions = request, questions
        builder = DiagEvoSolverDatasetBuilder(
            self.store, request, policy=self.native.policy, generation_builder=self.builder
        )
        construction, labels = {}, []
        for key in questions:
            classes = "a" * 9 + "b" * 3
            rows = tuple(
                self.native.capture(f"new-construction/{key}/{i}", key, "answer " + answer, slot=i)
                for i, answer in enumerate(classes)
            )
            construction[key] = rows
            labels.extend(self.native.labels(rows, classes))
        kwargs = dict(
            generation={key: self.directives["generate"] for key in questions},
            memory=self.memory,
            construction_policy_id="solver-v1",
            answer_classes_ref=self.native.classify(labels),
            generation_ref=self.ref,
        )
        ref = builder.seal_curriculum(questions, construction, **kwargs)
        return builder, ref, questions, construction, kwargs

    def test_fresh_sampling_can_repeat_text_but_never_old_captures_and_replays_identically(self):
        value, seen = self.builder.read(self.ref)
        self.assertEqual(set(value["questions"]), {"challenger/2/0", "challenger/2/1"})
        self.assertEqual(value["input"]["lease"]["synchronizedWeightsRef"], self.updated_hf)
        self.assertIn(("episode", "challenger/0/0"), seen)
        self.assertEqual(self.seal(), self.ref)
        self.assertEqual(
            value["generation"]["challenger/2/0"],
            asdict(self.directives["generate"]) | {"cause_ids": ["cause"]},
        )

    def test_stale_weights_missing_commits_and_pre_update_policy_are_rejected(self):
        for changes in (
            {"lease": {**self.lease, "synchronizedWeightsRef": self.fixed}},
            {"lease": {**self.lease, "policyVersion": "challenger-step-1"}},
            {"commit_refs": self.commits[:1]},
            {"commit_refs": list(reversed(self.commits))},
        ):
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                self.seal(**changes)

    def test_memory_and_prompt_claims_are_checked_against_committed_and_fresh_requests(self):
        for changes in (
            {"memory": (replace(self.memory[0], description="Changed cause description"),)},
            {
                "nodes": (
                    SkillNode(
                        "node",
                        "Apply a different procedure when reasoning about equations and their domains",
                    ),
                )
            },
            {"generation": {"generate": GenerationDirective("free")}},
            {"generation": {}},
        ):
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                self.seal(**changes)
        raw = self.fresh[0]
        receipt = self.store.read_json(raw.receipt_refs[0])
        request = self.store.read_json(receipt["rawRequestRef"])
        request["agent"]["messages"][0]["content"] = "Different context"
        receipt["rawRequestRef"] = self.store.put_json(request)
        self.fresh = (replace(raw, receipt_refs=[self.store.put_json(receipt)]), self.fresh[1])
        with self.assertRaisesRegex(ContractError, "exact declared memory prompt"):
            self.seal()

    def test_relabeling_an_old_native_request_does_not_create_a_fresh_sample(self):
        raw = self.fresh[0]
        old_receipt = self.store.read_json(self.old_groups[0][0].receipt_refs[0])
        receipt = self.store.read_json(raw.receipt_refs[0])
        receipt["requestId"] = old_receipt["requestId"]
        self.fresh = (replace(raw, receipt_refs=[self.store.put_json(receipt)]), self.fresh[1])
        with self.assertRaisesRegex(ContractError, "reuse request"):
            self.seal()

    def test_frozen_solver_contract_cannot_drift_between_challenger_updates(self):
        parent = self.store.read_json(self.store.read_json(self.commits[0])["checkpointRef"])[
            "hfExportRef"
        ]
        batch, _ = self.training_batch(1, parent, solver_system="Different solver instructions")
        commit, _ = self.native.commit(batch, 2, self.commits[0])
        with self.assertRaisesRegex(ContractError, "one frozen solver instruction"):
            self.seal(commit_refs=[self.commits[0], commit])

    def test_invalid_completed_fresh_responses_are_retained_without_becoming_solver_questions(self):
        self.fresh = self.group(
            2, responses=("<question>valid question statement</question>", "bad format")
        )
        ref = self.seal()
        value, _ = self.builder.read(ref)
        self.assertEqual(set(value["questions"]), {"challenger/2/0"})
        self.assertEqual(len(value["input"]["groups"][0]), 2)

    def test_bound_solver_cannot_replace_or_omit_generated_questions_or_memory(self):
        builder, _, questions, construction, kwargs = self.solver_pool()
        for changes in (
            {"memory": ()},
            {"generation_ref": None},
            {"generation": {key: GenerationDirective("free") for key in questions}},
            {"construction_policy_id": "different"},
        ):
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                builder.seal_curriculum(questions, construction, **(kwargs | changes))
        changed = {key: text + " changed" for key, text in questions.items()}
        with self.assertRaisesRegex(ContractError, "all fresh questions"):
            builder.seal_curriculum(changed, construction, **kwargs)
        changed = self.store.read_json(self.ref)
        changed["questions"][next(iter(questions))] = "Substituted question"
        with self.assertRaisesRegex(ContractError, "evidence or configuration changed"):
            self.builder.read(self.store.put_json(changed))
        # A fresh question may have the same text as an earlier question. Its
        # construction responses must still be sampled independently.
        commit = self.store.read_json(self.commits[0])
        cursor = self.store.read_json(commit["dataCursorRef"])
        batch = self.store.read_json(cursor["batchRef"])
        samples = self.store.read_json(batch["samplesRef"])
        proof = self.store.read_json(samples[0][0]["metadata"]["curriculumRewardRef"])
        from gear.training.data.trajectories import RawTrajectory

        reused = copy.deepcopy(construction)
        reused["challenger/2/0"] = tuple(
            RawTrajectory(**row) for row in proof["solverTrajectories"]["challenger/0/0"]
        )
        labels = [
            label
            for rows in reused.values()
            for label in self.native.labels(rows, "a" * 9 + "b" * 3)
        ]
        with self.assertRaisesRegex(ContractError, "cannot reuse"):
            builder.seal_curriculum(
                questions, reused, **(kwargs | {"answer_classes_ref": self.native.classify(labels)})
            )

    def test_fresh_pool_reaches_committed_solver_failures_with_origin_intact(self):
        builder, pool, questions, _, _ = self.solver_pool()
        self.native.builder, self.native.pool = builder, pool
        key = next(iter(questions))
        first, _, _, _ = self.native.batch(0, self.fixed, question=key)
        c1, exported = self.native.commit(first, 1)
        second, _, _, _ = self.native.batch(1, exported, question=key, answers="ab")
        c2, _ = self.native.commit(second, 2, c1)
        evidence = builder.round_evidence((c1, c2), curriculum_ref=pool)
        self.assertEqual(evidence.questions, questions)
        self.assertEqual(len(evidence.groups), 2)
        self.assertEqual(
            sum(reward < 0 for group in evidence.groups for reward in group.rewards), 3
        )
        self.assertEqual(self.store.read_json(pool)["input"]["generationRef"], self.ref)


if __name__ == "__main__":
    unittest.main()
