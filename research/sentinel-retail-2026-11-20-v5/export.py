"""Archive the terminal V5 evidence-slot rejection; never submit or resume a model turn."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

from records import capture, read, redact, require


def export(workspace, protocol_path, log_path, output):
    from gear.canonical import digest
    from sentinel_generate import implementation_identity

    require(
        not (workspace / "result.json").exists()
        and not (workspace / "test-admission.json").exists()
        and not list(workspace.glob("trials/*/*/*/decision.json")),
        "V5 must retain its stopped, unselected classification",
    )
    error = "Provider evidence contains an invalid or duplicate logical slot"
    log = log_path.read_text()
    require(log.rstrip().endswith(error), "original execution has not reported the terminal error")
    identity, protocol = read(workspace / "input.json"), read(protocol_path)
    require(
        identity["implementation"] == implementation_identity()
        and protocol["source_commit"] == "c032ab44a"
        and digest(identity["config"]) == protocol["config_digest"]
        and identity["model_calls"]["fixture"] is False,
        "frozen source, configuration or actual model transport differs",
    )
    roots = [path.parent for path in workspace.glob("observations/*/input.json")]
    roots += [
        path.parent
        for path in workspace.glob("trials/*/*/*/search/operations/*/samples/*/input.json")
    ]
    require(
        not list(workspace.glob("trials/*/*/*/generation/*/input.json")), "unexpected generation"
    )
    records = [capture(root) for root in sorted(roots)]
    accounted, receipts = set(), []
    for record in records:
        store = Path(record["files"]["input.json"]["call_store"])
        for row in record["native_calls"].values():
            directory = store / digest(row["request"]["key"]).removeprefix("sha256:")
            require(directory not in accounted, "one native turn is assigned to several records")
            accounted.add(directory)
            receipts.append(row["receipt"])
    journals = list(workspace.glob("trials/*/*/*/search/project/.gear/runs/*/journal.json"))
    require(len(journals) == 1, "unexpected formal search inventory")
    path = journals[0]
    search, run = path.parents[4], path.parent
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
            "unexpected additional candidate resources",
        )
    meta = []
    for pending_path in sorted((search / "calls").glob("*/pending.json")):
        if pending_path.parent in accounted:
            continue
        pending = read(pending_path)
        saved = read(pending_path.with_name("result.json"))
        require(
            pending["request"]["key"].endswith("/meta")
            and saved["request"] == pending["request"]
            and saved["digest"] == digest(saved["receipt"])
            and saved["receipt"]["status"] == "completed"
            and all(saved["receipt"][key] == pending[key] for key in ("thread_id", "turn_id"))
            and pending_path.parent.name == digest(saved["request"]["key"]).removeprefix("sha256:"),
            "unmatched native turn is not a complete bound Meta receipt",
        )
        accounted.add(pending_path.parent)
        receipts.append(saved["receipt"])
        meta.append({"request": saved["request"], "receipt": saved["receipt"]})
    require(
        accounted
        == {p.parent for p in workspace.glob("**/calls/*/pending.json")}
        == {p.parent for p in workspace.glob("**/calls/*/result.json")},
        "native inventory has unassigned, pending or missing turns",
    )
    require(all(row["usage"] is not None for row in receipts), "V5 usage is not fully known")
    usage = {
        "submitted_turns": len(receipts),
        "completed_turns": len(receipts),
        "native_tokens": sum(row["usage"]["total"]["total_tokens"] for row in receipts),
        "weight_training_steps": 0,
    }
    evidence = redact(
        {
            "source_commit": "c032ab44a",
            "workspace": str(workspace),
            "protocol": protocol,
            "study_identity": identity,
            "records": records,
            "search": {
                "workspace": str(search),
                "input": read(search / "input.json"),
                "admission": read(search / "admission.json"),
                "sources": read(search.parent / "sources.json"),
                "pool": read(search.parent / "pool/result.json"),
                "benchmark": read(run / "benchmark.json"),
                "journal": journal,
                "candidates": candidates,
                "operations": {
                    p.parent.name: read(p)
                    for p in sorted((search / "operations").glob("*/receipt.json"))
                },
                "meta_calls": meta,
            },
            "stop": {"exit_code": 1, "message": error, "log": log},
            "accounting": usage,
            "completed_study": False,
            "final_test_opened": False,
            "comparative_effect": None,
        }
    )
    raw = (json.dumps(evidence, ensure_ascii=False, indent=2) + "\n").encode()
    manifest = {
        "source_commit": evidence["source_commit"],
        "evidence_sha256": hashlib.sha256(raw).hexdigest(),
        "completed_study": False,
        "accounting": usage,
        "redactions": ["SDK thread_id and turn_id; original native receipt digests omitted"],
    }
    output.mkdir(parents=True, exist_ok=True)
    for name, data in (
        ("evidence.json", raw),
        ("manifest.json", (json.dumps(manifest, indent=2) + "\n").encode()),
    ):
        path = output / name
        require(not path.exists() or path.read_bytes() == data, "existing archive differs")
        path.write_bytes(data)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--log", type=Path, required=True)
    args = parser.parse_args()
    sys.path[:0] = [
        str(args.repository / "python"),
        str(args.repository / "examples/curriculum-harness"),
    ]
    print(
        json.dumps(export(args.workspace.resolve(), args.protocol, args.log, Path(__file__).parent))
    )
