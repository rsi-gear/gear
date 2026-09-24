"""Replayable Evo-Harness batches with frozen skills and atomic cursor promotion."""
from __future__ import annotations

import math
from typing import Any

from gear_algorithm.errors import ValidationError
from gear_algorithm.manifest import AlgorithmManifest
from gear_algorithm.protocol import BindingSetRef
from gear_algorithm.steps import operation
from .common import (OPERATION_LIMITS_SCHEMA, advance_state, apply_operation_limits,
                     require_execution, require_ref, result, structured)

_KINDS = frozenset({"tasks.consume", "execution.role", "execution.rollout",
                    "execution.feedback", "bindings.derive"})


class Evo:
    def describe(self) -> AlgorithmManifest:
        return AlgorithmManifest("evo.skill-batches", {"type": "object"}, {
            "type": "object", "properties": {
                "taskViewRef": {"type": "any"}, "batchSize": {"type": "integer"},
                "injectionBudget": {"type": "integer"}, "samplingDigest": {"type": "string"},
                "environmentDigest": {"type": "string"},
                "operationLimits": OPERATION_LIMITS_SCHEMA,
            }, "required": ["taskViewRef", "batchSize", "injectionBudget",
                             "samplingDigest", "environmentDigest"], "additionalProperties": False,
        }, {"id": "evo.bindings.v1", "slots": {
            "skills": {"schemaId": "skills.library.v1", "required": True, "replaceable": True},
        }})

    def initialize(self, context: dict[str, Any]):
        return apply_operation_limits(self._initialize(context), context["config"], _KINDS)

    def _initialize(self, context: dict[str, Any]):
        config = context["config"]
        if config["batchSize"] < 1 or config["injectionBudget"] < 0:
            raise ValidationError("Evo batch size and injection budget are invalid")
        cursor = {"viewDigest": config["taskViewRef"]["digest"], "nextIndex": 0}
        state = {"phase": "consume", "cursor": cursor, "batchNumber": 0,
                 "skillsBindingSetRef": context["activeBindingSetRef"], "batchHistory": []}
        return self._consume(state, config)

    @staticmethod
    def _consume(state: dict[str, Any], config: dict[str, Any], transition: dict[str, Any] | None = None):
        return advance_state({**state, "phase": "consume"}, [
            operation(key="tasks.consume", kind="tasks.consume", input={
                "taskViewRef": config["taskViewRef"], "cursor": state["cursor"], "count": config["batchSize"]})],
            transition=transition)

    def reduce(self, context: dict[str, Any]):
        return apply_operation_limits(self._reduce(context), context["config"], _KINDS)

    def _reduce(self, context: dict[str, Any]):
        state = context["state"]
        config = context["config"]
        phase = state["phase"]
        frozen = state["skillsBindingSetRef"]
        if phase == "consume":
            batch = result(context, "tasks.consume")
            tasks = batch["tasks"]
            if not tasks:
                return advance_state({**state, "phase": "done"}, complete=True)
            return advance_state({**state, "phase": "retrieve", "batchTasks": tasks,
                                  "nextCursor": batch["cursor"], "batchBindingSetRef": frozen}, [
                operation(key=f"retrieve.{task['id']}", kind="execution.role", input={
                    "roleId": "evo.retriever", "task": task, "taskViewRef": config["taskViewRef"],
                    "injectionBudget": config["injectionBudget"], "skillsBindingSetRef": frozen},
                    binding_set_ref=BindingSetRef(frozen["digest"], frozen["schemaId"]))
                for task in tasks])
        if phase == "retrieve":
            retrievals = {}
            runs = []
            for task in state["batchTasks"]:
                selected = structured(context, f"retrieve.{task['id']}")
                refs = selected.get("skillRefs")
                if not isinstance(refs, list) or len(refs) > config["injectionBudget"]:
                    raise ValidationError("Retriever exceeded skill injection budget")
                for ref in refs:
                    require_ref(ref, "retrieved skill")
                retrievals[task["id"]] = refs
                runs.append(operation(key=f"rollout.{task['id']}", kind="execution.rollout", input={
                    "task": task, "taskViewRef": config["taskViewRef"],
                    "injectedSkillRefs": refs, "skillBindingSetDigest": frozen["digest"],
                    "samplingDigest": config["samplingDigest"],
                    "environmentDigest": config["environmentDigest"], "recipePhase": "evo.batch"},
                    binding_set_ref=BindingSetRef(frozen["digest"], frozen["schemaId"])))
            return advance_state({**state, "phase": "rollout", "retrievals": retrievals}, runs)
        if phase == "rollout":
            runs = {}
            feedback = []
            for task in state["batchTasks"]:
                run = require_execution(result(context, f"rollout.{task['id']}"), "Evo rollout")
                runs[task["id"]] = run
                feedback.append(operation(key=f"feedback.{task['id']}", kind="execution.feedback", input={
                    "mode": "evo.task-feedback", "task": task, "taskViewRef": config["taskViewRef"],
                    "rolloutEvidenceRef": run["evidenceRef"],
                    "injectedSkillRefs": state["retrievals"][task["id"]]},
                    binding_set_ref=BindingSetRef(frozen["digest"], frozen["schemaId"])))
            return advance_state({**state, "phase": "feedback", "rollouts": runs}, feedback)
        if phase == "feedback":
            feedback = {}
            reflections = []
            for task in state["batchTasks"]:
                value = structured(context, f"feedback.{task['id']}")
                score = value.get("score")
                if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score) or not 0 <= score <= 1:
                    raise ValidationError("Evo feedback score must be finite in [0,1]")
                if not isinstance(value.get("passed"), bool):
                    raise ValidationError("Evo feedback requires grounded passed flag")
                feedback[task["id"]] = value
                if not value["passed"]:
                    reflections.append(operation(key=f"reflect.{task['id']}", kind="execution.role", input={
                        "roleId": "evo.proposer", "task": task, "feedback": value,
                        "rolloutEvidenceRef": state["rollouts"][task["id"]]["evidenceRef"],
                        "injectedSkillRefs": state["retrievals"][task["id"]],
                        "skillsBindingSetRef": frozen},
                        binding_set_ref=BindingSetRef(frozen["digest"], frozen["schemaId"])))
            next_state = {**state, "feedback": feedback}
            if not reflections:
                return self._commit_batch(next_state, config, frozen, "no failed task")
            return advance_state({**next_state, "phase": "reflect",
                                  "failedTaskIds": [task["id"] for task in state["batchTasks"]
                                                    if not feedback[task["id"]]["passed"]]}, reflections)
        if phase == "reflect":
            proposals = []
            for task_id in state["failedTaskIds"]:
                outcome = context["completed"][f"reflect.{task_id}"]
                if outcome["kind"] == "no-result":
                    continue
                item = structured(context, f"reflect.{task_id}")
                if item.get("action") not in ("NEW", "ENHANCE", "NONE"):
                    raise ValidationError("Evo reflection action is invalid")
                if item["action"] != "NONE":
                    proposals.append({"taskId": task_id, **item})
            if not proposals:
                return self._commit_batch({**state, "proposals": []}, config, frozen, "no proposed skill")
            return advance_state({**state, "phase": "curate", "proposals": proposals}, [
                operation(key="curate", kind="execution.role", input={
                    "roleId": "evo.curator", "proposals": proposals, "skillsBindingSetRef": frozen,
                    "batchTaskIds": [task["id"] for task in state["batchTasks"]]},
                    binding_set_ref=BindingSetRef(frozen["digest"], frozen["schemaId"]))])
        if phase == "curate":
            outcome = context["completed"]["curate"]
            if outcome["kind"] == "no-result":
                return self._commit_batch(state, config, frozen, "curator skipped")
            curated = require_execution(result(context, "curate"), "Evo curated skill library")
            details = structured(context, "curate")
            if details.get("action") not in ("ADD", "MERGE", "REVISE", "SKIP"):
                raise ValidationError("Evo curator action is invalid")
            if details["action"] == "SKIP":
                return self._commit_batch(state, config, frozen, "curator skipped")
            artifact = require_ref(curated.get("producedArtifactRef"), "curated skill library")
            return advance_state({**state, "phase": "derive", "curation": details}, [
                operation(key="skills.derive", kind="bindings.derive", input={
                    "baseRef": frozen, "replacements": {"skills": artifact}})])
        if phase == "derive":
            next_skills = result(context, "skills.derive")["bindingSetRef"]
            return self._commit_batch(state, config, next_skills, state["curation"]["action"])
        raise ValidationError(f"Unknown Evo phase {phase}")

    def _commit_batch(self, state: dict[str, Any], config: dict[str, Any],
                      next_skills: dict[str, Any], outcome: str):
        history = [*state["batchHistory"], {
            "batchNumber": state["batchNumber"],
            "taskIds": [task["id"] for task in state["batchTasks"]],
            "frozenSkillsBindingSetRef": state["batchBindingSetRef"],
            "nextSkillsBindingSetRef": next_skills,
            "curation": outcome,
        }]
        next_state = {"cursor": state["nextCursor"], "skillsBindingSetRef": next_skills,
                      "batchNumber": state["batchNumber"] + 1, "batchHistory": history}
        # One Gear decision commits the cursor and new skills binding together.
        transition = next_skills if next_skills != state["batchBindingSetRef"] else None
        return self._consume(next_state, config, transition)


algorithm = Evo()
