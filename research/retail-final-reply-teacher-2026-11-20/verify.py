"""Replay the stopped teacher prefix and verify the actual final reply without an SDK."""

import argparse
import asyncio
import copy
import hashlib
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ARCHIVE = Path(__file__).resolve().parent
sys.path.insert(0, str(ARCHIVE.parent / "sentinel-retail-2026-11-20-v5"))
from records import files, read, rebase, require  # noqa: E402

SOURCE_COMMIT = "f5947efb596d4ceeac8e1ba887364b0dd2f08bb8"
V5_SHA256 = "73f858c0f3cf9a18dee2b3802e9ca2172412c761bc28fe7c755fde8b51d4b039"
FAILED_KEY = "generation/explore/2"


class OriginalFailure(Exception):
    pass


async def verify(evidence, source):
    from gear.canonical import digest
    from gear.core.schema import validate_output
    from model_calls import BASE_INSTRUCTIONS
    from sentinel_generate import FINAL_REPLY_PROMPT, FINAL_REPLY_SCHEMA, RetailGenerator

    protocol, calls = evidence["protocol"], evidence["calls"]
    require(
        protocol["source_commit"] == SOURCE_COMMIT
        and protocol["script_sha256"]
        == hashlib.sha256((ARCHIVE / "probe.py").read_bytes()).hexdigest()
        and protocol["no_gpu_training"] is True
        and protocol["maximum_logical_turns"] == 57
        and protocol["final_test_opened"] is False
        and evidence["completed_study"] is False
        and evidence["comparative_effect"] is None,
        "frozen source, protocol or incomplete classification changed",
    )
    original_raw = (ARCHIVE.parent / "sentinel-retail-2026-11-20-v5/evidence.json").read_bytes()
    require(hashlib.sha256(original_raw).hexdigest() == V5_SHA256, "source V5 archive changed")
    original = json.loads(original_raw)
    sources = [row for row in original["records"] if "/observations/" in row["workspace"]]
    incomplete = next(
        row for row in sources if row["files"]["result.json"]["status"] == "incomplete"
    )
    failed = next(row for row in sources if row["workspace"] == protocol["failure_source_path"])
    trace = incomplete["files"]["trajectory.json"]
    source_result = failed["files"]["result.json"]
    require(
        digest(trace) == protocol["source_trace_digest"]
        and digest(source_result) == protocol["failure_source_result_digest"]
        and source_result["observation"]["record"]["passed"] is False,
        "original incomplete or failed training source changed",
    )
    conversation = [{"role": "user", "content": trace["opening"]}]
    for step in trace["steps"]:
        if step["kind"] == "tool":
            execution = step["execution"]
            conversation.extend(
                [
                    {"role": "assistant", "tool_call": execution["call"]},
                    {"role": "tool", "content": execution["response"]["content"]},
                ]
            )
        else:
            conversation.append({"role": "assistant", "content": step["text"]})
            if step["kind"] == "message":
                conversation.append({"role": "user", "content": step["reply"]})
    previous = incomplete["files"]["model/solve/0.json"]["input"]
    require(
        protocol["final_reply_input"]
        == {
            "policy": previous["data"]["policy"],
            "tools": [],
            "conversation": conversation,
            "action_budget_exhausted": True,
        }
        and protocol["final_reply_harness"] == previous["prompt"] + "\n\n" + FINAL_REPLY_PROMPT
        and protocol["final_reply_schema"] == FINAL_REPLY_SCHEMA,
        "final reply input is not the original exhausted conversation",
    )
    completed = [row["receipt"] for row in calls.values() if "receipt" in row]
    require(
        set(calls)
        == {
            "finish/finish-interface",
            "generation/diagnose",
            "generation/goal",
            "generation/user/0",
            "generation/explore/0",
            "generation/explore/1",
            FAILED_KEY,
        }
        and [key for key, row in calls.items() if "receipt" not in row] == [FAILED_KEY]
        and all(
            row["status"] == "completed"
            and not row.get("fixture", False)
            and set(row["item_types"]) <= {"userMessage", "agentMessage", "reasoning"}
            and row["usage"] is not None
            and type(row["usage"]["total"]["total_tokens"]) is int
            and row["usage"]["total"]["total_tokens"] >= 0
            for row in completed
        ),
        "native inventory, completed status or usage changed",
    )
    seen = set()

    def bound_call(full_key, prompt, harness, **settings):
        require(full_key in calls and full_key not in seen, "unknown or repeated call")
        row = calls[full_key]
        request = row["pending"]["request"]
        require(
            request
            == {
                "key": full_key.split("/", 1)[1],
                "prompt": prompt,
                "harness": harness,
                "base_instructions": BASE_INSTRUCTIONS,
                "tools": False,
                "sdk": request["sdk"],
                **settings,
            }
            and isinstance(request["sdk"], str)
            and bool(request["sdk"].strip()),
            "native request differs from the reconstructed caller input",
        )
        seen.add(full_key)
        return row.get("receipt")

    receipt = bound_call(
        "finish/finish-interface",
        json.dumps(protocol["final_reply_input"], ensure_ascii=False, allow_nan=False),
        protocol["final_reply_harness"],
        model=protocol["final_reply_model"],
        effort="low",
        output_schema=FINAL_REPLY_SCHEMA,
    )
    response = json.loads(receipt["response"])
    validate_output(FINAL_REPLY_SCHEMA, response)
    require(
        response["action"]["text"].strip()
        and evidence["finish_result"]
        == {
            "status": "completed",
            "source_trace_digest": digest(trace),
            "response": response,
            "usage": receipt["usage"],
            "retrospective_task_score": None,
        },
        "actual final reply or its unscored classification changed",
    )
    expected = evidence["generation_files"]
    identity = expected["input.json"]
    config = protocol["generator_config"]
    training = original["study_identity"]["config"]["training"]
    require(
        config
        == identity["config"]
        == {
            "schema_version": 1,
            "partition": "train",
            **{k: training[k] for k in ("family", "database", "user_id")},
            "model": protocol["generator_model"],
            "effort": "low",
            "max_steps": 16,
            "max_calls": 56,
            "max_cases": 128,
            "seed": "retail-v6-teacher-probe-1",
            "conditioning": "failure",
            "observations": [source_result["observation"]],
            "final_reply_on_limit": True,
        }
        and protocol["final_reply_model"] == "gpt-6-luna"
        and protocol["generator_model"] == "gpt-6-astra"
        and "result.json" not in expected
        and "reference.json" not in expected,
        "generator config, source scope or stopped state differs",
    )
    inspection = evidence["inspection"]
    require(
        inspection
        == {
            "request_key": "explore/2",
            "native_turn_status": "failed",
            "error": "exceeded retry limit, last status: 429 Too Many Requests",
            "usage": None,
            "new_model_submissions": 0,
        },
        "original infrastructure failure was reclassified",
    )

    async def call(key, prompt, harness, **settings):
        receipt = bound_call("generation/" + key, prompt, harness, **settings)
        if receipt is None:
            require(key == inspection["request_key"], "unexpected missing response")
            raise OriginalFailure(inspection["error"])
        saved = expected["model/" + key + ".json"]
        require(receipt == saved["receipt"], "native and caller responses differ")
        return receipt

    transport = SimpleNamespace(
        call=call,
        max_calls=config["max_calls"],
        identity=identity["model_calls_identity"],
        timeout_seconds=identity["call_timeout_seconds"],
        root=Path(identity["call_store"]),
    )
    with tempfile.TemporaryDirectory(prefix="gear-retail-teacher-replay-") as directory:
        caller = RetailGenerator(directory, source, config, transport)
        require(caller.identity == identity, "frozen generator or native runtime changed")
        try:
            await caller.generate()
        except OriginalFailure as error:
            require(str(error) == inspection["error"], "original failure changed")
        else:
            raise ValueError("unfinished generator acquired a result")
        actual = rebase(
            files(Path(directory)),
            str(Path(directory).resolve()),
            evidence["workspace"] + "/generation",
        )
        require(actual == expected and seen == set(calls), "CPU prefix, files or calls differ")
    steps = [value for key, value in expected.items() if key.startswith("steps/")]
    require(
        len(steps) == 2
        and all(
            row["kind"] == "tool"
            and row["execution"]["before"] == row["execution"]["after"]
            and not row["execution"]["response"]["error"]
            for row in steps
        ),
        "actual read-only tools changed",
    )
    known = sum(row["usage"]["total"]["total_tokens"] for row in completed)
    require(
        known == 82432
        and evidence["accounting"]
        == {
            "submitted_logical_turns": 7,
            "completed_turns": 6,
            "failed_turns": 1,
            "known_completed_native_tokens": known,
            "all_attempt_tokens": None,
            "cpu_read_only_tool_executions": 2,
            "weight_training_steps": 0,
        }
        and "openai_codex" not in sys.modules,
        "cost or offline-only contract differs",
    )
    return {
        "status": "passed",
        "submitted_turns_verified": len(seen),
        "completed_native_tokens": known,
        "all_attempt_tokens": None,
        "cpu_reads_replayed": 2,
        "generator_result": None,
        "retrospective_task_score": None,
        "comparative_effect": None,
        "new_model_submissions": 0,
        "sdk_imported": False,
    }


async def main(args):
    sys.path[:0] = [
        str(args.repository / "python"),
        str(args.repository / "examples/curriculum-harness"),
    ]
    raw = (ARCHIVE / "evidence.json").read_bytes()
    manifest = read(ARCHIVE / "manifest.json")
    require(hashlib.sha256(raw).hexdigest() == manifest["evidence_sha256"], "export changed")
    evidence = json.loads(raw)
    require(
        manifest["source_commit"] == SOURCE_COMMIT
        and manifest["accounting"] == evidence["accounting"],
        "manifest differs",
    )
    result = await verify(evidence, args.tau2_source)
    if args.negative_checks:
        rejected = []
        for name in ("failed_request", "tool_result", "invented_score"):
            changed = copy.deepcopy(evidence)
            if name == "failed_request":
                changed["calls"][FAILED_KEY]["pending"]["request"]["harness"] += " Altered."
            elif name == "tool_result":
                changed["generation_files"]["steps/0.json"]["execution"]["response"]["content"] = (
                    "Invented."
                )
            else:
                changed["finish_result"]["retrospective_task_score"] = 0
            try:
                await verify(changed, args.tau2_source)
            except ValueError as error:
                rejected.append({"mutation": name, "rejected": True, "reason": str(error)})
            else:
                raise AssertionError("altered evidence accepted: " + name)
        result["negative_checks"] = rejected
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--negative-checks", action="store_true")
    asyncio.run(main(parser.parse_args()))
