"""Export the stopped, fully receipted V4 retail attempt without network access."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from gear.canonical import digest  # noqa: E402


def read(path):
    return json.loads(path.read_text())


def redact(value):
    if isinstance(value, dict):
        return {
            key: "<redacted>" if key in ("thread_id", "turn_id") else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def export(workspace, protocol, output):
    if (workspace / "result.json").exists() or (workspace / "test-admission.json").exists():
        raise ValueError("this archive is only for the stopped V4 attempt")
    inputs = list(workspace.glob("observations/*/input.json"))
    if len(inputs) != 1 or list(workspace.glob("trials/*/*/*/decision.json")):
        raise ValueError("unexpected study progress")
    root = inputs[0].parent
    files = {
        path.relative_to(root).as_posix(): read(path)
        for path in sorted(root.rglob("*.json"))
        if "calls" not in path.relative_to(root).parts
    }
    native = {}
    for path in sorted((root / "calls").glob("*/pending.json")):
        pending = read(path)
        saved = read(path.with_name("result.json"))
        if (
            saved["request"] != pending["request"]
            or saved["receipt"]["status"] != "completed"
            or saved["digest"] != digest(saved["receipt"])
            or any(saved["receipt"][key] != pending[key] for key in ("thread_id", "turn_id"))
        ):
            raise ValueError("unresolved or inconsistent model turn")
        key = saved["request"]["key"]
        if key in native:
            raise ValueError("duplicate native call")
        native[key] = {"pending": pending, "result": saved}
    if (
        len(native) != 43
        or len(list(workspace.glob("**/calls/*/pending.json"))) != len(native)
        or "result.json" in files
        or "model/solve/22.json" not in files
    ):
        raise ValueError("archive inventory differs from the stopped attempt")
    tokens = sum(
        row["result"]["receipt"]["usage"]["total"]["total_tokens"] for row in native.values()
    )
    if tokens != 990092:
        raise ValueError("native accounting differs from V4")
    # Redacted receipts are explicitly exports, not original receipt digests.
    # The verifier checks equality across both exported copies, then replays.
    for row in native.values():
        row["result"].pop("digest")
    evidence = redact(
        {
            "schema_version": 1,
            "source_commit": "52d720227",
            "protocol": read(protocol),
            "study_identity": read(workspace / "input.json"),
            "record": {"workspace": str(root), "files": files, "native_calls": native},
            "stop": {
                "exit_code": 1,
                "exception": "ValueError",
                "message": "reference messages require text and no tool arguments",
                "model_key": "solve/22",
                "native_turn_status": "completed",
                "task_result": None,
                "new_submissions_after_stop": 0,
            },
            "accounting": {
                "submitted_turns": len(native),
                "completed_turns": len(native),
                "native_tokens": tokens,
                "weight_training_steps": 0,
                "separate_availability_probe_tokens": 9224,
            },
            "completed_study": None,
        }
    )
    raw = (json.dumps(evidence, ensure_ascii=False, indent=2) + "\n").encode()
    output.mkdir(parents=True, exist_ok=True)
    manifest = {
        "source_commit": evidence["source_commit"],
        "evidence_sha256": hashlib.sha256(raw).hexdigest(),
        "completed_study": False,
        "redactions": ["SDK thread_id and turn_id; original native receipt digests omitted"],
        "accounting": evidence["accounting"],
    }
    for name, data in (
        ("evidence.json", raw),
        ("manifest.json", (json.dumps(manifest, indent=2) + "\n").encode()),
    ):
        path = output / name
        if path.exists() and path.read_bytes() != data:
            raise ValueError("export already exists with different bytes")
        path.write_bytes(data)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--protocol", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(export(args.workspace.resolve(), args.protocol, Path(__file__).parent)))
