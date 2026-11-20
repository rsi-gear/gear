"""Archive the terminal V6 timeout, retaining the original interrupted native request."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

from prefix import capture_prefix
from records import capture, read, redact, require


def export(workspace, log_path, archive):
    from gear.canonical import digest
    from sentinel_generate import implementation_identity

    identity, protocol = read(workspace / "input.json"), read(archive / "protocol.json")
    log, inspection = log_path.read_text(), read(workspace / "inspection.json")
    require(
        identity["config"] == read(archive / "config.json")
        and protocol["config_digest"] == digest(identity["config"])
        and identity["implementation"] == implementation_identity()
        and identity["model_calls"]["fixture"] is False
        and log.rstrip().endswith("TimeoutError")
        and inspection["native_turn_status"] == "interrupted"
        and inspection["error"] is None
        and inspection["usage"] is None
        and inspection["new_model_submissions"] == 0,
        "frozen source or original timeout classification changed",
    )
    require(
        not (workspace / "result.json").exists()
        and not (workspace / "test-admission.json").exists()
        and not list(workspace.glob("trials/*/*/*/decision.json"))
        and not list(workspace.glob("trials/*/*/*/generation/*/input.json")),
        "interrupted study acquired generation, selection or test results",
    )
    roots = [path.parent for path in workspace.glob("observations/*/input.json")]
    roots += [
        path.parent
        for path in workspace.glob("trials/*/*/*/search/operations/*/samples/*/input.json")
    ]
    completed = [capture(root) for root in sorted(roots) if (root / "result.json").exists()]
    unfinished = [root for root in roots if not (root / "result.json").exists()]
    require(len(completed) == 5 and len(unfinished) == 1, "caller inventory changed")
    prefix = capture_prefix(unfinished[0], inspection)
    accounted, receipts = set(), []
    for record in [*completed, prefix]:
        store = Path(record["files"]["input.json"]["call_store"])
        for row in record["native_calls"].values():
            path = store / digest(row["request"]["key"]).removeprefix("sha256:")
            require(path not in accounted, "native call assigned twice")
            accounted.add(path)
            receipts.append(row["receipt"])
    journals = list(workspace.glob("trials/*/*/*/search/project/.gear/runs/*/journal.json"))
    require(len(journals) == 1, "unexpected formal run inventory")
    path = journals[0]
    run, search = path.parent, path.parents[4]
    journal = read(path)
    candidates = []
    for candidate in journal["candidates"]:
        name = candidate["id"]
        candidates.append(
            {
                "manifest": read(run / "target-manifests" / (name + ".json")),
                "harness": (run / "targets" / name / "AGENTS.md").read_text(),
                "settings": read(run / "targets" / name / ".pi/settings.json"),
            }
        )
        require(
            not any(
                item.is_file()
                for folder in ("extensions", "skills", "prompts")
                for item in (run / "targets" / name / ".pi" / folder).rglob("*")
            ),
            "unexpected candidate resources",
        )
    meta = []
    missing_path = Path(inspection["pending_path"])
    for path in sorted(workspace.glob("**/calls/*/pending.json")):
        if path.parent in accounted or path == missing_path:
            continue
        pending, saved = read(path), read(path.with_name("result.json"))
        receipt = saved["receipt"]
        require(
            pending["request"]["key"].endswith("/meta")
            and saved["request"] == pending["request"]
            and saved["digest"] == digest(receipt)
            and receipt["status"] == "completed"
            and not receipt.get("fixture", False)
            and all(receipt[key] == pending[key] for key in ("thread_id", "turn_id"))
            and path.parent.name == digest(saved["request"]["key"]).removeprefix("sha256:"),
            "unassigned call is not a bound native Meta receipt",
        )
        accounted.add(path.parent)
        receipts.append(receipt)
        meta.append({"request": saved["request"], "receipt": receipt})
    require(
        len(meta) == 1
        and len(receipts) == 140
        and accounted == {path.parent for path in workspace.glob("**/calls/*/result.json")}
        and accounted | {missing_path.parent}
        == {path.parent for path in workspace.glob("**/calls/*/pending.json")}
        and not missing_path.with_name("result.json").exists()
        and all(row["usage"] is not None for row in receipts),
        "original completed/interrupted inventory or usage differs",
    )
    accounting = {
        "submitted_turns": len(accounted) + 1,
        "completed_turns": len(receipts),
        "interrupted_turns": 1,
        "known_completed_native_tokens": sum(
            row["usage"]["total"]["total_tokens"] for row in receipts
        ),
        "all_attempt_tokens": None,
        "weight_training_steps": 0,
        "availability_native_tokens_separate": 10617,
    }
    evidence = redact(
        {
            "workspace": str(workspace),
            "protocol": protocol,
            "study_identity": identity,
            "records": completed,
            "prefix": prefix,
            "search": {
                "workspace": str(search),
                "input": read(search / "input.json"),
                "admission": read(search / "admission.json"),
                "sources": read(search.parent / "sources.json"),
                "pool": read(search.parent / "pool/result.json"),
                "pool_input": read(search.parent / "pool/input.json"),
                "benchmark": read(run / "benchmark.json"),
                "journal": journal,
                "candidates": candidates,
                "operations": {
                    path.parent.name: read(path)
                    for path in sorted((search / "operations").glob("*/receipt.json"))
                },
                "meta_calls": meta,
            },
            "stop": {
                "process_exit_code": 1,
                "local_error": "TimeoutError",
                "log": log,
                "inspection": inspection,
            },
            "accounting": accounting,
            "completed_study": False,
            "final_test_opened": False,
            "comparative_effect": None,
        }
    )
    raw = (json.dumps(evidence, ensure_ascii=False, indent=2) + "\n").encode()
    manifest = {
        "source_commit": protocol["source_commit"],
        "evidence_sha256": hashlib.sha256(raw).hexdigest(),
        "accounting": accounting,
        "completed_study": False,
        "redactions": ["SDK thread_id and turn_id; native receipt digests checked before removal"],
    }
    for name, data in (
        ("evidence.json", raw),
        ("manifest.json", (json.dumps(manifest, indent=2) + "\n").encode()),
    ):
        path = archive / name
        require(not path.exists() or path.read_bytes() == data, "existing archive differs")
        path.write_bytes(data)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--log", type=Path, required=True)
    args = parser.parse_args()
    sys.path[:0] = [
        str(args.repository / "python"),
        str(args.repository / "examples/curriculum-harness"),
    ]
    print(json.dumps(export(args.workspace.resolve(), args.log, Path(__file__).parent), indent=2))
