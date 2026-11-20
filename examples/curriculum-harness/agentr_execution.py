"""Concrete CPU retail execution and checkpoint reconstruction for Agent-R.

Rollback is available only because this caller owns a disposable in-memory
simulator. It is never interpreted as an undo operation on a live service.
"""

from __future__ import annotations

import json

from gear.canonical import digest
from gear.core.schema import validate_output
from gear.curriculum import ModelInput
from sentinel_collect import POLICY_AUDIT_PROMPT
from sentinel_generate import ACTION_SCHEMA, TEXT, USER_PROMPT, object_schema
from sentinel_retail import RetailSession, native_messages, replay_trace


def conversation(trace):
    result = [{"role": "user", "content": trace["opening"]}]
    for step in trace["steps"]:
        if step["kind"] == "tool":
            result.extend(
                [
                    {"role": "assistant", "tool_call": step["execution"]["call"]},
                    {"role": "tool", "content": step["execution"]["response"]["content"]},
                ]
            )
        else:
            result.append({"role": "assistant", "content": step["text"]})
            if step["kind"] == "message":
                result.append({"role": "user", "content": step["reply"]})
    return result


def restore(backend, config, steps):
    """Recreate every observed read/write and dialogue from the original DB."""
    if not isinstance(steps, list) or len(steps) > config["max_steps"]:
        raise ValueError("Agent-R checkpoint exceeds the original solver step limit")
    session = RetailSession(backend, config["database"], config["user_id"])
    steps = json.loads(json.dumps(steps, allow_nan=False))
    for index, step in enumerate(steps):
        if step["kind"] == "tool":
            if session.execute(step["action"], index) != step["execution"]:
                raise ValueError("Agent-R checkpoint tool feedback or state changed")
        elif step["kind"] == "message":
            if not step.get("text") or not step.get("reply"):
                raise ValueError("Agent-R checkpoint has an incomplete conversation")
        elif step["kind"] != "finish" or index != len(steps) - 1 or not step.get("text"):
            raise ValueError("Agent-R checkpoint has invalid or post-terminal steps")
    trace = {
        "schema_version": 1,
        "environment_id": session.identity,
        "initial": session.initial,
        "goal": config["task"]["user_scenario"]["instructions"],
        "opening": config["task"]["ticket"],
        "steps": steps,
        "status": "completed" if steps and steps[-1]["kind"] == "finish" else "incomplete",
        "final": session.snapshot(),
    }
    replay_trace(backend, config["database"], config["user_id"], trace, require_complete=False)
    return session, trace


def state(trace):
    return {
        "environment_id": trace["environment_id"],
        "database_digest": digest(trace["final"]),
        "conversation_digest": digest(conversation(trace)),
        "prefix_digest": digest(trace["steps"]),
        "steps": len(trace["steps"]),
    }


def rollback(backend, config, failed_steps, common_steps):
    if failed_steps[: len(common_steps)] != common_steps or len(common_steps) >= len(failed_steps):
        raise ValueError("rollback must restore an actual earlier shared prefix")
    _, failed = restore(backend, config, failed_steps)
    _, restored = restore(backend, config, common_steps)
    if restored["status"] == "completed":
        raise ValueError("a terminal checkpoint cannot begin a repair suffix")
    return {
        "mechanism": "fresh-retail-db-replay",
        "failed_prefix_digest": digest(failed),
        "restored_prefix_digest": digest(restored),
        "before": state(failed),
        "after": state(restored),
    }, restored


async def extend(backend, config, prefix, response, model_json, key):
    """Execute a single sampled action after an independently verified restore."""
    validate_output(ACTION_SCHEMA, response)
    session, trace = restore(backend, config, prefix)
    if trace["status"] == "completed":
        raise ValueError("cannot append an action to a terminal Agent-R branch")
    if len(prefix) >= config["max_steps"]:
        raise ValueError("Agent-R branch exhausted the original solver step limit")
    index = len(prefix)
    arguments = json.loads(response["arguments_json"])
    if not isinstance(arguments, dict):
        raise ValueError("Agent-R action arguments must be a JSON object")
    if response["kind"] == "tool":
        if response["text"]:
            raise ValueError("Agent-R tool action cannot also speak")
        action = {"name": response["name"], "arguments": arguments}
        step = {"kind": "tool", "action": action, "execution": session.execute(action, index)}
    else:
        if response["name"] or arguments or not response["text"].strip():
            raise ValueError("Agent-R customer messages require text and no tool arguments")
        step = {"kind": response["kind"], "text": response["text"]}
        if response["kind"] == "message":
            visible = conversation(trace) + [{"role": "assistant", "content": step["text"]}]
            reply = await model_json(
                key + "/user",
                ModelInput(
                    USER_PROMPT,
                    object_schema({"message": TEXT}),
                    {
                        "goal": trace["goal"],
                        "customer": session.user_material(),
                        "conversation": [
                            row
                            for row in visible
                            if "content" in row and row["role"] in ("user", "assistant")
                        ],
                    },
                ),
            )
            step["reply"] = reply["message"]
        else:
            trace["status"] = "completed"
    trace["steps"].append(step)
    trace["final"] = session.snapshot()
    return trace


async def grade(backend, config, task, trace, model_json, key):
    """Use the original task verifier; an unfinished branch has no reward."""
    from tau2.evaluator.evaluator_env import EnvironmentEvaluator

    _, _, issues = replay_trace(
        backend, config["database"], config["user_id"], trace, require_complete=False
    )
    result = {
        "complete": trace["status"] == "completed",
        "reward": None,
        "native": None,
        "semantic": None,
        "trace_checks": issues,
    }
    if not result["complete"]:
        return result

    def constructor(solo_mode=False):
        if solo_mode:
            raise ValueError("Agent-R retail requires dialogue mode")
        return RetailSession(backend, config["database"], config["user_id"]).environment

    native = EnvironmentEvaluator.calculate_reward(
        constructor, task, native_messages(trace), strict_replay=True
    ).model_dump(mode="json")
    semantic = await model_json(
        key + "/policy-audit",
        ModelInput(
            POLICY_AUDIT_PROMPT,
            object_schema({"policy_compliant": {"type": "boolean"}, "reason": TEXT}),
            {"trace": trace, "policy": backend["policy"]},
        ),
    )
    access_violations = set(issues) - {"no_state_change", "tool_error"}
    result.update(
        native=native,
        semantic=semantic,
        reward=int(
            native["reward"] == 1 and not access_violations and semantic["policy_compliant"]
        ),
    )
    return result
