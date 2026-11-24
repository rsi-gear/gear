"""Capture and replay completed retail caller records, including unscored step limits.

This study-local evidence helper has no SDK client or model-submission path.
It does not evaluate a study or turn a partial caller run into a result.
"""

import argparse
import asyncio
import copy
import hashlib
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    return json.loads(path.read_text())


def files(root):
    return {
        path.relative_to(root).as_posix(): read(path)
        for path in sorted(root.rglob("*.json"))
        if "calls" not in path.relative_to(root).parts
    }


def redact(value):
    if isinstance(value, dict):
        return {
            key: "<redacted>" if key in ("thread_id", "turn_id") else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def rebase(value, original, destination):
    if isinstance(value, dict):
        return {key: rebase(item, original, destination) for key, item in value.items()}
    if isinstance(value, list):
        return [rebase(item, original, destination) for item in value]
    if isinstance(value, str) and value.startswith(original + "/"):
        return destination + value[len(original) :]
    return value


def capture(root):
    from gear.canonical import digest
    from sentinel_generate import implementation_identity

    root = root.resolve()
    expected = files(root)
    require(
        "result.json" in expected, "caller has not sealed a result; do not capture a live prefix"
    )
    identity = expected["input.json"]
    require(
        identity["implementation"] == implementation_identity(), "use the caller's frozen source"
    )
    config = identity["config"]
    kind = "collect" if "sample_id" in config else "generate"
    store = Path(identity["call_store"])
    # Formal provider samples share a call store and add the actual slot key.
    prefix = ""
    if store.parent != root:
        require(kind == "collect" and "operations" in root.parts, "unsupported shared call store")
        prefix = config["sample_id"] + "/"
    models = {name[6:-5]: value for name, value in expected.items() if name.startswith("model/")}
    native = {}
    for path in sorted(store.glob("*/pending.json")):
        pending = read(path)
        full_key = pending["request"]["key"]
        if not full_key.startswith(prefix):
            continue
        key = full_key[len(prefix) :]
        require(key in models and key not in native, "unmatched or duplicate native turn in caller")
        saved = read(path.with_name("result.json"))
        require(
            path.parent.name == digest(full_key).removeprefix("sha256:")
            and saved["request"] == pending["request"]
            and saved["digest"] == digest(saved["receipt"])
            and saved["receipt"] == models[key]["receipt"]
            and saved["receipt"]["status"] == "completed"
            and not saved["receipt"].get("fixture", False)
            and all(saved["receipt"][k] == pending[k] for k in ("thread_id", "turn_id")),
            "native request, receipt or stored caller transcript differs",
        )
        native[key] = {"request": saved["request"], "receipt": saved["receipt"]}
    require(set(native) == set(models), "caller responses lack original native receipts")
    require(
        files(root) == expected, "caller changed during capture; wait for the original execution"
    )
    return redact(
        {
            "workspace": str(root),
            "kind": kind,
            "key_prefix": prefix,
            "files": expected,
            "native_calls": native,
        }
    )


async def verify_record(record, source):
    from gear.canonical import digest
    from model_calls import BASE_INSTRUCTIONS
    from sentinel_collect import RetailCollector
    from sentinel_generate import RetailGenerator

    expected = record["files"]
    require("result.json" in expected, "this verifier requires a sealed caller result")
    identity = expected["input.json"]
    config = identity["config"]
    require(record["kind"] in ("collect", "generate"), "unsupported caller record")
    prefix = record["key_prefix"]
    require(
        not prefix or record["kind"] == "collect" and prefix == config["sample_id"] + "/",
        "provider slot prefix differs from its caller sample",
    )
    models = {name[6:-5]: value for name, value in expected.items() if name.startswith("model/")}
    require(set(models) == set(record["native_calls"]), "model/native inventory differs")
    seen = set()

    async def call(key, prompt, harness, **settings):
        require(key in models and key not in seen, "missing or repeated original response")
        saved = models[key]
        prepared = saved["input"]
        native = record["native_calls"][key]
        receipt, request = native["receipt"], native["request"]
        require(
            request
            == {
                "key": prefix + key,
                "prompt": prompt,
                "harness": harness,
                "base_instructions": BASE_INSTRUCTIONS,
                "tools": False,
                "sdk": request["sdk"],
                **settings,
            }
            and isinstance(request["sdk"], str)
            and bool(request["sdk"].strip())
            and receipt == saved["receipt"]
            and receipt["status"] == "completed"
            and not receipt.get("fixture", False)
            and all(
                kind in ("userMessage", "agentMessage", "reasoning")
                for kind in receipt["item_types"]
            )
            and json.loads(prompt) == prepared["data"]
            and harness == prepared["prompt"]
            and settings
            == {
                "model": config["model"],
                "effort": config["effort"],
                "output_schema": prepared["schema"],
            },
            "native response is not bound to the replayed input",
        )
        seen.add(key)
        return receipt

    calls = SimpleNamespace(
        call=call,
        max_calls=config["max_calls"],
        identity=identity["model_calls_identity"],
        timeout_seconds=identity["call_timeout_seconds"],
        delay_seconds=identity["call_delay_seconds"],
        root=Path(identity["call_store"]),
    )
    with tempfile.TemporaryDirectory(prefix="gear-retail-record-replay-") as directory:
        cls = RetailCollector if record["kind"] == "collect" else RetailGenerator
        caller = cls(directory, source, config, calls)
        require(caller.identity == identity, "frozen caller configuration or runtime changed")
        await (caller.collect() if record["kind"] == "collect" else caller.generate())
        actual = rebase(files(Path(directory)), str(Path(directory).resolve()), record["workspace"])
        require(
            actual == expected and seen == set(models),
            "tool execution, grading or checkpoints differ",
        )
    receipts = [row["receipt"] for row in record["native_calls"].values()]
    unknown_usage = sum(row["usage"] is None for row in receipts)
    require(
        all(
            type(row["usage"]["total"]["total_tokens"]) is int
            and row["usage"]["total"]["total_tokens"] >= 0
            for row in receipts
            if row["usage"] is not None
        ),
        "native token totals must be nonnegative integers or explicitly unknown",
    )
    known_tokens = sum(
        row["usage"]["total"]["total_tokens"] for row in receipts if row["usage"] is not None
    )
    require("openai_codex" not in sys.modules, "offline replay imported the model SDK")
    result = expected["result.json"]
    return {
        "kind": record["kind"],
        "workspace": record["workspace"],
        "status": result["status"],
        "result_digest": digest(result),
        "completed_native_calls": len(receipts),
        "known_tokens": known_tokens,
        "calls_without_usage": unknown_usage,
        "total_tokens": None if unknown_usage else known_tokens,
        "record": result.get("observation", {}).get("record"),
        "new_model_submissions": 0,
        "sdk_imported": "openai_codex" in sys.modules,
    }


async def negative_checks(record, source):
    """Exercise semantic evidence checks after bypassing the outer file hash."""
    require(record["kind"] == "collect", "negative checks require an original solver record")
    require(
        any(row["kind"] == "tool" for row in record["files"]["trajectory.json"]["steps"]),
        "negative checks need an executed tool result",
    )
    metered = [key for key, row in record["native_calls"].items() if row["receipt"]["usage"]]
    require(bool(metered), "usage mutation needs at least one recorded native token total")
    checks = []
    for name in ("response", "request", "tool_result", "score", "usage"):
        changed = copy.deepcopy(record)
        key = metered[0] if name == "usage" else next(iter(changed["native_calls"]))
        native = changed["native_calls"][key]
        if name == "response":
            native["receipt"]["response"] = "{}"
        elif name == "request":
            native["request"]["base_instructions"] += " Altered transport instruction."
        elif name == "tool_result":
            steps = changed["files"]["trajectory.json"]["steps"]
            step = next(row for row in steps if row["kind"] == "tool")
            step["execution"]["response"]["content"] = "invented tool result"
        elif name == "score":
            outcome = changed["files"]["result.json"]["observation"]["record"]
            outcome.update(status="completed", complete=True, passed=True)
        else:
            native["receipt"]["usage"] = None
            changed["files"]["model/" + key + ".json"]["receipt"]["usage"] = None
        try:
            await verify_record(changed, source)
        except ValueError as error:
            checks.append({"mutation": name, "rejected": True, "reason": str(error)})
        else:
            raise AssertionError("tampered evidence accepted: " + name)
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    exporter = sub.add_parser("capture")
    exporter.add_argument("--workspace", type=Path, required=True)
    exporter.add_argument("--output", type=Path, required=True)
    verifier = sub.add_parser("verify")
    verifier.add_argument("--archive", type=Path, required=True)
    verifier.add_argument("--tau2-source", type=Path, required=True)
    verifier.add_argument("--negative-checks", action="store_true")
    args = parser.parse_args()
    sys.path[:0] = [
        str(args.repository / "python"),
        str(args.repository / "examples/curriculum-harness"),
    ]
    if args.command == "capture":
        require(
            not args.output.resolve().is_relative_to(args.workspace.resolve()),
            "export outside the immutable caller workspace",
        )
        record = capture(args.workspace)
        raw = (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode()
        args.output.mkdir(parents=True, exist_ok=True)
        path = args.output / "record.json"
        require(not path.exists() or path.read_bytes() == raw, "capture output already differs")
        manifest = {
            "record_sha256": hashlib.sha256(raw).hexdigest(),
            "redactions": ["SDK thread_id and turn_id; original native receipt digests omitted"],
        }
        manifest_path = args.output / "manifest.json"
        manifest_text = json.dumps(manifest, indent=2) + "\n"
        require(
            not manifest_path.exists() or manifest_path.read_text() == manifest_text,
            "capture manifest already differs",
        )
        path.write_bytes(raw)
        manifest_path.write_text(manifest_text)
        print(json.dumps({"status": "captured", "model_calls": len(record["native_calls"])}))
    else:
        raw = (args.archive / "record.json").read_bytes()
        require(
            hashlib.sha256(raw).hexdigest()
            == read(args.archive / "manifest.json")["record_sha256"],
            "capture bytes changed",
        )
        report = asyncio.run(verify_record(json.loads(raw), args.tau2_source))
        if args.negative_checks:
            report["negative_checks"] = asyncio.run(
                negative_checks(json.loads(raw), args.tau2_source)
            )
        # Keep the full task record in the archive; print only aggregate verification.
        print(json.dumps({k: v for k, v in report.items() if k != "record"}, indent=2))


if __name__ == "__main__":
    main()
