"""Archive V7's original terminal 429; no model-submission or recovery path."""

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

    identity = read(workspace / "input.json")
    protocol = read(archive / "protocol.json")
    inspection = read(workspace / "inspection.json")
    log = log_path.read_text()
    require(
        identity["config"] == read(archive / "config.json")
        and digest(identity["config"]) == protocol["config_digest"]
        and identity["implementation"] == implementation_identity()
        and identity["model_calls"]["fixture"] is False
        and log.rstrip().endswith(
            "RuntimeError: exceeded retry limit, last status: 429 Too Many Requests"
        )
        and inspection["status"] == "failed"
        and inspection["usage"] is None
        and inspection["new_model_submissions"] == 0,
        "frozen source or terminal failure classification differs",
    )
    require(
        not (workspace / "result.json").exists()
        and not (workspace / "test-admission.json").exists()
        and not list(workspace.glob("trials/*/*/*/decision.json"))
        and not list(workspace.glob("trials/*/*/*/search/input.json")),
        "stopped study acquired selections, formal search or test results",
    )
    source_roots = sorted(path.parent for path in workspace.glob("observations/*/input.json"))
    generation_roots = sorted(
        path.parent for path in workspace.glob("trials/*/*/*/generation/*/input.json")
    )
    require(len(source_roots) == 2 and len(generation_roots) == 1, "caller inventory differs")
    records = [capture(root) for root in source_roots]
    prefix = capture_prefix(generation_roots[0], inspection)
    accounted, receipts = set(), []
    for record in [*records, prefix]:
        store = Path(record["files"]["input.json"]["call_store"])
        for row in record["native_calls"].values():
            directory = store / digest(row["request"]["key"]).removeprefix("sha256:")
            require(directory not in accounted, "native call assigned twice")
            accounted.add(directory)
            receipts.append(row["receipt"])
    missing = Path(inspection["pending_path"])
    require(
        len(receipts) == 40
        and len(prefix["native_calls"]) == 5
        and accounted == {p.parent for p in workspace.glob("**/calls/*/result.json")}
        and accounted | {missing.parent}
        == {p.parent for p in workspace.glob("**/calls/*/pending.json")}
        and not missing.with_name("result.json").exists()
        and all(row["usage"] is not None for row in receipts),
        "completed or failed native inventory differs",
    )
    accounting = {
        "submitted_turns": 41,
        "completed_turns": 40,
        "failed_turns": 1,
        "known_completed_native_tokens": sum(
            row["usage"]["total"]["total_tokens"] for row in receipts
        ),
        "all_attempt_tokens": None,
        "weight_training_steps": 0,
        "availability_calls_separate": 0,
    }
    evidence = redact(
        {
            "workspace": str(workspace),
            "protocol": protocol,
            "study_identity": identity,
            "records": records,
            "sources": read(generation_roots[0].parents[1] / "sources.json"),
            "prefix": prefix,
            "stop": {"process_exit_code": 1, "log": log, "inspection": inspection},
            "accounting": accounting,
            "completed_study": False,
            "final_test_opened": False,
            "comparative_effect": None,
        }
    )
    raw = (json.dumps(evidence, ensure_ascii=False, indent=2) + "\n").encode()
    manifest = {
        "source_commit": protocol["source_commit"],
        "config_digest": protocol["config_digest"],
        "evidence_sha256": hashlib.sha256(raw).hexdigest(),
        "accounting": accounting,
        "completed_study": False,
        "redactions": [
            "SDK thread_id and turn_id; original receipt digests and ID bindings checked before removal"
        ],
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
