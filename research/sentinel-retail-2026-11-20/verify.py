"""Re-execute the archived generation with recorded model responses, never a live client."""

import argparse
import asyncio
import hashlib
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))

from gear.canonical import digest  # noqa: E402
from sentinel_generate import RetailGenerator  # noqa: E402


class RecordedCalls:
    """Exact input checks for this archive; no SDK instance or submission method exists."""

    def __init__(self, evidence):
        identity = evidence["identity"]
        self.identity = identity["model_calls_identity"]
        self.root = Path(identity["call_store"])
        self.timeout_seconds = identity["call_timeout_seconds"]
        self.max_calls = identity["config"]["max_calls"]
        self.model = identity["config"]["model"]
        self.effort = identity["config"]["effort"]
        self.records = {row["key"]: row for row in evidence["model_calls"]}
        if len(self.records) != len(evidence["model_calls"]):
            raise ValueError("duplicate archived model call")
        self.seen = set()

    async def call(self, key, prompt, harness, **settings):
        record = self.records[key]
        prepared = record["input"]
        if (
            json.loads(prompt) != prepared["data"]
            or harness != prepared["prompt"]
            or settings
            != {"model": self.model, "effort": self.effort, "output_schema": prepared["schema"]}
        ):
            raise ValueError("archived model input changed: " + key)
        self.seen.add(key)
        return record["receipt"]


def verify(archive, source):
    manifest = json.loads((archive / "manifest.json").read_text())
    raw = (archive / "evidence.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest["evidence_sha256"]:
        raise ValueError("archive bytes differ from the manifest")
    evidence = json.loads(raw)
    calls = RecordedCalls(evidence)
    with tempfile.TemporaryDirectory(prefix="gear-sentinel-audit-") as directory:
        caller = RetailGenerator(directory, source, evidence["identity"]["config"], calls)
        if caller.identity != evidence["identity"]:
            raise ValueError("runtime, configuration or source differs from the recorded run")
        result = asyncio.run(caller.generate())
        if result != evidence["result"]:
            raise ValueError("recomputed result differs from the archived result")
        for name in ("reference", "calibration", "validation-evidence"):
            actual = json.loads((Path(directory) / (name + ".json")).read_text())
            if actual != evidence[name]:
                raise ValueError("recomputed evidence differs: " + name)
        if calls.seen != set(calls.records):
            raise ValueError("archive includes unused model calls")
    return {
        "status": "passed",
        "result_digest": digest(result),
        "model_responses_replayed": len(calls.seen),
        "new_model_submissions": 0,
        "native_tools_and_verifier_reexecuted": True,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tau2-source", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(Path(__file__).resolve().parent, args.tau2_source), indent=2))
