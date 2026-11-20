"""Export the stopped, single-attempt probe without importing the model SDK."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sentinel-retail-2026-11-20-v5"))
from records import files, read, redact, require


def export(workspace, script, output):
    from gear.canonical import digest

    protocol = read(workspace / "protocol.json")
    require(
        protocol["script_sha256"] == hashlib.sha256(script.read_bytes()).hexdigest(),
        "original probe script changed",
    )
    calls, completed_paths = {}, set()
    for path in sorted(workspace.glob("*/calls/*/pending.json")):
        pending = read(path)
        request = pending["request"]
        key = path.parents[2].name + "/" + request["key"]
        require(
            key not in calls and path.parent.name == digest(request["key"]).removeprefix("sha256:"),
            "duplicate or mismatched native request",
        )
        row = {"pending": pending}
        result_path = path.with_name("result.json")
        if result_path.exists():
            saved = read(result_path)
            receipt = saved["receipt"]
            require(
                saved["request"] == request
                and saved["digest"] == digest(receipt)
                and receipt["status"] == "completed"
                and not receipt.get("fixture", False)
                and all(receipt[k] == pending[k] for k in ("thread_id", "turn_id")),
                "original receipt binding differs",
            )
            row["receipt"] = receipt
            completed_paths.add(result_path)
        calls[key] = row
    require(
        completed_paths == set(workspace.glob("*/calls/*/result.json"))
        and set(calls)
        == {
            "finish/finish-interface",
            "generation/diagnose",
            "generation/goal",
            "generation/user/0",
            "generation/explore/0",
            "generation/explore/1",
            "generation/explore/2",
        }
        and [key for key, row in calls.items() if "receipt" not in row] == ["generation/explore/2"],
        "stopped probe inventory changed",
    )
    prefix = files(workspace / "generation")
    require("result.json" not in prefix, "probe acquired a generator result")
    for name, value in prefix.items():
        if name.startswith("model/"):
            require(
                value["receipt"] == calls["generation/" + name[6:-5]]["receipt"],
                "caller response differs from original native receipt",
            )
    finish = read(workspace / "finish/result.json")
    require(
        finish.pop("receipt_digest") == digest(calls["finish/finish-interface"]["receipt"]),
        "original final-reply receipt digest differs",
    )
    receipts = [row["receipt"] for row in calls.values() if "receipt" in row]
    require(all(row["usage"] is not None for row in receipts), "completed usage missing")
    accounting = {
        "submitted_logical_turns": len(calls),
        "completed_turns": len(receipts),
        "failed_turns": 1,
        "known_completed_native_tokens": sum(
            row["usage"]["total"]["total_tokens"] for row in receipts
        ),
        "all_attempt_tokens": None,
        "cpu_read_only_tool_executions": 2,
        "weight_training_steps": 0,
    }
    evidence = redact(
        {
            "workspace": str(workspace),
            "protocol": protocol,
            "calls": calls,
            "finish_result": finish,
            "generation_files": prefix,
            "inspection": read(workspace / "inspection.json"),
            "quota_snapshot": read(workspace / "quota-snapshot.json"),
            "accounting": accounting,
            "completed_study": False,
            "comparative_effect": None,
        }
    )
    raw = (json.dumps(evidence, ensure_ascii=False, indent=2) + "\n").encode()
    manifest = {
        "source_commit": protocol["source_commit"],
        "evidence_sha256": hashlib.sha256(raw).hexdigest(),
        "accounting": accounting,
        "redactions": ["SDK thread_id and turn_id; native receipt digests checked before removal"],
    }
    output.mkdir(parents=True, exist_ok=True)
    for name, data in (
        ("evidence.json", raw),
        ("manifest.json", (json.dumps(manifest, indent=2) + "\n").encode()),
        ("probe.py", script.read_bytes()),
    ):
        path = output / name
        require(not path.exists() or path.read_bytes() == data, "existing archive differs")
        path.write_bytes(data)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--script", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.repository / "python"))
    print(json.dumps(export(args.workspace, args.script, Path(__file__).parent), indent=2))
