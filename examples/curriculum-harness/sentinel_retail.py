"""SENTINEL caller's actual Tau2 retail execution and reference checks.

Only caller-supplied training databases are loaded. This module is not imported
by curriculum and does not implement a new runtime or a model training backend.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import subprocess
from pathlib import Path

from gear.canonical import digest

TAU2_COMMIT = "fc0055dc4e0a316c3f83133267fbd6faaa770992"
TAU2_VERSION = "1.0.1"
# No host execution, human handoff, or unbounded arithmetic evaluator is exposed.
EXCLUDED_TOOLS = {"calculate", "transfer_to_human_agents"}


def load_backend(source_root):
    """Bind the installed implementation and policy to an explicit upstream checkout."""
    source_root = Path(source_root).resolve()
    commit = subprocess.check_output(
        ["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != TAU2_COMMIT or importlib.metadata.version("tau2") != TAU2_VERSION:
        raise ValueError("SENTINEL requires the pinned Tau2 source and package version")
    # Tau2 imports LiteLLM transitively; this example never uses its remote models.
    os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    from loguru import logger

    logger.disable("tau2")
    import tau2

    installed = Path(tau2.__file__).resolve().parent
    source = source_root / "src/tau2"
    paths = sorted(path.relative_to(source) for path in source.rglob("*.py"))
    if not paths or set(paths) != {path.relative_to(installed) for path in installed.rglob("*.py")}:
        raise ValueError("installed Tau2 files differ from the pinned source")
    hashes = {}
    for relative in paths:
        raw = (source / relative).read_bytes()
        if raw != (installed / relative).read_bytes():
            raise ValueError("installed Tau2 source differs: " + str(relative))
        hashes[relative.as_posix()] = hashlib.sha256(raw).hexdigest()
    tracked = subprocess.check_output(
        [
            "git",
            "-C",
            str(source_root),
            "diff",
            "HEAD",
            "--name-only",
            "--",
            "src/tau2",
            "data/tau2/domains/retail/policy.md",
            "LICENSE",
        ],
        text=True,
    )
    if tracked.strip():
        raise ValueError("pinned Tau2 implementation or policy has local modifications")
    policy = (source_root / "data/tau2/domains/retail/policy.md").read_text()
    identity = {
        "repository": "https://github.com/sierra-research/tau2-bench",
        "commit": commit,
        "source_digest": digest(hashes),
        "policy_digest": digest(policy),
        "license_sha256": hashlib.sha256((source_root / "LICENSE").read_bytes()).hexdigest(),
        "packages": {
            name: importlib.metadata.version(name)
            for name in ("tau2", "pydantic", "docstring-parser", "deepdiff")
        },
        "excluded_tools": sorted(EXCLUDED_TOOLS),
    }
    return {"identity": identity, "policy": policy}


class RetailSession:
    """One disposable, in-memory database; every replay starts from the same bytes."""

    def __init__(self, backend, database, user_id):
        from tau2.domains.retail.data_model import RetailDB
        from tau2.domains.retail.tools import RetailTools
        from tau2.environment.environment import Environment

        if not isinstance(database, dict) or set(database) != {"users", "orders", "products"}:
            raise ValueError("supply an explicit retail training database")
        db = RetailDB.model_validate(json.loads(json.dumps(database, allow_nan=False)))
        if user_id not in db.users:
            raise ValueError("reference user is absent from the training database")
        for key, user in db.users.items():
            if key != user.user_id or any(
                order not in db.orders or db.orders[order].user_id != key for order in user.orders
            ):
                raise ValueError("inconsistent training user/order identities")
        for key, order in db.orders.items():
            if (
                key != order.order_id
                or order.user_id not in db.users
                or key not in db.users[order.user_id].orders
            ):
                raise ValueError("inconsistent training order ownership")
        self.environment = Environment("retail", backend["policy"], RetailTools(db))
        self.user_id = user_id
        self.tools = {
            tool.name: tool
            for tool in self.environment.get_tools()
            if tool.name not in EXCLUDED_TOOLS
        }
        self.initial = self.snapshot()
        self.identity = digest([backend["identity"], self.initial, user_id])

    def snapshot(self):
        return self.environment.tools.db.model_dump(mode="json")

    def user_material(self):
        return {
            "profile": self.initial["users"][self.user_id],
            "orders": {
                key: value
                for key, value in self.initial["orders"].items()
                if value["user_id"] == self.user_id
            },
        }

    def tool_schemas(self):
        return [tool.openai_schema for _, tool in sorted(self.tools.items())]

    def execute(self, action, index):
        """Execute a schema-checked tool call; preserve native errors and all state changes."""
        from tau2.data_model.message import ToolCall

        if set(action) != {"name", "arguments"} or action["name"] not in self.tools:
            raise ValueError("reference requested an unavailable retail tool")
        arguments = action["arguments"]
        schema = self.tools[action["name"]].params
        if not isinstance(arguments, dict) or set(arguments) - set(schema.model_fields):
            raise ValueError("unknown retail tool arguments")
        schema.model_validate(arguments, strict=True)
        before = digest(self.snapshot())
        call = ToolCall(id=f"tool-{index}", **action)
        result = self.environment.get_response(call)
        return {
            "call": call.model_dump(mode="json"),
            "response": result.model_dump(mode="json", exclude={"timestamp", "turn_idx"}),
            "before": before,
            "after": digest(self.snapshot()),
            "mutating": self.environment.tools.tool_mutates_state(action["name"]),
        }


def replay_trace(backend, database, user_id, trace, *, require_complete=True):
    """Re-execute observed reads/writes, including genuine native tool errors.

    A faithfully recorded failed solver trajectory is valid evidence. It is not
    necessarily a valid reference; ``replay_reference`` enforces that distinction.
    """
    session = RetailSession(backend, database, user_id)
    if (
        trace.get("schema_version") != 1
        or trace.get("environment_id") != session.identity
        or trace.get("initial") != session.initial
        or trace.get("status") not in ("completed", "incomplete")
        or not isinstance(trace.get("steps"), list)
        or (require_complete and trace["status"] != "completed")
        or (
            trace["status"] == "completed"
            and (not trace["steps"] or trace["steps"][-1].get("kind") != "finish")
        )
    ):
        raise ValueError("reference must be complete and bound to this training environment")
    authenticated = False
    writes = []
    errors = []
    for index, step in enumerate(trace["steps"]):
        if step["kind"] == "tool":
            execution = session.execute(step["action"], index)
            if execution != step["execution"]:
                raise ValueError("reference tool observation or intermediate state changed")
            call = execution["call"]
            arguments = call["arguments"]
            if execution["response"]["error"]:
                errors.append("tool_error")
            if call["name"] in ("find_user_id_by_email", "find_user_id_by_name_zip"):
                authenticated = (
                    not execution["response"]["error"]
                    and execution["response"]["content"] == user_id
                )
            if call["name"] not in ("find_user_id_by_email", "find_user_id_by_name_zip"):
                if not authenticated:
                    errors.append("access_before_authentication")
                if "user_id" in arguments and arguments["user_id"] != user_id:
                    errors.append("other_user")
                if "order_id" in arguments:
                    order = session.initial["orders"].get(arguments["order_id"])
                    if order is None or order["user_id"] != user_id:
                        errors.append("other_user_order")
            if execution["mutating"]:
                writes.append(call)
        elif step["kind"] == "message":
            if not step.get("text") or not step.get("reply"):
                raise ValueError("reference conversation is incomplete")
        elif (
            step["kind"] != "finish"
            or index != len(trace["steps"]) - 1
            or trace["status"] != "completed"
            or not step.get("text")
        ):
            raise ValueError("reference has invalid or post-terminal steps")
    if trace.get("final") != session.snapshot():
        raise ValueError("reference terminal database changed")
    if not writes or session.initial == session.snapshot():
        errors.append("no_state_change")
    return session, writes, sorted(set(errors))


def replay_reference(backend, database, user_id, trace):
    """Require a complete, error-free, authenticated state-changing reference."""
    session, writes, errors = replay_trace(backend, database, user_id, trace)
    if errors:
        raise ValueError("invalid retail reference: " + ", ".join(sorted(set(errors))))
    return session, writes


def native_messages(trace, *, reads_only=False):
    """Convert only caller-recorded execution to native messages for Tau2's verifier."""
    from tau2.data_model.message import AssistantMessage, ToolCall, ToolMessage, UserMessage

    messages = [UserMessage(role="user", content=trace["opening"], timestamp=None)]
    for step in trace["steps"]:
        if step["kind"] == "tool":
            if reads_only and step["execution"]["mutating"]:
                continue
            call = ToolCall.model_validate(step["execution"]["call"])
            messages.append(AssistantMessage(role="assistant", tool_calls=[call], timestamp=None))
            messages.append(ToolMessage(**step["execution"]["response"], timestamp=None))
        else:
            messages.append(
                AssistantMessage(role="assistant", content=step["text"], timestamp=None)
            )
            if step["kind"] == "message":
                messages.append(UserMessage(role="user", content=step["reply"], timestamp=None))
    return messages


def build_task(draft, trace):
    """Keep the executable reference caller-owned; the writer supplies only user prose."""
    from tau2.data_model.tasks import Task

    actions = [
        {
            "action_id": step["execution"]["call"]["id"],
            **{k: v for k, v in step["action"].items()},
            "requestor": "assistant",
        }
        for step in trace["steps"]
        if step["kind"] == "tool"
    ]
    return Task.model_validate(
        {
            "id": draft.draft_id,
            "user_scenario": {"instructions": draft.data["user_instructions"]},
            "ticket": draft.instruction,
            # Communication and policy fidelity are separate semantic checks below,
            # not a fake native proof or a default empty COMMUNICATE check.
            "evaluation_criteria": {"actions": actions, "reward_basis": ["DB"]},
        }
    )


def validate_task(task_data, reference):
    """Reject implicit initialization, executable assertions and mismatched gold actions."""
    from tau2.data_model.tasks import Task

    task = Task.model_validate(task_data)
    criteria = task.evaluation_criteria
    if (
        task.initial_state is not None
        or task.required_documents
        or task.user_tools
        or not isinstance(task.ticket, str)
        or not task.ticket.strip()
        or not isinstance(task.user_scenario.instructions, str)
        or not task.user_scenario.instructions.strip()
        or task.user_scenario.persona is not None
        or criteria is None
        or criteria.reward_basis != ["DB"]
        or criteria.env_assertions
        or criteria.communicate_info
        or criteria.nl_assertions
    ):
        raise ValueError("caller supports explicit dialogue tasks with DB-only native reward")
    reference_actions = [
        {"action_id": step["execution"]["call"]["id"], **step["action"], "requestor": "assistant"}
        for step in reference["steps"]
        if step["kind"] == "tool"
    ]
    actual_actions = [
        action.model_dump(mode="json", exclude_none=True) for action in criteria.actions or ()
    ]
    if actual_actions != reference_actions:
        raise ValueError("native task actions must match the independently replayed reference")
    return task


def calibrate(backend, database, user_id, trace, task):
    """Run upstream DB verification on the reference and two actual negative controls."""
    from tau2.evaluator.evaluator_env import EnvironmentEvaluator

    replay_reference(backend, database, user_id, trace)

    def environment_constructor(solo_mode=False):
        if solo_mode:
            raise ValueError("retail reference verification uses dialogue mode")
        return RetailSession(backend, database, user_id).environment

    trajectories = {
        "reference": native_messages(trace),
        "no_actions": [],
        "missing_writes": native_messages(trace, reads_only=True),
    }
    results = {
        key: EnvironmentEvaluator.calculate_reward(
            environment_constructor, task, messages, strict_replay=True
        ).model_dump(mode="json")
        for key, messages in trajectories.items()
    }
    if results["reference"]["reward"] != 1 or any(
        results[key]["reward"] != 0 for key in ("no_actions", "missing_writes")
    ):
        raise ValueError("retail verifier did not distinguish reference and negative controls")
    return results
