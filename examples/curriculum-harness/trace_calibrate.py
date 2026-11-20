"""Concrete TRACE environment checks, fixed-weight rollouts, and difficulty calibration."""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import math
import statistics
from dataclasses import asdict
from pathlib import Path

import gear.curriculum
from gear.canonical import digest
from gear.core.schema import validate_output
from gear.curriculum import ModelInput
from ifeval_experiment import read_json
from model_calls import token_usage
from trace_environment import freeze

ACTION_PROMPT = (
    "Act on the supplied environment conversation and policy. Select exactly one available "
    "tool or respond_to_user with a message to the customer. Return the action name and "
    "a JSON object encoded in arguments_json. Never invent a tool result."
)


def implementation_identity():
    gear_root = Path(gear.curriculum.__file__).parent.parent
    root = Path(__file__).resolve().parents[2]
    paths = (
        list((gear_root / "curriculum").glob("*.py"))
        + list((gear_root / "core").glob("*.py"))
        + list(Path(__file__).parent.glob("trace_*.py"))
        + [
            gear_root / "canonical.py",
            Path(__file__).with_name("model_calls.py"),
            Path(__file__).with_name("ifeval_experiment.py"),
        ]
    )
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths
    }


def verify_environment(environment, seeds):
    """Actual reference, shortcut, and incorrect-answer executions on sealed code."""
    records = []
    for seed in seeds:
        reference = environment.reference(seed)
        if reference != environment.reference(seed):
            raise ValueError("reference construction is not deterministic under its seed")
        if (
            not 2 <= len(reference) <= 64
            or reference[-1]["name"] != "respond_to_user"
            or not any(row["name"] != "respond_to_user" for row in reference)
        ):
            raise ValueError("reference must exercise tools and finish with a customer response")
        traces = {
            "reference": environment.replay(seed, reference),
            "no_actions": environment.replay(seed, []),
            "skip_tools": environment.replay(seed, [reference[-1]]),
            "wrong_result": environment.replay(
                seed,
                reference[:-1]
                + [
                    {
                        "name": "respond_to_user",
                        "arguments": {"message": "UNVERIFIED_RESULT_" + str(seed)},
                    }
                ],
            ),
        }
        terminal = traces["reference"]["snapshots"][-1]
        if not terminal["done"] or terminal["summary"]["reward"] != 1:
            raise ValueError("generated reference did not reach verified full reward")
        if any(
            traces[key]["snapshots"][-1]["summary"]["reward"] >= 1
            for key in ("no_actions", "skip_tools", "wrong_result")
        ):
            raise ValueError("generated verifier accepted an empty, shortcut or incorrect solution")
        if any(
            row["snapshots"][0] != traces["reference"]["snapshots"][0] for row in traces.values()
        ):
            raise ValueError("environment reset is not reproducible")
        records.append({"seed": seed, "reference_actions": reference, "traces": traces})
    diversity = {digest(row["traces"]["reference"]["snapshots"][0]["messages"]) for row in records}
    if len(diversity) != len(seeds):
        raise ValueError("different calibration seeds did not produce distinct initial requests")
    return {
        "environment_id": environment.environment_id,
        "records": records,
        "distinct_initial_contexts": len(diversity),
    }


class TraceCollector:
    """One solver sample. Unknown API results and incomplete episodes stay unscored."""

    def __init__(self, root, environment, config, calls):
        expected = {
            "schema_version",
            "model",
            "effort",
            "harness",
            "seed",
            "sample_idx",
            "sample_id",
            "max_steps",
            "max_calls",
        }
        if (
            set(config) != expected
            or type(config["schema_version"]) is not int
            or config["schema_version"] != 1
        ):
            raise ValueError("TRACE collection requires the explicit solver sample schema")
        for name in ("model", "effort", "harness", "sample_id"):
            if not isinstance(config[name], str) or not config[name].strip():
                raise ValueError("nonempty solver setting required: " + name)
        for name, bound, lower in (
            ("seed", 2**31 - 1, 0),
            ("sample_idx", 63, 0),
            ("max_steps", 64, 1),
            ("max_calls", 65536, 1),
        ):
            if type(config[name]) is not int or not lower <= config[name] <= bound:
                raise ValueError("bounded solver setting required: " + name)
        if calls.max_calls != config["max_calls"]:
            raise ValueError("solver model quota differs from frozen configuration")
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.config = json.loads(json.dumps(config, allow_nan=False))
        self.environment, self.calls = environment, calls
        self.policy_id = digest(
            {
                **{key: config[key] for key in ("model", "effort", "harness", "max_steps")},
                "protocol": ACTION_PROMPT,
                "implementation": implementation_identity(),
                "model_calls_identity": getattr(calls, "identity", "TextCalls"),
                "call_timeout_seconds": getattr(calls, "timeout_seconds", None),
            }
        )
        self.identity = {
            "config": self.config,
            "environment_id": environment.environment_id,
            "policy_id": self.policy_id,
            "implementation": implementation_identity(),
            "model_calls_identity": getattr(calls, "identity", "TextCalls"),
            "call_store": str(Path(calls.root).resolve()) if hasattr(calls, "root") else None,
            "call_timeout_seconds": getattr(calls, "timeout_seconds", None),
        }
        freeze(self.root / "input.json", self.identity)

    async def collect(self):
        with (self.root / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            actions = []
            trace = await asyncio.to_thread(self.environment.replay, self.config["seed"], actions)
            freeze(self.root / "steps/0.json", trace["snapshots"][0])
            for index in range(min(self.config["max_steps"], trace["snapshots"][0]["max_steps"])):
                state = trace["snapshots"][-1]
                if state["done"]:
                    break
                available = [tool["function"]["name"] for tool in state["tools"]]
                prepared = ModelInput(
                    self.config["harness"] + "\n\n" + ACTION_PROMPT,
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["name", "arguments_json"],
                        "properties": {
                            "name": {"type": "string", "enum": available + ["respond_to_user"]},
                            "arguments_json": {"type": "string", "maxLength": 16384},
                        },
                    },
                    {key: state[key] for key in ("system_prompt", "tools", "messages")},
                )
                receipt = await self.calls.call(
                    f"solve/{index}",
                    json.dumps(prepared.data, ensure_ascii=False, allow_nan=False),
                    prepared.prompt,
                    model=self.config["model"],
                    effort=self.config["effort"],
                    output_schema=prepared.schema,
                )
                if receipt.get("status") != "completed":
                    raise RuntimeError("TRACE solver model result is incomplete or unknown")
                freeze(
                    self.root / f"model/solve/{index}.json",
                    {"input": asdict(prepared), "receipt": receipt},
                )
                response = json.loads(receipt["response"])
                validate_output(prepared.schema, response)
                action = {
                    "name": response["name"],
                    "arguments": json.loads(response["arguments_json"]),
                }
                self.environment.action(action, available)
                following = await asyncio.to_thread(
                    self.environment.replay, self.config["seed"], actions + [action]
                )
                if following["snapshots"][:-1] != trace["snapshots"]:
                    raise ValueError("TRACE execution prefix changed during deterministic replay")
                actions.append(action)
                trace = following
                freeze(self.root / f"steps/{index + 1}.json", trace["snapshots"][-1])
            trace = freeze(self.root / "trajectory.json", {"actions": actions, **trace})
            complete = trace["snapshots"][-1]["done"]
            receipts = [
                read_json(path)["receipt"] for path in sorted((self.root / "model").rglob("*.json"))
            ]
            return freeze(
                self.root / "result.json",
                {
                    "schema_version": 1,
                    "environment_id": self.environment.environment_id,
                    "policy_id": self.policy_id,
                    **{key: self.config[key] for key in ("seed", "sample_idx", "sample_id")},
                    "complete": complete,
                    "reward": trace["snapshots"][-1]["summary"]["reward"] if complete else None,
                    "evidence_refs": [
                        {"path": str(self.root / "trajectory.json"), "digest": digest(trace)},
                        {"path": str(self.root / "input.json"), "digest": digest(self.identity)},
                    ],
                    "model_usage": {
                        "completed_calls": len(receipts),
                        "tokens": token_usage(receipts).get("tokens"),
                        "call_limit": self.config["max_calls"],
                    },
                },
            )


def calibration_parameters(seeds, group_size, thresholds):
    """Validate the declared measurement plan before any model submission."""
    expected = {
        "mean_min",
        "mean_max",
        "success_min",
        "success_max",
        "std_min",
        "max_all_success_groups",
        "max_all_zero_groups",
        "max_constant_groups",
        "min_informative_groups",
        "success_threshold",
        "zero_threshold",
        "pass_at_k",
    }
    if set(thresholds) != expected:
        raise ValueError("declare all TRACE reward calibration thresholds")
    for name, value in thresholds.items():
        if name != "pass_at_k" and (
            type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1
        ):
            raise ValueError("calibration thresholds must be normalized finite numbers")
    if (
        not thresholds["zero_threshold"] < thresholds["success_threshold"]
        or thresholds["mean_min"] > thresholds["mean_max"]
        or thresholds["success_min"] > thresholds["success_max"]
    ):
        raise ValueError("inconsistent calibration threshold intervals")
    if (
        not isinstance(seeds, list)
        or not 2 <= len(seeds) <= 64
        or any(type(seed) is not int or not 0 <= seed < 2**31 for seed in seeds)
        or len(set(seeds)) != len(seeds)
    ):
        raise ValueError("calibration requires distinct explicit seeds")
    if type(group_size) is not int or not 2 <= group_size <= 64:
        raise ValueError("calibration requires a bounded repeated rollout group")
    ks = thresholds["pass_at_k"]
    if (
        not isinstance(ks, list)
        or not ks
        or any(type(k) is not int or not 1 <= k <= group_size for k in ks)
        or len(set(ks)) != len(ks)
    ):
        raise ValueError("pass@k requires distinct supported sample counts")
    return ks


def calibrate(rows, *, seeds, group_size, environment_id, policy_id, thresholds):
    """Empirical first-k pass rates and complete rollout-group variance diagnostics."""
    ks = calibration_parameters(seeds, group_size, thresholds)
    observed, samples = {}, set()
    for row in rows:
        key = row["seed"], row["sample_idx"]
        if (
            row["environment_id"] != environment_id
            or row["policy_id"] != policy_id
            or not row["evidence_refs"]
        ):
            raise ValueError(
                "calibration requires referenced rollouts under the declared environment and policy"
            )
        if (
            not isinstance(row["sample_id"], str)
            or not row["sample_id"]
            or row["sample_id"] in samples
            or key in observed
        ):
            raise ValueError("duplicate or invalid calibration sample")
        if (
            type(row["seed"]) is not int
            or type(row["sample_idx"]) is not int
            or type(row["complete"]) is not bool
        ):
            raise ValueError("calibration requires explicit sample indices and completeness")
        reward = row["reward"]
        if (not row["complete"] and reward is not None) or (
            row["complete"]
            and (
                type(reward) not in (int, float)
                or not math.isfinite(reward)
                or not 0 <= reward <= 1
            )
        ):
            raise ValueError("unknown episodes remain unscored; complete rewards must be finite")
        observed[key] = row
        samples.add(row["sample_id"])
    inventory = {(seed, index) for seed in seeds for index in range(group_size)}
    if set(observed) != inventory:
        raise ValueError("every declared seed requires its complete, unique rollout group")
    unknown = sum(not row["complete"] for row in observed.values())
    if unknown:
        return {
            "status": "incomplete",
            "metrics": None,
            "unknown_samples": unknown,
            "errors": ["incomplete episodes cannot establish the reward distribution"],
        }
    groups = [[observed[seed, index]["reward"] for index in range(group_size)] for seed in seeds]
    rewards = [value for group in groups for value in group]
    success, zero = thresholds["success_threshold"], thresholds["zero_threshold"]
    constant = sum(len({round(value, 8) for value in group}) == 1 for group in groups) / len(groups)
    metrics = {
        "num_rollouts": len(rows),
        "num_tasks": len(seeds),
        "group_size": group_size,
        "mean_reward": statistics.mean(rewards),
        "std_reward": statistics.pstdev(rewards),
        "success_rate": sum(value >= success for value in rewards) / len(rewards),
        "zero_rate": sum(value <= zero for value in rewards) / len(rewards),
        "all_success_group_rate": sum(all(value >= success for value in group) for group in groups)
        / len(groups),
        "all_zero_group_rate": sum(all(value <= zero for value in group) for group in groups)
        / len(groups),
        "constant_group_rate": constant,
        "informative_group_rate": 1 - constant,
        "pass_at_k": {
            str(k): sum(any(value >= success for value in group[:k]) for group in groups)
            / len(groups)
            for k in sorted(ks)
        },
    }
    errors = []
    for key, lower, upper in (
        ("mean_reward", "mean_min", "mean_max"),
        ("success_rate", "success_min", "success_max"),
        ("std_reward", "std_min", None),
        ("all_success_group_rate", None, "max_all_success_groups"),
        ("all_zero_group_rate", None, "max_all_zero_groups"),
        ("constant_group_rate", None, "max_constant_groups"),
        ("informative_group_rate", "min_informative_groups", None),
    ):
        if lower and metrics[key] < thresholds[lower]:
            errors.append(key + " below " + lower)
        if upper and metrics[key] > thresholds[upper]:
            errors.append(key + " above " + upper)
    return {
        "status": "ready" if not errors else "rejected",
        "metrics": metrics,
        "unknown_samples": 0,
        "errors": errors,
    }
