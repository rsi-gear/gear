"""Real pretrained local HF solver captures and Math-Verify; no parameter update."""

import argparse
import asyncio
import json
from dataclasses import asdict
from pathlib import Path

from gear.training.recipes.diagevo_answers import DiagEvoMathClassifier
from gear.training.recipes.diagevo_backends import _freeze
from gear.training.recipes.diagevo_inference import FrozenHFSolver
from gear.training.storage.content import ContentStore, atomic_json, digest_file
from gear.training.storage.models import seal_hf

QUESTIONS = {
    "multiply": "What is 6 multiplied by 7?",
    "conditional": "A fair die is rolled. Given that the result is even, what is the probability it exceeds 3?",
}


async def run(args):
    root = Path(args.workspace).resolve()
    store = ContentStore(root / "content")
    model = seal_hf(store, args.model_directory)
    backend = FrozenHFSolver(
        store,
        root / "solver",
        model_ref=model["model"]["hfSnapshotRef"],
        instruction=r"Solve the problem concisely. Put the final answer in \boxed{...}.",
        max_new_tokens=args.max_new_tokens,
        max_context_tokens=2048,
        max_calls=4,
        max_seconds=60,
        seed=20261120,
    )
    _freeze(
        root / "source.json",
        {
            "probe": digest_file(__file__),
            "backend": backend.identity,
            "modelSource": {"modelId": args.model_id, "revision": args.revision},
            "questions": QUESTIONS,
            "samplesPerQuestion": 2,
            "scope": "pretrained local inference and mathematical classification; no training or accuracy comparison",
        },
    )
    captures = await backend.sample("pretrained-solver-smoke-v1", QUESTIONS, count=2)
    classifier = DiagEvoMathClassifier(store)
    classes_ref = classifier.construction(QUESTIONS, captures)
    backend.model = backend.tokenizer = None
    replay = await backend.sample("pretrained-solver-smoke-v1", QUESTIONS, count=2)
    assert replay == captures and backend.model is None and backend.tokenizer is None
    records = [
        json.loads(p.read_text())["receipt"]
        for p in sorted((root / "solver/calls").glob("*/result.json"))
    ]
    usage = {
        "logicalGenerations": len(records),
        "inputTokens": sum(len(row["generation"]["inputTokenIds"]) for row in records),
        "outputTokens": sum(len(row["generation"]["outputTokenIds"]) for row in records),
        "generationSeconds": sum(row["generation"]["seconds"] for row in records),
        "externalModelCalls": 0,
        "trainingUpdates": 0,
        "usd": None,
    }
    result = {
        "schemaVersion": 1,
        "kind": "diagevo-pretrained-solver-smoke",
        "modelRef": model["modelRef"],
        "captures": {key: [asdict(raw) for raw in rows] for key, rows in captures.items()},
        "answerClassesRef": classes_ref,
        "usage": usage,
        "replayEqual": True,
    }
    ref = store.put_json(result)
    atomic_json(root / "result.json", {"artifactRef": ref, "artifact": result})
    print(
        json.dumps(
            {
                "artifactRef": ref,
                "usage": usage,
                "replayEqual": True,
                "answers": [
                    {
                        "questionId": row["request"]["questionId"],
                        "slot": row["request"]["slot"],
                        "text": row["generation"]["text"],
                    }
                    for row in records
                ],
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--model-directory", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--max-new-tokens", type=int, default=256)
    asyncio.run(run(parser.parse_args()))
