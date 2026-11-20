"""Standalone Harbor verifier for transport completion, never mathematical truth."""

import json
import sys
from pathlib import Path


def completion(path, max_bytes):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > max_bytes:
        raise ValueError("missing, unsafe or oversized canonical response")

    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate canonical response field")
            value[key] = item
        return value

    value = json.loads(path.read_bytes(), object_pairs_hook=unique)
    if (
        not isinstance(value, dict)
        or set(value) != {"schema_version", "run_id", "response", "termination", "source"}
        or value["schema_version"] != "1"
        or not isinstance(value["run_id"], str)
        or not value["run_id"]
        or not isinstance(value["response"], str)
        or value["termination"] != "succeeded"
        or value["source"] != "hitch-run-result"
    ):
        raise ValueError("expected a successful canonical Hitch text response")
    # Even an empty or wrong answer completed. Math-Verify and the frozen
    # majority-vote curriculum supply a separate native training reward.
    return {"completion": 1}


def main():
    result = completion(sys.argv[1], int(sys.argv[2]))
    output = Path(sys.argv[3] if len(sys.argv) > 3 else "/logs/verifier/reward.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result) + "\n")
