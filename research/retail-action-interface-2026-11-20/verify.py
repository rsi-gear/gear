"""Verify both interface attempts and replay the successful CPU read without an SDK."""

import argparse
import hashlib
import json
import sys
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(archive, repository, source):
    sys.path[:0] = [str(repository / "python"), str(repository / "examples/curriculum-harness")]
    from gear.canonical import digest
    from gear.core.schema import validate_output
    from model_calls import BASE_INSTRUCTIONS
    from sentinel_generate import ACTION_SCHEMA, implementation_identity
    from sentinel_retail import RetailSession, load_backend

    raw = (archive / "evidence.json").read_bytes()
    manifest = json.loads((archive / "manifest.json").read_text())
    require(hashlib.sha256(raw).hexdigest() == manifest["evidence_sha256"], "export changed")
    evidence = json.loads(raw)
    rejected, completed = evidence["attempts"]
    require([rejected["name"], completed["name"]] == ["v1", "v2"], "attempt inventory changed")
    for row in (rejected, completed):
        protocol, request = row["protocol"], row["pending"]["request"]
        require(
            all(
                request[k] == protocol[k]
                for k in ("model", "effort", "harness", "prompt", "base_instructions")
            )
            and request["output_schema"] == protocol["schema"]
            and protocol["max_calls"] == 1
            and protocol["weight_training_steps"] == 0
            and request["tools"] is False
            and request["key"] == "action-interface",
            "submitted request differs from the predeclared interface check",
        )
    failed = rejected["inspection"]
    error = json.loads(failed["error"])
    require(
        failed["status"] == "failed"
        and failed["usage"] is None
        and failed["new_model_submissions"] == 0
        and error["status"] == 400
        and error["error"]["code"] == "invalid_json_schema"
        and "anyOf" in rejected["protocol"]["schema"]
        and "native" not in rejected
        and "result" not in rejected,
        "invalid-schema rejection was reclassified or assigned invented usage",
    )
    protocol, native, result = completed["protocol"], completed["native"], completed["result"]
    receipt = native["receipt"]
    require(
        protocol["source_commit"]
        == manifest["successful_source_commit"]
        == "c032ab44a2325462b38ecae5460bbca908de49d8"
        and protocol["implementation"] == implementation_identity()
        and protocol["schema"] == ACTION_SCHEMA
        and protocol["base_instructions"] == BASE_INSTRUCTIONS
        and protocol["script_sha256"]
        == hashlib.sha256((archive / "probe.py").read_bytes()).hexdigest()
        and native["request"] == completed["pending"]["request"]
        and result["input_digest"] == digest(protocol),
        "successful request, source or frozen protocol changed",
    )
    require(
        receipt["status"] == "completed"
        and result["status"] == "passed"
        and result["effect_claim"] is False
        and result["weight_training_steps"] == 0
        and result["new_model_submissions"] == 1
        and set(receipt["item_types"]) <= {"userMessage", "agentMessage", "reasoning"}
        and receipt["usage"] == result["native_usage"],
        "completion or native usage differs",
    )
    response = json.loads(receipt["response"])
    validate_output(ACTION_SCHEMA, response)
    action = response["action"]
    require(action == result["response"], "recorded action differs from native output")
    data_raw = (repository / "research/sentinel-retail-2026-11-20-v4/evidence.json").read_bytes()
    require(
        hashlib.sha256(data_raw).hexdigest()
        == "b7c39ad9b9cf232551ccc124b40983b84bcc26caa4fb36a1e5dc72e41e5aaf0e",
        "original synthetic database archive changed",
    )
    training = json.loads(data_raw)["study_identity"]["config"]["training"]
    backend = load_backend(source)
    require(backend["identity"] == protocol["backend"], "native runtime changed")
    session = RetailSession(backend, training["database"], training["user_id"])
    require(
        json.loads(protocol["prompt"])
        == {"customer_id": training["user_id"], "tools": session.tool_schemas()}
        and action["kind"] == "tool"
        and action["name"] == "get_user_details"
        and json.loads(action["arguments_json"]) == {"user_id": training["user_id"]}
        and action["text"] == "",
        "interface read differs from the explicitly instructed action",
    )
    execution = session.execute(
        {"name": action["name"], "arguments": json.loads(action["arguments_json"])}, 0
    )
    require(
        execution == result["execution"]
        and execution["before"] == execution["after"]
        and not execution["response"]["error"],
        "actual CPU read or database state differs",
    )
    tokens = receipt["usage"]["total"]["total_tokens"]
    require(
        evidence["accounting"]
        == manifest["accounting"]
        == {
            "submitted_logical_turns": 2,
            "completed_turns": 1,
            "failed_turns": 1,
            "known_completed_native_tokens": 27587,
            "all_attempt_tokens": None,
            "cpu_read_only_tool_executions": 1,
            "weight_training_steps": 0,
        }
        and tokens == 27587,
        "cost accounting changed",
    )
    return {
        "status": "passed",
        "original_submitted_turns": 2,
        "known_completed_tokens": tokens,
        "all_attempt_tokens": None,
        "cpu_reads_replayed": 1,
        "new_model_submissions": 0,
        "sdk_imported": "openai_codex" in sys.modules,
        "effect_claim": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(Path(__file__).parent, args.repository, args.tau2_source), indent=2))
