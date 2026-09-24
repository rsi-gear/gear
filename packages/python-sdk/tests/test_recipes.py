import json
import unittest

from gear_algorithm import ValidationError, WorkflowStep, define_workflow, operation
from gear_algorithm.recipes.ahe import Ahe, verify_predictions
from gear_algorithm.recipes.evo import Evo
from gear_algorithm.recipes.rho import Rho, select_coreset


def ref(letter, schema="test.v1"):
    return {"kind": "artifact", "digest": letter * 64, "size": 1,
            "mediaType": "application/json", "schemaId": schema}


def binding(letter, schema):
    return {"kind": "binding-set", "digest": letter * 64, "schemaId": schema}


def value(item):
    return {"kind": "result", "value": item}


def execution(letter, structured_result=None, produced=None):
    result = {"evidenceRef": ref(letter), "receiptRef": ref(letter.upper())}
    if structured_result is not None:
        result["structuredResult"] = structured_result
        result["structuredResultRef"] = ref(letter.lower())
    if produced is not None:
        result["producedArtifactRef"] = produced
    return value(result)


def reduce(algorithm, decision, config, completed):
    decision.to_wire()
    advanced = algorithm.reduce({"state": decision.nextState, "config": config, "completed": completed})
    for intent in advanced.operations:
        assert intent.limits == config.get("operationLimits", {}).get(intent.kind)
    return advanced


METERED_LIMITS = {
    "evidence.query": {"evidence.items": 10, "evidence.bytes": 8192},
    "evidence.read": {"evidence.items": 1, "evidence.bytes": 65536},
    "execution.role": {"model.requests": 1, "model.tokens": 2048},
    "execution.rollout": {"rollout.trials": 1},
    "execution.feedback": {"model.requests": 1, "model.tokens": 1024},
    "execution.workspace-edit": {"model.requests": 1, "model.tokens": 4096},
}
EVO_LIMITS = {kind: METERED_LIMITS[kind] for kind in (
    "execution.role", "execution.rollout", "execution.feedback")}


class RecipeTests(unittest.TestCase):
    def test_recipe_limits_reject_unknown_kinds_and_invalid_amounts(self):
        base = {"experienceViewRef": ref("e"), "asOf": {"namespace": "n", "value": "1"},
                "coresetSize": 1, "historyPageSize": 1, "baselineRepeats": 2,
                "proposalCount": 1, "samplingDigest": "s" * 64, "environmentDigest": "e" * 64}
        context = {"activeBindingSetRef": binding("a", "rho.bindings.v1")}
        with self.assertRaisesRegex(ValidationError, "Invalid operationLimits entry"):
            Rho().initialize({**context, "config": {**base, "operationLimits": {"unknown.kind": {"calls": 1}}}})
        with self.assertRaisesRegex(ValidationError, "Invalid reservation"):
            Rho().initialize({**context, "config": {**base, "operationLimits": {
                "evidence.query": {"evidence.items": float("nan")}}}})

    def test_named_python_workflow_hides_cursor_and_validates_business_state(self):
        workflow = define_workflow(id="simple", config_schema={"type": "object"},
            binding_schema={"id": "empty", "slots": {}},
            business_state_schema={"type": "object", "properties": {"reply": {"type": "string"}},
                                   "additionalProperties": False},
            initial_state=lambda context: {},
            steps=[WorkflowStep("echo",
                plan=lambda context: [operation(key="echo", kind="toy.echo", input={"text": "hi"})],
                join=lambda context: ({"reply": context["completed"]["echo"]["value"]["text"]}, None))])
        context = {"config": {}, "activeBindingSetRef": binding("a", "empty")}
        first = workflow.initialize(context)
        self.assertEqual(first.nextState["stepIndex"], 0)
        self.assertEqual(first.operations[0].kind, "toy.echo")
        last = workflow.reduce({**context, "state": first.nextState,
                                "completed": {"echo": value({"text": "hi"})}})
        self.assertTrue(last.complete)
        self.assertEqual(last.nextState, {"stepIndex": 1, "business": {"reply": "hi"}})

    def test_named_workflow_advances_bounded_pure_steps(self):
        workflow = define_workflow(id="pure-and-echo", config_schema={"type": "object"},
            binding_schema={"id": "empty", "slots": {}},
            business_state_schema={"type": "object", "properties": {"count": {"type": "integer"}},
                                   "required": ["count"], "additionalProperties": False},
            initial_state=lambda context: {"count": 0},
            steps=[WorkflowStep("before", plan=lambda context: [],
                        join=lambda context: ({"count": context["state"]["count"] + 1}, None)),
                   WorkflowStep("echo", plan=lambda context: [operation(key="echo", kind="toy.echo", input={})],
                        join=lambda context: ({"count": context["state"]["count"] + 1}, None)),
                   WorkflowStep("after", plan=lambda context: [],
                        join=lambda context: ({"count": context["state"]["count"] + 1}, None))])
        context = {"config": {}, "activeBindingSetRef": binding("a", "empty")}
        first = workflow.initialize(context)
        self.assertEqual(first.nextState, {"stepIndex": 1, "business": {"count": 1}})
        self.assertEqual(first.operations[0].kind, "toy.echo")
        final = workflow.reduce({**context, "state": first.nextState,
                                 "completed": {"echo": value({})}})
        self.assertTrue(final.complete)
        self.assertEqual(final.nextState, {"stepIndex": 3, "business": {"count": 3}})

    def test_rho_uses_history_then_fixed_baseline_and_positive_soft_gate(self):
        self.assertEqual(select_coreset([
            {"taskId": "a", "difficulty": 10, "fingerprint": [1, 0]},
            {"taskId": "b", "difficulty": 9, "fingerprint": [1, 0]},
            {"taskId": "c", "difficulty": 8, "fingerprint": [0, 1]},
        ], 2), ["a", "c"])
        algorithm = Rho()
        config = {"experienceViewRef": ref("e", "experience.view.v1"),
                  "asOf": {"namespace": "deployment:history", "value": "1"}, "coresetSize": 1,
                  "historyPageSize": 10, "baselineRepeats": 2, "proposalCount": 1,
                  "samplingDigest": "s" * 64, "environmentDigest": "v" * 64,
                  "operationLimits": METERED_LIMITS}
        baseline = binding("a", "rho.bindings.v1")
        decision = algorithm.initialize({"config": config, "activeBindingSetRef": baseline})
        self.assertEqual([op.kind for op in decision.operations], ["evidence.query"])
        self.assertEqual(decision.operations[0].limits, METERED_LIMITS["evidence.query"])
        decision = reduce(algorithm, decision, config, {"history.query": value({"items": [
            {"entryId": "old-1", "taskId": "task1", "contentRef": ref("h")} ]})})
        self.assertEqual([op.kind for op in decision.operations], ["evidence.read"])
        decision = reduce(algorithm, decision, config, {"history.read.0": value({
            "text": json.dumps({"summary": "old failed trace", "tags": ["tool"]})})})
        self.assertEqual(decision.operations[0].input["projection"], "task-report")
        decision = reduce(algorithm, decision, config, {"history.detail.query": value({"items": [
            {"entryId": "old-1", "taskId": "task1", "contentRef": ref("r")}]})})
        decision = reduce(algorithm, decision, config, {"history.detail.read.0": value({
            "text": json.dumps({"narrative": "tool reply was invalid"}), "receiptRef": ref("j")})})
        self.assertEqual(decision.operations[0].input["projection"], "trace-chunk")
        decision = reduce(algorithm, decision, config, {"history.detail.query": value({"items": [
            {"entryId": "old-1", "taskId": "task1", "contentRef": ref("q")}]})})
        decision = reduce(algorithm, decision, config, {"history.detail.read.0": value({
            "text": json.dumps({"sequence": 0, "text": "invalid tool payload"}), "receiptRef": ref("k")})})
        self.assertEqual(decision.operations[0].kind, "execution.role")
        self.assertEqual(decision.operations[0].input["history"]["taskReports"][0]["body"]["narrative"],
                         "tool reply was invalid")
        self.assertEqual(decision.operations[0].input["history"]["traceChunks"][0]["body"]["text"],
                         "invalid tool payload")
        self.assertNotIn("trueLabel", decision.operations[0].input)
        decision = reduce(algorithm, decision, config, {"difficulty.0": execution("d", {
            "difficulty": 9, "fingerprint": [1, 0]})})
        self.assertEqual(decision.operations[0].kind, "tasks.select")
        self.assertEqual(decision.operations[0].input["tasks"], [{"id": "task1", "purpose": "development"}])
        view = ref("t", "task.view.v1")
        decision = reduce(algorithm, decision, config, {"tasks.select": value({"taskViewRef": view})})
        task = {"id": "task1", "contentRef": ref("p"), "purpose": "development",
                "exposure": {"seenInTraining": False, "graderLabelExposed": False}, "ancestry": []}
        decision = reduce(algorithm, decision, config, {"tasks.consume": value({
            "tasks": [task], "cursor": {"viewDigest": view["digest"], "nextIndex": 1}})})
        self.assertEqual(len(decision.operations), 2)
        decision = reduce(algorithm, decision, config, {
            "rollout.baseline.task1.0": execution("x"),
            "rollout.baseline.task1.1": execution("y"),
        })
        decision = reduce(algorithm, decision, config, {"diagnose.0": execution("d", {
            "severity": 0.8, "hypothesis": "tool call failed"})})
        proposed = ref("c", "harness.directory.v1")
        decision = reduce(algorithm, decision, config, {"propose.0": execution("q", produced=proposed)})
        self.assertEqual(decision.operations[0].kind, "bindings.derive")
        candidate = binding("b", "rho.bindings.v1")
        decision = reduce(algorithm, decision, config, {"derive.0": value({"bindingSetRef": candidate})})
        self.assertEqual(decision.operations[0].bindingSetRef.digest, candidate["digest"])
        decision = reduce(algorithm, decision, config, {
            "rollout.candidate.0.task1.0": execution("z")})
        self.assertEqual(decision.operations[0].input["baselineEvidenceRef"], ref("x"))
        assert decision.operations[0].input["candidateEvidenceRef"] == ref("z")
        positive = reduce(algorithm, decision, config, {"prefer.0.task1": execution("f", {
            "preference": 3, "rationale": "candidate is better"})})
        self.assertTrue(positive.complete)
        self.assertEqual(positive.bindingTransition.digest, candidate["digest"])
        self.assertEqual(positive.nextState["signal"], "unlabeled paired self-preference")
        zero = reduce(algorithm, decision, config, {"prefer.0.task1": execution("f", {
            "preference": 0, "rationale": "tie"})})
        self.assertFalse(zero.nextState["accepted"])
        self.assertIsNone(zero.bindingTransition)

    def test_ahe_measures_executed_revision_and_verifies_previous_prediction(self):
        self.assertEqual(verify_predictions({"predictedFixes": ["t2"], "riskTasks": ["t1"]},
                         {"t1": True, "t2": False}, {"t1": False, "t2": True}),
                         {"confirmedFixes": ["t2"], "missedFixes": [], "regressions": ["t1"]})
        recipe = Ahe()
        old = binding("a", "ahe.bindings.v1")
        new = binding("b", "ahe.bindings.v1")
        config = {"taskViewRef": ref("t", "task.view.v1"), "experienceViewRef": ref("e", "experience.view.v1"),
                  "asOf": {"namespace": "deployment:x", "value": "1"}, "taskCount": 2,
                  "rounds": 2, "rolloutsPerTask": 1, "samplingDigest": "s" * 64,
                  "environmentDigest": "v" * 64, "operationLimits": METERED_LIMITS}
        task = lambda name: {"id": name, "contentRef": ref(name), "purpose": "development",
                             "exposure": {"seenInTraining": False, "graderLabelExposed": False}, "ancestry": []}
        start = recipe.initialize({"config": config, "activeBindingSetRef": old})
        evaluated = reduce(recipe, start, config, {"tasks.consume": value({"tasks": [task("t1"), task("t2")]})})
        self.assertTrue(all(op.bindingSetRef.digest == old["digest"] for op in evaluated.operations))
        feedback = reduce(recipe, evaluated, config, {
            "rollout.t1.0": execution("x"), "rollout.t2.0": execution("y")})
        measured = reduce(recipe, feedback, config, {
            "feedback.t1": execution("f", {"score": 1, "passed": True}),
            "feedback.t2": execution("g", {"score": 0, "passed": False})})
        self.assertEqual(measured.nextState["bestMeasured"]["bindingSetRef"], old)
        self.assertEqual(measured.operations[0].kind, "evidence.query")
        queried = reduce(recipe, measured, config, {"history.query": value({"items": []})})
        self.assertEqual(queried.operations[0].input["projection"], "trace-chunk")
        queried = reduce(recipe, queried, config, {"history.query": value({"items": []})})
        self.assertEqual(queried.operations[0].kind, "execution.workspace-edit")
        proposed = reduce(recipe, queried, config, {"propose": execution("p",
            {"predictedFixes": ["t2"], "riskTasks": ["t1"], "changedFiles": ["prompt.md"]},
            ref("c", "harness.directory.v1"))})
        next_revision = reduce(recipe, proposed, config, {"propose.derive": value({"bindingSetRef": new})})
        self.assertEqual(next_revision.nextState["executedRevision"], new)
        self.assertEqual(next_revision.nextState["bestMeasured"]["bindingSetRef"], old)
        second_feedback = reduce(recipe, next_revision, config, {
            "rollout.t1.0": execution("u"), "rollout.t2.0": execution("v")})
        attribution = reduce(recipe, second_feedback, config, {
            "feedback.t1": execution("h", {"score": 0, "passed": False}),
            "feedback.t2": execution("i", {"score": 1, "passed": True})})
        self.assertEqual(attribution.nextState["predictionVerdict"]["confirmedFixes"], ["t2"])
        self.assertEqual(attribution.nextState["predictionVerdict"]["regressions"], ["t1"])
        self.assertEqual(attribution.nextState["bestMeasured"]["bindingSetRef"], old)  # equal score, no promotion
        self.assertEqual(attribution.operations[0].input["projection"], "task-report")
        attribution = reduce(recipe, attribution, config, {"history.query": value({"items": [
            {"entryId": "second-report", "taskId": "t1", "contentRef": ref("r")}]})})
        attribution = reduce(recipe, attribution, config, {"history.read.0": value({
            "text": json.dumps({"narrative": "regressed on t1"}), "receiptRef": ref("s")})})
        self.assertEqual(attribution.operations[0].input["projection"], "trace-chunk")
        attribution = reduce(recipe, attribution, config, {"history.query": value({"items": [
            {"entryId": "second-trace", "taskId": "t1", "contentRef": ref("w")}]})})
        attribution = reduce(recipe, attribution, config, {"history.read.0": value({
            "text": json.dumps({"sequence": 0, "text": "bad tool call"}), "receiptRef": ref("z")})})
        self.assertEqual(attribution.operations[0].bindingSetRef.digest, new["digest"])
        self.assertEqual(attribution.operations[0].input["evidenceReports"][0]["body"]["narrative"], "regressed on t1")
        self.assertEqual(attribution.operations[0].input["evidenceTraces"][0]["body"]["text"], "bad tool call")
        done = reduce(recipe, attribution, config, {"attribute": execution("a", {"rollbackFiles": ["prompt.md"]})})
        self.assertEqual(done.bindingTransition.digest, old["digest"])
        self.assertEqual(done.nextState["executedRevision"], new)

    def test_ahe_reads_all_authorized_report_pages_before_proposal(self):
        recipe = Ahe()
        old = binding("a", "ahe.bindings.v1")
        config = {"experienceViewRef": ref("e", "experience.view.v1"),
                  "asOf": {"namespace": "deployment:x", "value": "1"}, "taskCount": 1,
                  "operationLimits": METERED_LIMITS}
        state = {"phase": "history-query", "historyScope": ["task-1"],
                 "evidenceReports": [], "evidenceTraces": [], "evidenceProjection": "task-report",
                 "afterEvidence": "propose", "executedRevision": old,
                 "measurement": {"score": 0}, "bestMeasured": {"bindingSetRef": old}}
        first = recipe.reduce({"state": state, "config": config, "completed": {
            "history.query": value({"items": [{"entryId": "one", "taskId": "task-1", "contentRef": ref("r")}],
                                    "nextPageToken": "next"})}})
        self.assertEqual(first.operations[0].kind, "evidence.read")
        second = reduce(recipe, first, config, {"history.read.0": value({
            "text": json.dumps({"narrative": "report one"}), "receiptRef": ref("s")})})
        self.assertEqual(second.operations[0].input["pageToken"], "next")
        third = reduce(recipe, second, config, {"history.query": value({"items": []})})
        self.assertEqual(third.operations[0].input["projection"], "trace-chunk")
        fourth = reduce(recipe, third, config, {"history.query": value({"items": []})})
        self.assertEqual(fourth.operations[0].input["evidenceReports"][0]["body"],
                         {"narrative": "report one"})

    def test_ahe_next_round_uses_executed_revision_when_working_revision_is_none(self):
        recipe = Ahe()
        old = binding("a", "ahe.bindings.v1")
        executed = binding("b", "ahe.bindings.v1")
        state = {"phase": "attribute", "executedRevision": executed,
                 "workingRevision": None, "measurement": {"taskPassed": {"t1": False}},
                 "bestMeasured": {"bindingSetRef": old}, "predictionVerdict": {},
                 "evidenceReports": [], "evidenceTraces": []}
        config = {"operationLimits": METERED_LIMITS}
        proposal = recipe.reduce({"state": state, "config": config,
                                  "completed": {"attribute": execution("a", {"rollbackFiles": []})}})
        self.assertEqual(proposal.operations[0].bindingSetRef.digest, executed["digest"])
        self.assertEqual(proposal.operations[0].input["baseBindingSetRef"], executed)
        derive = reduce(recipe, proposal, config, {"propose": execution("p", {
            "predictedFixes": [], "riskTasks": []}, ref("c", "harness.directory.v1"))})
        self.assertEqual(derive.operations[0].input["baseRef"], executed)

    def test_evo_freezes_batch_skills_and_commits_cursor_with_new_binding(self):
        recipe = Evo()
        old = binding("a", "evo.bindings.v1")
        new = binding("b", "evo.bindings.v1")
        task_view = ref("t", "task.view.v1")
        config = {"taskViewRef": task_view, "batchSize": 2, "injectionBudget": 1,
                  "samplingDigest": "s" * 64, "environmentDigest": "v" * 64,
                  "operationLimits": EVO_LIMITS}
        task = lambda name: {"id": name, "contentRef": ref(name), "purpose": "development",
                             "exposure": {"seenInTraining": False, "graderLabelExposed": False}, "ancestry": []}
        start = recipe.initialize({"config": config, "activeBindingSetRef": old})
        fetched = reduce(recipe, start, config, {"tasks.consume": value({
            "tasks": [task("t1"), task("t2")],
            "cursor": {"viewDigest": task_view["digest"], "nextIndex": 2}})})
        skill = ref("s", "skill.markdown.v1")
        retrieved = reduce(recipe, fetched, config, {
            "retrieve.t1": execution("r", {"skillRefs": [skill]}),
            "retrieve.t2": execution("q", {"skillRefs": []})})
        self.assertTrue(all(op.bindingSetRef.digest == old["digest"] for op in retrieved.operations))
        self.assertEqual(retrieved.operations[0].input["injectedSkillRefs"], [skill])
        rolled = reduce(recipe, retrieved, config, {
            "rollout.t1": execution("x"), "rollout.t2": execution("y")})
        feedback = reduce(recipe, rolled, config, {
            "feedback.t1": execution("f", {"score": 0, "passed": False}),
            "feedback.t2": execution("g", {"score": 1, "passed": True})})
        self.assertEqual(feedback.nextState["cursor"]["nextIndex"], 0)
        reflected = reduce(recipe, feedback, config, {
            "reflect.t1": execution("p", {"action": "NEW", "lesson": "verify output"})})
        curated = reduce(recipe, reflected, config, {
            "curate": execution("c", {"action": "ADD"}, ref("n", "skills.library.v1"))})
        committed = reduce(recipe, curated, config, {"skills.derive": value({"bindingSetRef": new})})
        self.assertEqual(committed.nextState["cursor"]["nextIndex"], 2)
        self.assertEqual(committed.bindingTransition.digest, new["digest"])
        self.assertEqual(committed.nextState["batchHistory"][0]["frozenSkillsBindingSetRef"], old)
        self.assertNotIn("batchTasks", committed.nextState)
        done = reduce(recipe, committed, config, {"tasks.consume": value({"tasks": [],
             "cursor": {"viewDigest": task_view["digest"], "nextIndex": 2}})})
        self.assertTrue(done.complete)


if __name__ == "__main__":
    unittest.main()
