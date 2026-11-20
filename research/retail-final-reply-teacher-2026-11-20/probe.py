"""Bounded real-interface checks, separate from any controlled retail study."""

import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
from pathlib import Path


async def run(args):
    sys.path[:0] = [str(args.repository / "python"), str(args.repository / "examples/curriculum-harness")]
    from gear.canonical import digest
    from gear.core.schema import validate_output
    from model_calls import TextCalls
    from sentinel_generate import FINAL_REPLY_PROMPT, FINAL_REPLY_SCHEMA, RetailGenerator, freeze

    def read(path):
        return json.loads(path.read_text())

    study = read(args.source_study / "input.json")["config"]
    sources = [(path.parent, read(path)) for path in args.source_study.glob("observations/*/result.json")]
    incomplete = next((root, value) for root, value in sources if value["status"] == "incomplete")
    failed = next((root, value) for root, value in sources if value["observation"]["record"]["passed"] is False)
    trace = read(incomplete[0] / "trajectory.json")
    conversation = [{"role": "user", "content": trace["opening"]}]
    for step in trace["steps"]:
        if step["kind"] == "tool":
            execution = step["execution"]
            conversation += [
                {"role": "assistant", "tool_call": execution["call"]},
                {"role": "tool", "content": execution["response"]["content"]},
            ]
        else:
            conversation.append({"role": "assistant", "content": step["text"]})
            if step["kind"] == "message":
                conversation.append({"role": "user", "content": step["reply"]})
    previous = read(incomplete[0] / "model/solve/0.json")["input"]
    prepared = {
        "policy": previous["data"]["policy"],
        "tools": [],
        "conversation": conversation,
        "action_budget_exhausted": True,
    }
    generator_config = {
        "schema_version": 1,
        "partition": "train",
        **{key: study["training"][key] for key in ("family", "database", "user_id")},
        "model": "gpt-6-astra",
        "effort": "low",
        "max_steps": 16,
        "max_calls": 56,
        "max_cases": 128,
        "seed": "retail-v6-teacher-probe-1",
        "conditioning": "failure",
        "observations": [failed[1]["observation"]],
        "final_reply_on_limit": True,
    }
    protocol = {
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.repository, text=True).strip(),
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "no_gpu_training": True,
        "scope": "One final-reply API check and exactly one teacher generation attempt; not an efficacy comparison.",
        "maximum_logical_turns": 57,
        "final_reply_model": "gpt-6-luna",
        "generator_model": "gpt-6-astra",
        "source_trace_digest": digest(trace),
        "failure_source_result_digest": digest(failed[1]),
        "failure_source_path": str(failed[0]),
        "final_reply_input": prepared,
        "final_reply_harness": previous["prompt"] + "\n\n" + FINAL_REPLY_PROMPT,
        "final_reply_schema": FINAL_REPLY_SCHEMA,
        "generator_config": generator_config,
        "final_test_opened": False,
        "retries": "Unknown original turns are retained; no additional attempts after failure or rejection.",
    }
    freeze(args.workspace / "protocol.json", protocol)
    if args.preflight:
        print(json.dumps({"status": "prepared", "max_logical_turns": 57, "new_model_submissions": 0}), flush=True)
        return
    async with TextCalls(args.workspace / "finish/calls", max_calls=1, concurrency=1) as calls:
        receipt = await calls.call(
            "finish-interface",
            json.dumps(prepared, ensure_ascii=False, allow_nan=False),
            protocol["final_reply_harness"],
            model=protocol["final_reply_model"],
            effort="low",
            output_schema=FINAL_REPLY_SCHEMA,
        )
    response = json.loads(receipt["response"])
    validate_output(FINAL_REPLY_SCHEMA, response)
    if not response["action"]["text"].strip():
        raise ValueError("empty final reply")
    freeze(args.workspace / "finish/result.json", {
        "status": "completed",
        "source_trace_digest": digest(trace),
        "response": response,
        "receipt_digest": digest(receipt),
        "usage": receipt["usage"],
        "retrospective_task_score": None,
    })
    print(json.dumps({"phase": "final_reply_interface", "status": "completed", "usage": receipt["usage"]}), flush=True)
    async with TextCalls(args.workspace / "generation/calls", max_calls=56, concurrency=1) as calls:
        result = await RetailGenerator(args.workspace / "generation", args.tau2_source, generator_config, calls).generate()
    print(json.dumps({"phase": "one_generation_attempt", "status": result["status"], "model_usage": result["model_usage"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--source-study", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--preflight", action="store_true")
    asyncio.run(run(parser.parse_args()))
