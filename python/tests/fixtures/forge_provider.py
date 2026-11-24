"""Offline deterministic process provider for the Forge recipe integration test."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))

from formal_provider import build_receipt, prepare_jobs  # noqa: E402
from gear.canonical import digest  # noqa: E402
from ifeval import INITIAL_HARNESS, read_json, write_json  # noqa: E402


class FixtureBenchmark:
    manifest = {"fixture": True}
    resource_identity = {"fixture": True}
    verifier_policy = {"fixture": "no-comma-or-lowercase-v1"}

    def __init__(self, root):
        self.root = Path(root)

    def eligible_tasks(self, seed):
        return [
            {
                "id": f"task-{i}",
                "key": i,
                "family": f"family-{i}",
                "prompt": f"{'TRAIN' if i < 2 else 'PRIVATE_DEV' if i < 4 else 'PRIVATE_TEST'} {i}",
                "instruction_id_list": ["punctuation:no_comma"],
                "kwargs": [{}],
            }
            for i in range(5)
        ]

    def descriptions(self, task):
        if any(kwargs != {} for kwargs in task["kwargs"]) or len(
            task["instruction_id_list"]
        ) != len(task["kwargs"]):
            raise ValueError("unfrozen parameters")
        descriptions = {
            "punctuation:no_comma": "Do not use commas.",
            "change_case:english_lowercase": "Use lowercase letters.",
        }
        return [descriptions[name] for name in task["instruction_id_list"]]

    def grade(self, task, response):
        self.descriptions(task)
        checks = {
            f"{i}:{name}": bool(response)
            and ("," not in response if name == "punctuation:no_comma" else response.islower())
            for i, name in enumerate(task["instruction_id_list"])
        }
        return {"passed": all(checks.values()), "checks": checks}


def respond(message):
    identity = digest(Path(__file__).read_text())
    if message["action"] == "describe":
        return {
            "version": 1,
            "identity": identity,
            "capabilities": {
                "seeds": False,
                "temperature": False,
                "subsets": True,
                "idempotentSubmission": True,
                "inspect": True,
                "cancel": False,
                "physicalAttemptAccounting": True,
                "evidenceProjection": False,
                "generationBudget": False,
                "hardDollarBudget": False,
                "operatorMeta": True,
            },
        }
    request, config, context = (message[k] for k in ("request", "configuration", "context"))
    directory = Path(config["receipts"])
    path = directory / (request["operationId"].removeprefix("sha256:") + ".json")
    binding = digest([request, context, config, identity])
    if path.exists():
        value = read_json(path)
        if value["binding"] != binding:
            raise ValueError("fixture operation changed")
        receipt = value["receipt"]
    else:
        if message["action"] == "inspect":
            return {"state": "not_submitted"}
        jobs = prepare_jobs(context, request)
        receipts = []
        for job in jobs:
            if "schema" in job:
                text = json.dumps(
                    {
                        "text": "Check each requested constraint before answering. Fixture "
                        + request["runId"]
                    }
                )
            elif job["task"]["id"] in ("task-2", "task-3"):
                # Same total dev score, different local front; do not discard
                # this training-admitted candidate because dev does not improve.
                good = (job["task"]["id"] == "task-2") == (job["harness"] == INITIAL_HARNESS)
                text = "valid answer" if good else "wrong, answer"
            else:
                text = (
                    "wrong, answer"
                    if request["operation"]["candidate_id"] == "anchor"
                    else "valid answer"
                )
            receipts.append({"response": text, "usage": None})
        receipt = build_receipt(request, jobs, receipts, FixtureBenchmark(directory), identity)
        write_json(path, {"binding": binding, "receipt": receipt})
        with (directory / "submitted.jsonl").open("a") as stream:
            stream.write(json.dumps(request["operationId"]) + "\n")
    return {"state": "complete", "receipt": receipt} if message["action"] == "inspect" else receipt


if __name__ == "__main__":
    print(json.dumps(respond(json.load(sys.stdin))))
