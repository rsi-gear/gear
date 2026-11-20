"""One explicitly instructed action checks transport/schema compatibility only."""

import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
from pathlib import Path


async def main(args):
    sys.path[:0] = [str(args.repository / "python"), str(args.repository / "examples/curriculum-harness")]
    from gear.canonical import digest
    from gear.core.schema import validate_output
    from model_calls import BASE_INSTRUCTIONS, TextCalls
    from sentinel_generate import ACTION_SCHEMA, freeze, implementation_identity
    from sentinel_retail import RetailSession, load_backend

    evidence = json.loads((args.repository / "research/sentinel-retail-2026-11-20-v4/evidence.json").read_text())
    training = evidence["study_identity"]["config"]["training"]
    backend = load_backend(args.tau2_source)
    session = RetailSession(backend, training["database"], training["user_id"])
    harness = (
        "You emit structured actions for a caller-managed retail simulator. "
        "For this interface check, return one get_user_details tool action for the "
        "customer specified in the request. The caller will execute the tool. "
        "Keep text empty and do not claim a result or task completion."
    )
    prompt = json.dumps({"customer_id": training["user_id"], "tools": session.tool_schemas()})
    root = args.workspace.resolve()
    identity = freeze(root / "input.json", {
        "scope": "Transport, structured action schema and one actual CPU tool execution; not task success or data-strategy efficacy.",
        "model": "gpt-6-luna", "effort": "low", "max_calls": 1,
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.repository, text=True).strip(),
        "implementation": implementation_identity(), "backend": backend["identity"],
        "base_instructions": BASE_INSTRUCTIONS, "schema": ACTION_SCHEMA,
        "harness": harness, "prompt": prompt, "weight_training_steps": 0,
    })
    async with TextCalls(root / "calls", max_calls=1, concurrency=1) as calls:
        receipt = await calls.call("action-interface", prompt, harness, model="gpt-6-luna", effort="low", output_schema=ACTION_SCHEMA)
    response = json.loads(receipt["response"])
    validate_output(ACTION_SCHEMA, response)
    action = response["action"]
    arguments = json.loads(action["arguments_json"])
    if (action["kind"], action["name"], arguments, action["text"]) != (
        "tool", "get_user_details", {"user_id": training["user_id"]}, ""
    ):
        raise ValueError("interface response differs from the explicitly instructed read")
    execution = session.execute({"name": action["name"], "arguments": arguments}, 0)
    if execution["before"] != execution["after"] or execution["response"]["error"]:
        raise ValueError("interface read changed the database or returned a tool error")
    result = freeze(root / "result.json", {
        "status": "passed", "input_digest": digest(identity), "receipt_digest": digest(receipt),
        "response": action, "execution": execution, "native_usage": receipt["usage"],
        "new_model_submissions": 1, "weight_training_steps": 0,
        "effect_claim": False,
    })
    print(json.dumps({key: result[key] for key in ("status", "native_usage", "effect_claim")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
