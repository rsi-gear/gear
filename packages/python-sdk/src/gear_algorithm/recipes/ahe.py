"""Delayed-measurement AHE loop: measure an executed revision before proposing another."""
from __future__ import annotations

import math
import json
from typing import Any

from gear_algorithm.errors import ValidationError
from gear_algorithm.manifest import AlgorithmManifest
from gear_algorithm.protocol import BindingSetRef
from gear_algorithm.steps import operation
from .common import (OPERATION_LIMITS_SCHEMA, advance_state, apply_operation_limits,
                     require_execution, require_ref, result, structured)

_KINDS = frozenset({"tasks.consume", "evidence.query", "evidence.read", "execution.rollout",
                    "execution.feedback", "execution.role", "execution.workspace-edit", "bindings.derive"})


def verify_predictions(manifest: dict[str, Any], before: dict[str, bool], after: dict[str, bool]) -> dict[str, Any]:
    """Task deltas verify predictions; a rationale alone cannot count as evidence."""
    fixes = manifest.get("predictedFixes", [])
    risks = manifest.get("riskTasks", [])
    if not isinstance(fixes, list) or not isinstance(risks, list) or any(
        not isinstance(item, str) for item in fixes + risks
    ):
        raise ValidationError("AHE change manifest needs task ID prediction lists")
    if any(task_id not in before or task_id not in after for task_id in fixes + risks):
        raise ValidationError("AHE prediction names a task outside measured cohort")
    return {"confirmedFixes": [task_id for task_id in fixes if not before[task_id] and after[task_id]],
            "missedFixes": [task_id for task_id in fixes if not after[task_id]],
            "regressions": [task_id for task_id in risks if before[task_id] and not after[task_id]]}


class Ahe:
    def describe(self) -> AlgorithmManifest:
        return AlgorithmManifest("ahe.delayed-measurement", {"type": "object"}, {
            "type": "object", "properties": {
                "taskViewRef": {"type": "any"}, "experienceViewRef": {"type": "any"},
                "asOf": {"type": "any"}, "taskCount": {"type": "integer"},
                "rounds": {"type": "integer"}, "rolloutsPerTask": {"type": "integer"},
                "samplingDigest": {"type": "string"}, "environmentDigest": {"type": "string"},
                "operationLimits": OPERATION_LIMITS_SCHEMA,
            }, "required": ["taskViewRef", "experienceViewRef", "asOf", "taskCount",
                             "rounds", "rolloutsPerTask", "samplingDigest", "environmentDigest"],
            "additionalProperties": False,
        }, {"id": "ahe.bindings.v1", "slots": {
            "harness": {"schemaId": "harness.directory.v1", "required": True, "replaceable": True},
        }})

    def initialize(self, context: dict[str, Any]):
        return apply_operation_limits(self._initialize(context), context["config"], _KINDS)

    def _initialize(self, context: dict[str, Any]):
        config = context["config"]
        if min(config["taskCount"], config["rounds"], config["rolloutsPerTask"]) < 1:
            raise ValidationError("AHE task count, rounds and repetitions must be positive")
        current = context["activeBindingSetRef"]
        state = {"phase": "consume", "round": 0, "executedRevision": current,
                 "bestMeasured": None, "previousMeasurement": None, "pendingManifest": None}
        return advance_state(state, [operation(key="tasks.consume", kind="tasks.consume", input={
            "taskViewRef": config["taskViewRef"],
            "cursor": {"viewDigest": config["taskViewRef"]["digest"], "nextIndex": 0},
            "count": config["taskCount"]})])

    @staticmethod
    def _evaluate(state: dict[str, Any], config: dict[str, Any]):
        revision = state["executedRevision"]
        return advance_state({**state, "phase": "evaluate"}, [
            operation(key=f"rollout.{task['id']}.{repeat}", kind="execution.rollout", input={
                "task": task, "taskViewRef": config["taskViewRef"], "repeatIndex": repeat,
                "samplingDigest": config["samplingDigest"], "environmentDigest": config["environmentDigest"],
                "recipePhase": "ahe.measure", "executedRevisionDigest": revision["digest"]},
                binding_set_ref=BindingSetRef(revision["digest"], revision["schemaId"]))
            for task in state["tasks"] for repeat in range(config["rolloutsPerTask"])])

    def reduce(self, context: dict[str, Any]):
        return apply_operation_limits(self._reduce(context), context["config"], _KINDS)

    def _reduce(self, context: dict[str, Any]):
        state = context["state"]
        config = context["config"]
        phase = state["phase"]
        if phase == "consume":
            tasks = result(context, "tasks.consume")["tasks"]
            if not tasks:
                raise ValidationError("AHE needs a measured task cohort")
            return self._evaluate({**state, "tasks": tasks}, config)
        if phase == "evaluate":
            runs = {}
            feedback = []
            for task in state["tasks"]:
                values = [require_execution(result(context, f"rollout.{task['id']}.{repeat}"), "AHE rollout")
                          for repeat in range(config["rolloutsPerTask"])]
                runs[task["id"]] = values
                feedback.append(operation(key=f"feedback.{task['id']}", kind="execution.feedback", input={
                    "mode": "ahe.task-measurement", "task": task, "taskViewRef": config["taskViewRef"],
                    "rolloutEvidenceRefs": [value["evidenceRef"] for value in values],
                    "executedRevisionDigest": state["executedRevision"]["digest"]},
                    binding_set_ref=BindingSetRef(state["executedRevision"]["digest"],
                                                  state["executedRevision"]["schemaId"])))
            return advance_state({**state, "phase": "feedback", "rollouts": runs}, feedback)
        if phase == "feedback":
            per_task: dict[str, bool] = {}
            scores = []
            for task in state["tasks"]:
                measured = structured(context, f"feedback.{task['id']}")
                score = measured.get("score")
                if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score) or not 0 <= score <= 1:
                    raise ValidationError("AHE task measurement must be finite in [0,1]")
                if not isinstance(measured.get("passed"), bool):
                    raise ValidationError("AHE task measurement needs a grounded passed flag")
                per_task[task["id"]] = measured["passed"]
                scores.append(float(score))
            measurement = {"bindingSetRef": state["executedRevision"], "score": sum(scores) / len(scores),
                           "taskPassed": per_task, "round": state["round"],
                           "rolloutEvidenceRefs": {task_id: [run["evidenceRef"] for run in runs]
                                                   for task_id, runs in state["rollouts"].items()}}
            best = state["bestMeasured"]
            if best is None or measurement["score"] > best["score"]:
                best = measurement
            next_state = {**state, "phase": "measured", "measurement": measurement,
                          "bestMeasured": best}
            if state["pendingManifest"] is not None:
                previous = state["previousMeasurement"]
                if previous is None:
                    raise ValidationError("AHE pending manifest has no previous measurement")
                verdict = verify_predictions(state["pendingManifest"], previous["taskPassed"], per_task)
                terminal = state["round"] + 1 >= config["rounds"]
                return self._investigate({**next_state, "predictionVerdict": verdict}, config,
                                         "final-attribute" if terminal else "attribute")
            if state["round"] + 1 >= config["rounds"]:
                return advance_state({**next_state, "phase": "done", "selectedBestMeasured": best["bindingSetRef"]},
                    transition=best["bindingSetRef"], complete=True)
            return self._investigate(next_state, config, "propose")
        if phase == "final-attribute":
            attribution = structured(context, "attribute")
            best = state["bestMeasured"]
            return advance_state({**state, "phase": "done", "attribution": attribution,
                                  "selectedBestMeasured": best["bindingSetRef"]},
                                 transition=best["bindingSetRef"], complete=True)
        if phase == "attribute":
            attribution = structured(context, "attribute")
            files = attribution.get("rollbackFiles", [])
            if not isinstance(files, list) or any(not isinstance(file, str) for file in files):
                raise ValidationError("AHE rollback file list is malformed")
            if files:
                return advance_state({**state, "phase": "rollback", "attribution": attribution}, [
                    operation(key="rollback", kind="execution.workspace-edit", input={
                        "roleId": "ahe.rollback", "files": files,
                        "baseBindingSetRef": state["executedRevision"],
                        "predictionVerdict": state["predictionVerdict"]},
                        binding_set_ref=BindingSetRef(state["executedRevision"]["digest"],
                                                      state["executedRevision"]["schemaId"]))])
            return self._propose({**state, "attribution": attribution})
        if phase == "rollback":
            changed = require_execution(result(context, "rollback"), "AHE rollback")
            artifact = require_ref(changed.get("producedArtifactRef"), "AHE rollback revision")
            return advance_state({**state, "phase": "rollback-derive"}, [
                operation(key="rollback.derive", kind="bindings.derive", input={
                    "baseRef": state["executedRevision"], "replacements": {"harness": artifact}})])
        if phase == "rollback-derive":
            working = result(context, "rollback.derive")["bindingSetRef"]
            return self._propose({**state, "workingRevision": working})
        if phase == "history-query":
            page = result(context, "history.query")
            items = page["items"]
            token = page.get("nextPageToken")
            if not items:
                if token:
                    return self._history_query({**state, "historyPageToken": token}, config, token)
                return self._after_evidence_projection(state, config)
            for item in items:
                require_ref(item.get("contentRef"), "AHE historical evidence content")
            return advance_state({**state, "phase": "history-read", "historyItems": items,
                                  "historyPageToken": token}, [
                operation(key=f"history.read.{index}", kind="evidence.read", input={
                    "viewRef": config["experienceViewRef"], "asOf": config["asOf"],
                    "contentDigest": item["contentRef"]["digest"]})
                for index, item in enumerate(items)])
        if phase == "history-read":
            evidence = []
            for index, item in enumerate(state["historyItems"]):
                read = result(context, f"history.read.{index}")
                body = json.loads(read["text"])
                if (not isinstance(body, dict)
                    or (state["evidenceProjection"] == "task-report" and not isinstance(body.get("narrative"), str))
                    or (state["evidenceProjection"] == "trace-chunk" and (not isinstance(body.get("text"), str)
                        or not isinstance(body.get("sequence"), int)))):
                    raise ValidationError("AHE task report or trace is malformed")
                evidence.append({"taskId": item.get("taskId"), "entryId": item["entryId"],
                                 "contentRef": item["contentRef"],
                                 "readReceiptRef": require_ref(read.get("receiptRef"), "AHE evidence read receipt"),
                                 "body": body})
            field = "evidenceReports" if state["evidenceProjection"] == "task-report" else "evidenceTraces"
            next_state = {**state, field: [*state[field], *evidence]}
            if state["historyPageToken"]:
                return self._history_query(next_state, config, state["historyPageToken"])
            return self._after_evidence_projection(next_state, config)
        if phase == "propose":
            outcome = context["completed"]["propose"]
            if outcome["kind"] == "no-result":
                best = state["bestMeasured"]
                return advance_state({**state, "phase": "done", "reason": "no new revision"},
                                     transition=best["bindingSetRef"], complete=True)
            edited = require_execution(result(context, "propose"), "AHE proposal")
            artifact = require_ref(edited.get("producedArtifactRef"), "AHE proposed revision")
            manifest = structured(context, "propose")
            verify_predictions(manifest, state["measurement"]["taskPassed"],
                               state["measurement"]["taskPassed"])
            base = state.get("workingRevision") or state["executedRevision"]
            return advance_state({**state, "phase": "propose-derive", "proposedManifest": manifest}, [
                operation(key="propose.derive", kind="bindings.derive", input={
                    "baseRef": base, "replacements": {"harness": artifact}})])
        if phase == "propose-derive":
            revision = result(context, "propose.derive")["bindingSetRef"]
            next_state = {**state, "phase": "evaluate", "round": state["round"] + 1,
                          "executedRevision": revision, "previousMeasurement": state["measurement"],
                          "pendingManifest": state["proposedManifest"], "workingRevision": None}
            return self._evaluate(next_state, config)
        raise ValidationError(f"Unknown AHE phase {phase}")

    @staticmethod
    def _investigate(state: dict[str, Any], config: dict[str, Any], after: str):
        failed = [task_id for task_id, passed in state["measurement"]["taskPassed"].items() if not passed]
        return Ahe._history_query({**state, "historyScope": failed, "evidenceReports": [],
                                   "evidenceTraces": [], "evidenceProjection": "task-report",
                                   "afterEvidence": after}, config, None)

    @staticmethod
    def _history_query(state: dict[str, Any], config: dict[str, Any], token: str | None):
        query = {"viewRef": config["experienceViewRef"], "asOf": config["asOf"],
                 "projection": state["evidenceProjection"], "pageSize": min(config["taskCount"], 100)}
        if state["historyScope"]:
            query["scope"] = {"taskIds": state["historyScope"]}
        if token:
            query["pageToken"] = token
        return advance_state({**state, "phase": "history-query"}, [
            operation(key="history.query", kind="evidence.query", input=query)])

    @staticmethod
    def _after_evidence_projection(state: dict[str, Any], config: dict[str, Any]):
        if state["evidenceProjection"] == "task-report":
            return Ahe._history_query({**state, "evidenceProjection": "trace-chunk",
                                       "historyPageToken": None}, config, None)
        if state["afterEvidence"] == "propose":
            return Ahe._propose(state)
        revision = state["executedRevision"]
        return advance_state({**state, "phase": state["afterEvidence"]}, [
            operation(key="attribute", kind="execution.role", input={
                "roleId": "ahe.attributor", "changeManifest": state["pendingManifest"],
                "predictionVerdict": state["predictionVerdict"],
                "previousMeasurement": state["previousMeasurement"],
                "currentMeasurement": state["measurement"],
                "evidenceReports": state["evidenceReports"],
                "evidenceTraces": state["evidenceTraces"]},
                binding_set_ref=BindingSetRef(revision["digest"], revision["schemaId"]))])

    @staticmethod
    def _propose(state: dict[str, Any]):
        base = state.get("workingRevision") or state["executedRevision"]
        return advance_state({**state, "phase": "propose"}, [
            operation(key="propose", kind="execution.workspace-edit", input={
                "roleId": "ahe.evolver", "baseBindingSetRef": base,
                "measurement": state["measurement"], "bestMeasured": state["bestMeasured"],
                "predictionVerdict": state.get("predictionVerdict"),
                "evidenceReports": state["evidenceReports"],
                "evidenceTraces": state["evidenceTraces"],
                "attribution": state.get("attribution")},
                binding_set_ref=BindingSetRef(base["digest"], base["schemaId"]))])


algorithm = Ahe()
