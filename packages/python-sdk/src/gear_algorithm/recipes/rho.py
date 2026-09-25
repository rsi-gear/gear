"""One-pass retrospective harness optimization over a sealed, label-free history."""
from __future__ import annotations

import json
import math
from typing import Any, Callable

from gear_algorithm.errors import ValidationError
from gear_algorithm.manifest import AlgorithmManifest
from gear_algorithm.protocol import BindingSetRef
from gear_algorithm.steps import operation
from .common import (OPERATION_LIMITS_SCHEMA, advance_state, apply_operation_limits,
                     require_execution, require_ref, result, rollout_authorization, structured)

_KINDS = frozenset({"evidence.query", "evidence.read", "tasks.select", "tasks.consume",
                    "execution.role", "execution.rollout", "execution.feedback",
                    "execution.workspace-edit", "bindings.derive"})


def select_coreset(judgments: list[dict[str, Any]], size: int, theta: float = 0.7) -> list[str]:
    """Greedy quality-weighted volume selection; role-produced vectors carry diversity.

    This is the exact greedy DPP-style policy used by this experimental recipe,
    not a claim of byte-level equivalence with the paper's embedding model.
    """
    if not judgments or not isinstance(size, int) or isinstance(size, bool) or size < 1 or size > len(judgments) or not 0 < theta < 1:
        raise ValidationError("Invalid coreset size or quality/diversity weight")
    dimension = len(judgments[0].get("fingerprint", []))
    if dimension == 0:
        raise ValidationError("Difficulty judge must provide fingerprint vectors")
    ids = set()
    for item in judgments:
        vector = item.get("fingerprint")
        difficulty = item.get("difficulty")
        if not isinstance(item.get("taskId"), str) or item["taskId"] in ids:
            raise ValidationError("Coreset tasks must have unique IDs")
        ids.add(item["taskId"])
        if not isinstance(vector, list) or len(vector) != dimension or not all(
            isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in vector
        ):
            raise ValidationError("Difficulty fingerprints need matching finite vectors")
        if not isinstance(difficulty, (int, float)) or isinstance(difficulty, bool) or not math.isfinite(difficulty) or not 0 <= difficulty <= 10:
            raise ValidationError("Difficulty must be in [0,10]")
    highest = max(max(float(item["difficulty"]), 0.01) for item in judgments)
    alpha = theta / (2 * (1 - theta))
    vectors = {}
    for item in judgments:
        vector = [float(x) for x in item["fingerprint"]]
        norm = math.sqrt(sum(x * x for x in vector))
        if norm == 0:
            raise ValidationError("Difficulty fingerprint cannot be zero")
        quality = (max(float(item["difficulty"]), 0.01) / highest) ** alpha
        vectors[item["taskId"]] = [quality * x / norm for x in vector]
    basis: list[list[float]] = []
    selected: list[str] = []
    for _ in range(size):
        options = []
        for task_id, vector in vectors.items():
            if task_id in selected:
                continue
            residual = vector[:]
            for direction in basis:
                projection = sum(a * b for a, b in zip(residual, direction))
                residual = [a - projection * b for a, b in zip(residual, direction)]
            score = sum(x * x for x in residual)
            options.append((score, task_id, residual))
        options.sort(key=lambda item: (-item[0], item[1]))
        _, task_id, residual = options[0]
        selected.append(task_id)
        norm = math.sqrt(sum(x * x for x in residual))
        if norm > 1e-12:
            basis.append([x / norm for x in residual])
    return selected


class Rho:
    def __init__(self, selector: Callable[[list[dict[str, Any]], int], list[str]] = select_coreset):
        self.selector = selector

    def describe(self) -> AlgorithmManifest:
        return AlgorithmManifest("rho.one-pass", {"type": "object"}, {
            "type": "object", "properties": {
                "experienceViewRef": {"type": "any"}, "asOf": {"type": "any"},
                "coresetSize": {"type": "integer"}, "historyPageSize": {"type": "integer"},
                "baselineRepeats": {"type": "integer"}, "proposalCount": {"type": "integer"},
                "samplingDigest": {"type": "string"}, "environmentDigest": {"type": "string"},
                "historyTraceAvailable": {"type": "boolean"},
                "operationLimits": OPERATION_LIMITS_SCHEMA,
            }, "required": ["experienceViewRef", "asOf", "coresetSize", "historyPageSize",
                             "baselineRepeats", "proposalCount", "samplingDigest", "environmentDigest"],
            "additionalProperties": False,
        }, {"id": "rho.bindings.v1", "slots": {
            "harness": {"schemaId": "harness.directory.v1", "required": True, "replaceable": True},
        }}, requiredOperationKinds=tuple(sorted(_KINDS)))

    def initialize(self, context: dict[str, Any]):
        return apply_operation_limits(self._initialize(context), context["config"], _KINDS)

    def _initialize(self, context: dict[str, Any]):
        config = context["config"]
        if (min(config["coresetSize"], config["historyPageSize"], config["proposalCount"]) < 1
            or config["historyPageSize"] > 100 or config["baselineRepeats"] < 2):
            raise ValidationError("RHO requires positive sizes, at most 100 history items per page, and repeated baseline rollouts")
        state = {"phase": "history-query", "history": [], "pageToken": None,
                 "baselineBindingSetRef": context["activeBindingSetRef"]}
        return advance_state(state, [self._query(config, None)])

    @staticmethod
    def _query(config: dict[str, Any], token: str | None):
        value = {"viewRef": config["experienceViewRef"], "asOf": config["asOf"],
                 "projection": "overview", "pageSize": config["historyPageSize"]}
        if token is not None:
            value["pageToken"] = token
        return operation(key="history.query", kind="evidence.query", input=value)

    def reduce(self, context: dict[str, Any]):
        return apply_operation_limits(self._reduce(context), context["config"], _KINDS)

    def _reduce(self, context: dict[str, Any]):
        state = context["state"]
        config = context["config"]
        phase = state["phase"]
        if phase == "history-query":
            page = result(context, "history.query")
            items = [item for item in page["items"] if item.get("taskId")]
            next_token = page.get("nextPageToken")
            if not items:
                if next_token:
                    return advance_state({**state, "pageToken": next_token}, [self._query(config, next_token)])
                return self._judge(state, config)
            return advance_state({**state, "phase": "history-read", "pageItems": items,
                                  "pageToken": next_token},
                [operation(key=f"history.read.{index}", kind="evidence.read", input={
                    "viewRef": config["experienceViewRef"], "asOf": config["asOf"],
                    "contentDigest": item["contentRef"]["digest"]})
                 for index, item in enumerate(items)])
        if phase == "history-read":
            history = list(state["history"])
            for index, item in enumerate(state["pageItems"]):
                content = json.loads(result(context, f"history.read.{index}")["text"])
                if not isinstance(content, dict) or not isinstance(content.get("summary"), str) or not isinstance(content.get("tags"), list):
                    raise ValidationError("History overview is malformed")
                history.append({"taskId": item["taskId"], "entryId": item["entryId"],
                                "summary": content["summary"], "tags": content["tags"]})
            if state["pageToken"]:
                return advance_state({**state, "phase": "history-query", "history": history,
                                      "pageItems": []}, [self._query(config, state["pageToken"])])
            return self._judge({**state, "history": history}, config)
        if phase == "detail-query":
            page = result(context, "history.detail.query")
            items = page["items"]
            token = page.get("nextPageToken")
            if not items:
                if token:
                    return self._detail_query({**state, "detailPageToken": token}, config, token)
                return self._after_detail_projection(state, config)
            for item in items:
                if item.get("taskId") not in state["detailRecords"]:
                    raise ValidationError("History detail names a task outside the coreset source")
                require_ref(item.get("contentRef"), "history detail content")
            return advance_state({**state, "phase": "detail-read", "detailItems": items,
                                  "detailPageToken": token}, [
                operation(key=f"history.detail.read.{index}", kind="evidence.read", input={
                    "viewRef": config["experienceViewRef"], "asOf": config["asOf"],
                    "contentDigest": item["contentRef"]["digest"]})
                for index, item in enumerate(items)])
        if phase == "detail-read":
            records = {task_id: {"taskReports": list(value["taskReports"]),
                                 "traceChunks": list(value["traceChunks"])}
                       for task_id, value in state["detailRecords"].items()}
            field = "taskReports" if state["detailProjection"] == "task-report" else "traceChunks"
            for index, item in enumerate(state["detailItems"]):
                read = result(context, f"history.detail.read.{index}")
                body = json.loads(read["text"])
                if (not isinstance(body, dict)
                    or (field == "taskReports" and not isinstance(body.get("narrative"), str))
                    or (field == "traceChunks" and (not isinstance(body.get("text"), str)
                        or not isinstance(body.get("sequence"), int)))):
                    raise ValidationError("History task report or trace is malformed")
                records[item["taskId"]][field].append({"entryId": item["entryId"], "body": body,
                    "contentRef": item["contentRef"],
                    "readReceiptRef": require_ref(read.get("receiptRef"), "history detail read receipt")})
            next_state = {**state, "detailRecords": records}
            if state["detailPageToken"]:
                return self._detail_query(next_state, config, state["detailPageToken"])
            return self._after_detail_projection(next_state, config)
        if phase == "difficulty":
            judged = []
            for index, history in enumerate(state["history"]):
                value = structured(context, f"difficulty.{index}")
                judged.append({"taskId": history["taskId"], "difficulty": value["difficulty"],
                               "fingerprint": value["fingerprint"]})
            chosen = self.selector(judged, config["coresetSize"])
            available = {item["taskId"] for item in judged}
            if not isinstance(chosen, list) or len(chosen) != config["coresetSize"] or len(set(chosen)) != len(chosen) or any(
                not isinstance(task_id, str) or task_id not in available for task_id in chosen
            ):
                raise ValidationError("RHO coreset selector returned invalid task IDs")
            return advance_state({**state, "phase": "selected", "coreset": chosen,
                                  "difficulty": judged},
                [operation(key="tasks.select", kind="tasks.select", input={
                    "experienceViewRef": config["experienceViewRef"],
                    "tasks": [{"id": task_id, "purpose": "development"} for task_id in chosen]})])
        if phase == "selected":
            view_ref = result(context, "tasks.select")["taskViewRef"]
            cursor = {"viewDigest": view_ref["digest"], "nextIndex": 0}
            return advance_state({**state, "phase": "consume", "taskViewRef": view_ref},
                [operation(key="tasks.consume", kind="tasks.consume",
                           input={"taskViewRef": view_ref, "cursor": cursor, "count": len(state["coreset"])})])
        if phase == "consume":
            tasks = result(context, "tasks.consume")["tasks"]
            if len(tasks) != len(state["coreset"]):
                raise ValidationError("Selected coreset task view is incomplete")
            return advance_state({**state, "phase": "baseline", "tasks": tasks},
                [self._rollout(task, repeat, config, state["taskViewRef"], "baseline")
                 for index, task in enumerate(tasks) for repeat in range(config["baselineRepeats"])])
        if phase == "baseline":
            baseline = {}
            operations = []
            for index, task in enumerate(state["tasks"]):
                runs = [require_execution(result(context, f"rollout.baseline.{task['id']}.{repeat}"), "baseline rollout")
                        for repeat in range(config["baselineRepeats"])]
                baseline[task["id"]] = runs
                operations.append(operation(key=f"diagnose.{index}", kind="execution.role", input={
                    "roleId": "rho.diagnoser", "task": task, "rolloutEvidenceRefs": [run["evidenceRef"] for run in runs],
                    "authorizedRollouts": [rollout_authorization(run) for run in runs],
                    "taskViewRef": state["taskViewRef"]}))
            return advance_state({**state, "phase": "diagnose", "baseline": baseline}, operations)
        if phase == "diagnose":
            diagnoses = [structured(context, f"diagnose.{index}") for index in range(len(state["tasks"]))]
            return advance_state({**state, "phase": "propose", "diagnoses": diagnoses},
                [operation(key=f"propose.{index}", kind="execution.workspace-edit", input={
                    "roleId": "rho.optimizer", "proposalIndex": index, "diagnoses": diagnoses,
                    "baseBindingSetRef": state["baselineBindingSetRef"]},
                    binding_set_ref=BindingSetRef(state["baselineBindingSetRef"]["digest"],
                                                  state["baselineBindingSetRef"]["schemaId"]))
                 for index in range(config["proposalCount"])])
        if phase == "propose":
            candidates = {}
            derive = []
            for index in range(config["proposalCount"]):
                outcome = context["completed"][f"propose.{index}"]
                if outcome["kind"] == "no-result":
                    continue
                value = require_execution(result(context, f"propose.{index}"), "proposal")
                artifact = require_ref(value.get("producedArtifactRef"), "proposal artifact")
                candidates[str(index)] = {"harnessRef": artifact}
                derive.append(operation(key=f"derive.{index}", kind="bindings.derive", input={
                    "baseRef": state["baselineBindingSetRef"], "replacements": {"harness": artifact}}))
            if not candidates:
                return advance_state({**state, "phase": "done", "accepted": False,
                                      "reason": "no valid candidate"}, complete=True)
            return advance_state({**state, "phase": "derive", "candidates": candidates}, derive)
        if phase == "derive":
            candidates = dict(state["candidates"])
            operations = []
            for index, candidate in candidates.items():
                candidate["bindingSetRef"] = result(context, f"derive.{index}")["bindingSetRef"]
                for task in state["tasks"]:
                    operations.append(self._rollout(task, 0, config, state["taskViewRef"],
                                                    f"candidate.{index}", candidate["bindingSetRef"]))
            return advance_state({**state, "phase": "candidate-rollout", "candidates": candidates}, operations)
        if phase == "candidate-rollout":
            candidate_runs = {}
            preferences = []
            for index in state["candidates"]:
                candidate_runs[index] = {}
                for task in state["tasks"]:
                    trial = require_execution(result(context, f"rollout.candidate.{index}.{task['id']}.0"), "candidate rollout")
                    candidate_runs[index][task["id"]] = trial
                    baseline = state["baseline"][task["id"]][0]  # fixed first baseline trajectory
                    preferences.append(operation(key=f"prefer.{index}.{task['id']}", kind="execution.feedback", input={
                        "mode": "rho.self-preference", "task": task,
                        "candidateEvidenceRef": trial["evidenceRef"],
                        "baselineEvidenceRef": baseline["evidenceRef"],
                        "authorizedRollouts": [rollout_authorization(baseline), rollout_authorization(trial)],
                        "taskViewRef": state["taskViewRef"]}))
            return advance_state({**state, "phase": "preference", "candidateRuns": candidate_runs}, preferences)
        if phase == "preference":
            scores = {}
            for index in state["candidates"]:
                values = []
                for task in state["tasks"]:
                    preference = structured(context, f"prefer.{index}.{task['id']}")["preference"]
                    if not isinstance(preference, (int, float)) or isinstance(preference, bool) or not math.isfinite(preference) or not -10 <= preference <= 10:
                        raise ValidationError("RHO self-preference must be finite in [-10,10]")
                    values.append(float(preference))
                scores[index] = sum(values) / len(values)
            winner = sorted(scores, key=lambda index: (-scores[index], int(index)))[0]
            accepted = scores[winner] > 0
            return advance_state({**state, "phase": "done", "softPreferenceMeans": scores,
                                  "accepted": accepted, "selectedCandidate": winner if accepted else None,
                                  "signal": "unlabeled paired self-preference"},
                                 transition=state["candidates"][winner]["bindingSetRef"] if accepted else None,
                                 complete=True)
        raise ValidationError(f"Unknown RHO phase {phase}")

    @staticmethod
    def _judge(state: dict[str, Any], config: dict[str, Any]):
        by_task: dict[str, dict[str, Any]] = {}
        for item in state["history"]:
            previous = by_task.get(item["taskId"])
            if previous is None:
                by_task[item["taskId"]] = dict(item)
            else:
                previous["summary"] += "\n" + item["summary"]
                previous["tags"] = sorted(set(previous["tags"]) | set(item["tags"]))
        history = [by_task[task_id] for task_id in sorted(by_task)]
        if len(history) < config["coresetSize"]:
            raise ValidationError("Insufficient historical tasks for RHO coreset")
        details = {task_id: {"taskReports": [], "traceChunks": []} for task_id in by_task}
        return Rho._detail_query({**state, "history": history, "detailRecords": details,
                                  "detailProjection": "task-report"}, config, None)

    @staticmethod
    def _detail_query(state: dict[str, Any], config: dict[str, Any], token: str | None):
        query = {"viewRef": config["experienceViewRef"], "asOf": config["asOf"],
                 "projection": state["detailProjection"], "pageSize": config["historyPageSize"],
                 "scope": {"taskIds": [item["taskId"] for item in state["history"]]}}
        if token:
            query["pageToken"] = token
        return advance_state({**state, "phase": "detail-query"}, [
            operation(key="history.detail.query", kind="evidence.query", input=query)])

    @staticmethod
    def _after_detail_projection(state: dict[str, Any], config: dict[str, Any]):
        if state["detailProjection"] == "task-report" and config.get("historyTraceAvailable", True):
            return Rho._detail_query({**state, "detailProjection": "trace-chunk",
                                      "detailPageToken": None}, config, None)
        histories = [{**item, **state["detailRecords"][item["taskId"]]} for item in state["history"]]
        return advance_state({**state, "phase": "difficulty", "history": histories},
            [operation(key=f"difficulty.{index}", kind="execution.role", input={
                "roleId": "rho.difficulty", "history": item,
                "experienceViewRef": config["experienceViewRef"]})
             for index, item in enumerate(histories)])

    @staticmethod
    def _rollout(task: dict[str, Any], repeat: int, config: dict[str, Any], task_view_ref: dict[str, Any],
                 phase: str, candidate_binding: dict[str, Any] | None = None):
        key = f"rollout.{phase}.{task['id']}.{repeat}"
        return operation(key=key, kind="execution.rollout", input={
            "task": task, "taskViewRef": task_view_ref, "repeatIndex": repeat,
            "samplingDigest": config["samplingDigest"], "environmentDigest": config["environmentDigest"],
            "recipePhase": phase},
            **({"binding_set_ref": BindingSetRef(
                candidate_binding["digest"], candidate_binding["schemaId"])} if candidate_binding else {}))


algorithm = Rho()
