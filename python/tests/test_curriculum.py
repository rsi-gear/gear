"""Failure-to-data contracts, evidence binding and caller-owned CPU integration."""

import importlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from gear.core import DeterministicRandom, clone, freeze_module
from gear.core.base import construct_module
from gear.core.testing import check_operator
from gear.curriculum import (
    ContrastiveDiagnoser,
    ExtractOutcomeCases,
    FailureMode,
    GeneratePractice,
    LearningTarget,
    MasteryObservation,
    MergeFailureMemory,
    OutcomeRecord,
    PlanPractice,
    SelectLearningTargets,
    SelectPractice,
    ValidatePractice,
    ValidationEvidence,
)


def record(sample="sample", **kwargs):
    return replace(
        OutcomeRecord(
            "task",
            "family",
            sample,
            0,
            "policy",
            "environment",
            "completed",
            False,
            True,
            "task instruction",
            "failed",
            ({"sample": sample},),
        ),
        **kwargs,
    )


def mode(identifier="mode", support=("case",), **kwargs):
    return replace(
        FailureMode(identifier, identifier + " mechanism", support, (), ("family",), "diagnoser"),
        **kwargs,
    )


def fixture():
    cases = ExtractOutcomeCases()((record(),))
    generator = GeneratePractice()
    validator = ValidatePractice("independent-checker-v1")
    target = LearningTarget("mode", "capability", 2, (cases[0].case_id,), ("family",))
    plan = PlanPractice(generator.identity, validator.identity)((target,))[0]
    response = {
        "practices": [
            {
                "instruction": "new task",
                "family": "family",
                "data": {"x": 4},
                "reference": {"answer": 12},
                "verifier": {"kind": "arithmetic"},
            }
        ]
    }
    draft = generator.parse(response, plan=plan)[0]
    return cases, generator, validator, plan, response, draft


def evidence(plan):
    return tuple(
        ValidationEvidence(
            draft.draft_id,
            draft.digest,
            plan.policy_id,
            plan.validator_id,
            check,
            True,
            "semantic" if check in ("target_fidelity", "novelty") else "execution",
            ({"receipt": check},),
        )
        for draft in plan.drafts
        for check in plan.required_checks
    )


class CurriculumTests(unittest.TestCase):
    def test_imports_are_stdlib_only_and_do_not_load_other_capabilities(self):
        root = str(Path(__file__).resolve().parents[1])
        subprocess.run(
            [
                sys.executable,
                "-S",
                "-c",
                f"""
import sys
sys.path.insert(0, {root!r})
import gear.curriculum
for name in sys.modules:
    assert not name.startswith(('gear.search', 'gear.training', 'gear.evaluation', 'gear.memory',
                                'gear.algorithms', 'gear.refine', 'gear.project'))
assert not any(name in sys.modules for name in ('torch', 'openai', 'psutil', 'aiohttp'))
""",
            ],
            check=True,
        )

    def test_operators_roundtrip_and_freeze_configuration(self):
        _, generator, validator, _, _, _ = fixture()
        ops = (
            ExtractOutcomeCases(),
            ContrastiveDiagnoser(),
            MergeFailureMemory(),
            SelectLearningTargets(),
            PlanPractice(generator.identity, validator.identity),
            generator,
            validator,
            SelectPractice(),
        )

        def resolve(path):
            module, name = path.split(":")
            return getattr(importlib.import_module(module), name)

        for op in ops:
            with self.subTest(operator=type(op).__name__):
                spec = op.describe().to_dict()
                self.assertEqual(construct_module(spec, resolve).describe().to_dict(), spec)
                self.assertEqual(clone(op).describe().to_dict(), spec)
                if op.get_params(deep=False):
                    frozen = freeze_module(clone(op))
                    with self.assertRaisesRegex(ValueError, "frozen"):
                        frozen.set_params(**op.get_params(deep=False))
        modified = clone(generator).set_params(prompt="changed generation prompt")
        self.assertNotEqual(modified.identity, generator.identity)

    def test_pure_extraction_contract(self):
        self.assertEqual(check_operator(ExtractOutcomeCases(), (record(),))["status"], "passed")

    def test_retries_are_one_sample_latest_attempt_wins(self):
        first = record(status="infrastructure_error", passed=None)
        last = replace(first, attempt=1, status="completed", passed=False)
        cases = ExtractOutcomeCases()((last, first, last))
        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0].outcome, "failure")
        self.assertEqual(cases[0].record.attempt, 1)
        self.assertEqual(cases[0].case_id, ExtractOutcomeCases()((first,))[0].case_id)
        for bad in (replace(last, passed=True), replace(first, task_id="another")):
            with self.assertRaises(ValueError):
                ExtractOutcomeCases()((first, last, bad))

    def test_incomplete_infrastructure_and_hidden_verdicts_are_not_task_failures(self):
        cases = ExtractOutcomeCases()(
            (
                record("infra", status="infrastructure_error"),
                record("partial", complete=False),
                record("blind", passed=None),
                record("success", passed=True),
                record("failed"),
                record("holdout", partition="test"),
            )
        )
        self.assertEqual(
            {case.record.sample_id: case.outcome for case in cases},
            {
                "infra": "infrastructure_error",
                "partial": "unknown",
                "blind": "unknown",
                "success": "success",
                "failed": "failure",
            },
        )
        for invalid in (record(attempt=True), record(passed=0), record(schema_version=2)):
            with self.assertRaises(ValueError):
                ExtractOutcomeCases()((invalid,))

    def test_diagnosis_citations_and_comparable_successes(self):
        cases = ExtractOutcomeCases()(
            (
                record("fail"),
                record("ok", passed=True),
                record("other", passed=True, policy_id="other-policy"),
                record("infra", status="infrastructure_error"),
            )
        )
        by_name = {case.record.sample_id: case.case_id for case in cases}
        op = ContrastiveDiagnoser()
        row = {
            "mode_id": "mode",
            "description": "mechanism",
            "support_case_ids": [by_name["fail"]],
            "counterexample_case_ids": [by_name["ok"]],
        }
        parsed = op.parse({"modes": [row]}, cases=cases)
        self.assertEqual(parsed[0].families, ("family",))
        self.assertEqual(parsed[0].diagnoser_id, op.identity)
        prepared = op.prepare(cases)
        self.assertEqual(len(prepared.data["cases"]), 3)
        for change in (
            {"support_case_ids": ["invented"]},
            {"support_case_ids": [by_name["infra"]]},
            {"counterexample_case_ids": [by_name["other"]]},
            {"state": "mastered"},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                op.parse({"modes": [{**row, **change}]}, cases=cases)
        with self.assertRaises(ValueError):
            op.prepare((replace(cases[0], outcome="success"),))

    def test_memory_is_idempotent_and_mastery_requires_measurement(self):
        merge = MergeFailureMemory()
        original = (mode(),)
        self.assertEqual(merge(original, original), original)
        self.assertEqual(merge(original, ()), original)
        observation = MasteryObservation("mode", True, "new-policy", ({"measurement": "m1"},))
        mastered = merge(original, (), measurements=(observation,))
        self.assertEqual(mastered[0].state, "mastered")
        self.assertEqual(merge(mastered, original), mastered)
        recurrent = merge(mastered, (mode(support=("case", "new-case")),))
        self.assertEqual(recurrent[0].recurrence, 2)
        self.assertEqual(recurrent[0].state, "active")
        self.assertIsNone(recurrent[0].mastery)
        self.assertEqual(original[0].state, "active")
        for bad in (
            replace(observation, evidence_refs=()),
            replace(observation, mode_id="unknown"),
        ):
            with self.assertRaises(ValueError):
                merge(original, (), measurements=(bad,))
        with self.assertRaises(ValueError):
            merge((), (mode(state="mastered"),))
        with self.assertRaises(ValueError):
            merge(original, (mode(description="different mechanism"),))

    def test_target_budgets_and_explicit_randomness(self):
        memory = (
            mode("rare"),
            mode("common", ("a", "b", "c")),
            mode("unknown", state="unresolved"),
        )
        for budget in range(9):
            targets = SelectLearningTargets()(memory, budget=budget)
            self.assertEqual(sum(target.count for target in targets), budget)
            self.assertNotIn("unknown", [target.target_id for target in targets])
        targets = SelectLearningTargets()(memory, budget=4)
        self.assertEqual(
            {target.target_id: target.count for target in targets}, {"common": 3, "rare": 1}
        )
        uniform = SelectLearningTargets("uniform", max_targets=1)
        with self.assertRaises(ValueError):
            uniform(memory, budget=4)
        self.assertEqual(
            uniform(memory, budget=4, rng=DeterministicRandom("seed")),
            uniform(tuple(reversed(memory)), budget=4, rng=DeterministicRandom("seed")),
        )
        self.assertEqual(SelectLearningTargets()((), budget=4), ())
        with self.assertRaises(ValueError):
            SelectLearningTargets()(memory, budget=-1)

    def test_generation_material_scope_and_unconditioned_baseline(self):
        cases, generator, validator, plan, _, _ = fixture()
        unrelated = ExtractOutcomeCases()((record("unrelated", instruction="do not include"),))
        prepared = generator.prepare(plan, cases=cases + unrelated)
        self.assertEqual(len(prepared.data["cases"]), 1)
        self.assertNotIn("do not include", json.dumps(prepared.data))
        with self.assertRaises(ValueError):
            generator.prepare(plan, cases=())
        random_target = LearningTarget("random", "domain", 2, (), ("family",))
        random_plan = PlanPractice(generator.identity, validator.identity, "random")(
            (random_target,)
        )[0]
        self.assertEqual(generator.prepare(random_plan, cases=cases).data["cases"], [])
        with self.assertRaises(ValueError):
            PlanPractice(generator.identity, validator.identity, "random")((plan.target,))

    def test_generation_enforces_budget_lineage_and_configuration(self):
        _, generator, _, plan, response, draft = fixture()
        self.assertEqual(draft.plan, plan)
        self.assertEqual(generator.parse(response, plan=plan)[0], draft)
        self.assertEqual(generator.parse({"practices": []}, plan=plan), ())
        for invalid in (
            {"practices": [{**response["practices"][0], "family": "hidden-test-family"}]},
            {"practices": response["practices"] * 3},
            {"practices": response["practices"] * 2},
        ):
            with self.assertRaises(ValueError):
                generator.parse(invalid, plan=plan)
        with self.assertRaises(ValueError):
            GeneratePractice("changed prompt").parse(response, plan=plan)

    def test_validation_fails_closed_for_missing_or_untrusted_evidence(self):
        _, _, validator, _, _, draft = fixture()
        plan = validator.plan((draft,))
        complete = evidence(plan)
        self.assertTrue(validator.assess(plan, complete).results[0].accepted)
        for incomplete in (
            (),
            complete[:-1],
            (replace(complete[0], passed=None),) + complete[1:],
            (replace(complete[0], evidence_refs=()),) + complete[1:],
            (replace(complete[0], passed=False),) + complete[1:],
        ):
            with self.subTest(incomplete=incomplete):
                self.assertFalse(validator.assess(plan, incomplete).results[0].accepted)
        for invalid in (
            replace(complete[0], draft_digest="stale"),
            replace(complete[0], validator_id="other"),
            replace(complete[0], policy_id="other"),
            replace(complete[0], kind="semantic"),
        ):
            with self.assertRaises(ValueError):
                validator.assess(plan, (invalid,) + complete[1:])
        with self.assertRaises(ValueError):
            validator.assess(plan, complete + (complete[0],))

    def test_structural_failure_does_not_schedule_execution(self):
        _, _, validator, _, _, draft = fixture()
        plan = validator.plan((replace(draft, reference=None),))
        self.assertTrue(plan.structural_errors)
        self.assertFalse(validator.assess(plan, ()).results[0].accepted)
        with self.assertRaises(ValueError):
            validator.assess(plan, evidence(plan))
        with self.assertRaises((ValueError, TypeError)):
            validator.plan((replace(draft, data={"not_json": {1, 2}}),))

    def test_selection_binds_task_bytes_and_deduplicates_across_lineage(self):
        _, _, validator, _, _, draft = fixture()
        duplicate = replace(
            draft,
            draft_id="new-id",
            plan=replace(draft.plan, target=replace(draft.plan.target, target_id="another-mode")),
        )
        plan = validator.plan((draft, duplicate))
        report = validator.assess(plan, evidence(plan))
        selected = SelectPractice()(
            (draft, duplicate), report, budget=2, base_pool_version="pool-v1"
        )
        self.assertEqual(len(selected.selections), 1)
        self.assertEqual(selected.rejected[0][1], "exact duplicate")
        self.assertEqual(selected.base_pool_version, "pool-v1")
        self.assertEqual(
            SelectPractice()(
                (draft, duplicate),
                report,
                budget=2,
                base_pool_version="pool",
                existing_content_digests=(draft.content_digest,),
            ).selections,
            (),
        )
        with self.assertRaises(ValueError):
            SelectPractice()(
                (replace(draft, instruction="mutated"), duplicate),
                report,
                budget=2,
                base_pool_version="pool",
            )


EXAMPLE = Path(__file__).resolve().parents[2] / "examples/training-loop/failure_curriculum_cpu.py"
spec = importlib.util.spec_from_file_location("failure_curriculum_cpu", EXAMPLE)
example = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = example
spec.loader.exec_module(example)


class CurriculumCallerTests(unittest.TestCase):
    def test_actual_reference_and_negative_calibration_reject_teacher_mistakes(self):
        _, _, validator, _, _, draft = fixture()
        for reference, verifier, failed_check in (
            ({"answer": 999}, {"kind": "absolute-error", "tolerance": 1e-9}, "reference"),
            ({"answer": 12}, {"kind": "absolute-error", "tolerance": 1000}, "verifier_calibration"),
        ):
            with self.subTest(check=failed_check), tempfile.TemporaryDirectory() as directory:
                changed = replace(draft, reference=reference, verifier=verifier)
                plan = validator.plan((changed,))
                report = validator.assess(plan, example.run_checks(plan, Path(directory), set()))
                checks = {item.check: item.status for item in report.results[0].checks}
                self.assertEqual(checks[failed_check], "failed")
                self.assertFalse(report.results[0].accepted)

    def test_cpu_loop_generates_new_tasks_updates_and_resumes(self):
        with tempfile.TemporaryDirectory() as directory:
            result = example.run_example(directory)
            self.assertLess(result["final_held_out_mse"], result["initial_held_out_mse"])
            self.assertEqual(result["checkpoint"], {"negative": 1.0, "positive": 3.0})
            self.assertEqual(result["tasks_per_round"], [4] * 4)
            root = Path(directory)
            saved = {str(path): path.read_bytes() for path in root.rglob("*.json")}
            self.assertEqual(example.run_example(directory), result)
            self.assertEqual(saved, {str(path): path.read_bytes() for path in root.rglob("*.json")})
            first = json.loads((root / "rounds/000000/task-source/result.json").read_text())[
                "output"
            ]
            generated = json.loads((root / "rounds/000001/task-source/result.json").read_text())[
                "output"
            ]
            self.assertFalse({row["x"] for row in first} & {row["x"] for row in generated})
            self.assertTrue(all(set(row) == {"x", "target"} for row in generated))
            for strategy in ("fixed", "random"):
                baseline = example.run_example(root / strategy, strategy=strategy)
                self.assertEqual(baseline["tasks_per_round"], result["tasks_per_round"])

    def test_caller_recovers_after_diagnosis_generation_and_validation_interruption(self):
        for phase in ("offline_diagnose", "offline_generate", "run_checks"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                original = getattr(example, phase)

                def interrupt(*args, **kwargs):
                    original(*args, **kwargs)
                    raise RuntimeError("simulated interruption")

                with patch.object(example, phase, side_effect=interrupt):
                    with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                        example.run_example(directory)
                result = example.run_example(directory)
                self.assertEqual(result["checkpoint"]["positive"], 3.0)

    def test_caller_rejects_missing_records_and_changed_configuration_on_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            example.run_example(directory)
            with self.assertRaises(ValueError):
                example.run_example(directory, seed="different")
            changed = example.operators()
            changed["generate"].set_params(prompt="different teacher prompt")
            with patch.object(example, "operators", return_value=changed):
                with self.assertRaises(ValueError):
                    example.run_example(directory)
            path = Path(directory) / "rounds/000001/task-source/workspace/curriculum.json"
            path.unlink()
            with self.assertRaises(FileNotFoundError):
                example.run_example(directory)


if __name__ == "__main__":
    unittest.main()
