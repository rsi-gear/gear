import json
import unittest
from dataclasses import replace

from gear.algorithms import (
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
    Role,
    SearchView,
    Task,
    WorkflowAlgorithm,
)
from gear.canonical import digest


class EditingWorkflow(WorkflowAlgorithm):
    roles = {
        "analyst": Role("Explain the failures", {"type": "string"}),
        "editor": Role("Implement the proposal", {"type": "string"}, edits=True),
    }

    async def run(self, ctx):
        baseline = await ctx.evaluate(ctx.inputs.anchor, key="baseline")
        if not baseline.ok:
            return ctx.result(reason="incomplete baseline")
        diagnosis = await ctx.roles.call("analyst", inputs="failure", key="diagnose")
        edit = await ctx.roles.call("editor", inputs=diagnosis.data, key="edit")
        if not edit.ok:
            return ctx.result(reason="editor failed")
        measured = await ctx.evaluate(edit.candidate, key="measure")
        return ctx.result(selected=edit.candidate if measured.ok else None)


def initial():
    return SearchView(
        "run",
        0,
        "seed",
        (Task("a", "toy"),),
        (Candidate("anchor", digest("anchor")),),
        (),
        (),
        Budget(100, 3, 2),
        "anchor",
    )


def complete(view, decision, *, failed=False, data="reply"):
    operation = decision.operations[0]
    result = OperationResult(
        f"op-{view.step_id}",
        operation.kind,
        "failed" if failed else "complete",
        operation.candidate_id,
        {"declined": failed, "data": data},
    )
    candidates, evidence = view.candidates, view.evidence
    if operation.kind == "generate_candidate" and not failed:
        candidates += (
            Candidate(operation.candidate_id, digest(operation.candidate_id), operation.parent_id),
        )
    if operation.kind == "evaluate_seed" and not failed:
        evidence += tuple(
            Evidence(operation.candidate_id, task, 0, 0.0, "task_failed", "global")
            for task in operation.task_ids
            if not any(
                cell.candidate_id == operation.candidate_id
                and cell.task_id == task
                and cell.repetition == 0
                for cell in evidence
            )
        )
    return replace(
        view,
        step_id=view.step_id + 1,
        completed=view.completed + (result,),
        candidates=candidates,
        evidence=evidence,
    )


class RunContextTests(unittest.TestCase):
    def test_recreated_workflow_replays_results_and_finishes_with_nomination(self):
        view, state, kinds = initial(), AlgorithmState(), []
        for _ in range(5):
            decision = EditingWorkflow().step(view, state)
            kinds.append(decision.operations[0].kind)
            if kinds[-1] == "nominate":
                self.assertEqual(decision.operations[0].candidate_id, view.candidates[-1].id)
                break
            view, state = (
                complete(view, decision),
                AlgorithmState(
                    **json.loads(
                        json.dumps({"version": decision.state.version, "data": decision.state.data})
                    )
                ),
            )
        self.assertEqual(
            kinds,
            ["evaluate_seed", "diagnose_seed", "generate_candidate", "evaluate_seed", "nominate"],
        )

    def test_operation_id_keeps_original_result_when_later_receipts_exist(self):
        class TwoCalls(WorkflowAlgorithm):
            roles = {"analyst": Role("Analyze", {})}

            async def run(self, ctx):
                first = await ctx.roles.call("analyst", key="one")
                second = await ctx.roles.call("analyst", inputs=first.data, key="two")
                return ctx.result(reason=str(second.data))

        view = initial()
        first = TwoCalls().step(view, AlgorithmState())
        view = complete(view, first, data="first")
        second = TwoCalls().step(view, first.state)
        self.assertEqual(second.operations[0].payload["inputs"], "first")
        view = complete(view, second, data="second")
        view = replace(
            view,
            completed=view.completed
            + (OperationResult("later", "diagnose_seed", "complete", "anchor", "unrelated"),),
        )
        final = TwoCalls().step(view, second.state)
        self.assertEqual(final.reason, "second")

    def test_changed_request_or_key_is_rejected_before_next_operation(self):
        class Single(WorkflowAlgorithm):
            roles = {"analyst": Role("Analyze", {})}
            value = "original"

            async def run(self, ctx):
                await ctx.roles.call("analyst", inputs=self.value, key="one")
                return ctx.result()

        first = Single().step(initial(), AlgorithmState())
        changed = Single()
        changed.value = "changed"
        with self.assertRaisesRegex(ValueError, "changed a recorded request"):
            changed.step(complete(initial(), first), first.state)

    def test_wrong_receipt_is_not_used_as_role_output(self):
        first = EditingWorkflow().step(initial(), AlgorithmState())
        wrong = replace(
            initial(),
            completed=(OperationResult("wrong", "generate_candidate", "complete", "other"),),
        )
        with self.assertRaisesRegex(ValueError, "completion does not match"):
            EditingWorkflow().step(wrong, first.state)

    def test_failed_editor_does_not_need_a_generated_candidate(self):
        view, state = initial(), AlgorithmState()
        for _ in range(3):
            decision = EditingWorkflow().step(view, state)
            view = complete(
                view, decision, failed=decision.operations[0].kind == "generate_candidate"
            )
            state = decision.state
        final = EditingWorkflow().step(view, state)
        self.assertEqual(final.reason, "editor failed")
        self.assertEqual(final.operations[0].kind, "stop")

    def test_no_duplicate_full_receipt_or_evidence_payload_in_state(self):
        view = replace(
            initial(),
            evidence=(Evidence("anchor", "a", 0, 0, "valid", "global", feedback="x" * 100_000),),
        )
        first = EditingWorkflow().step(view, AlgorithmState())
        resumed = EditingWorkflow().step(complete(view, first), first.state)
        self.assertLess(len(json.dumps(resumed.state.data)), 2000)

    def test_incomplete_or_unscored_evaluation_is_not_ok(self):
        first = EditingWorkflow().step(initial(), AlgorithmState())
        for rows in ((), (Evidence("anchor", "a", 0, None, "scoring_failed", "global"),)):
            view = replace(complete(initial(), first), evidence=rows)
            final = EditingWorkflow().step(view, first.state)
            self.assertEqual(final.reason, "incomplete baseline")

    def test_budget_reads_replay_old_balance(self):
        class ReadBudget(WorkflowAlgorithm):
            roles = {"analyst": Role("Analyze", {})}

            async def run(self, ctx):
                remaining = ctx.budget.snapshot(key="balance").candidates_remaining
                await ctx.roles.call("analyst", inputs=remaining, key="one")
                return ctx.result(reason=str(remaining))

        first = ReadBudget().step(initial(), AlgorithmState())
        resumed = replace(complete(initial(), first), budget=Budget(1, 0, 2))
        final = ReadBudget().step(resumed, first.state)
        self.assertEqual(final.reason, "3")

    def test_new_evidence_does_not_expand_earlier_observation(self):
        class ReadEvidence(WorkflowAlgorithm):
            roles = {"analyst": Role("Analyze", {})}

            async def run(self, ctx):
                observed = ctx.evidence.for_candidate("anchor", key="observation")
                await ctx.roles.call("analyst", key="one")
                return ctx.result(reason=str(len(observed)))

        first = ReadEvidence().step(initial(), AlgorithmState())
        resumed = replace(
            complete(initial(), first), evidence=(Evidence("anchor", "a", 0, 0, "valid", "global"),)
        )
        self.assertEqual(ReadEvidence().step(resumed, first.state).reason, "0")

    def test_duplicate_key_and_skipped_history_are_rejected(self):
        class Repeated(WorkflowAlgorithm):
            roles = {"analyst": Role("Analyze", {})}
            skip = False

            async def run(self, ctx):
                if self.skip:
                    return ctx.result()
                await ctx.roles.call("analyst", key="one")
                await ctx.roles.call("analyst", key="one")
                return ctx.result()

        first = Repeated().step(initial(), AlgorithmState())
        resumed = complete(initial(), first)
        with self.assertRaisesRegex(ValueError, "unique"):
            Repeated().step(resumed, first.state)
        changed = Repeated()
        changed.skip = True
        with self.assertRaisesRegex(ValueError, "before replaying"):
            changed.step(resumed, first.state)

    def test_role_result_does_not_mutate_the_input_view(self):
        class MutateResult(WorkflowAlgorithm):
            roles = {"analyst": Role("Analyze", {})}

            async def run(self, ctx):
                response = await ctx.roles.call("analyst", key="one")
                response.operation.data["data"]["value"] = "mutated"
                return ctx.result()

        first = MutateResult().step(initial(), AlgorithmState())
        resumed = complete(initial(), first, data={"value": "original"})
        MutateResult().step(resumed, first.state)
        self.assertEqual(resumed.completed[0].data["data"]["value"], "original")

    def test_changed_observed_evidence_is_rejected(self):
        class ReadEvidence(WorkflowAlgorithm):
            roles = {"analyst": Role("Analyze", {})}

            async def run(self, ctx):
                ctx.evidence.for_candidate("anchor", key="observation")
                await ctx.roles.call("analyst", key="one")
                return ctx.result()

        view = replace(initial(), evidence=(Evidence("anchor", "a", 0, 0, "valid", "global"),))
        first = ReadEvidence().step(view, AlgorithmState())
        changed = replace(
            complete(view, first), evidence=(Evidence("anchor", "a", 0, 1, "valid", "global"),)
        )
        with self.assertRaisesRegex(ValueError, "observed evidence changed"):
            ReadEvidence().step(changed, first.state)


if __name__ == "__main__":
    unittest.main()
