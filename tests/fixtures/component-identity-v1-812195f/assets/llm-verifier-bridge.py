"""Strict stdin/stdout bridge for the optional llm-verifier assessor.

Gear owns process isolation, timeouts, configuration identity, and durable
evidence.  This helper only adapts one immutable JSON request to the public
``llm_verifier.select`` API and emits one bounded JSON result.
"""

from __future__ import annotations

import json
import sys

import llm_verifier


def require(value, kind, label):
    if not isinstance(value, kind):
        raise TypeError(f"{label} has the wrong type")
    return value


def main() -> int:
    request = require(json.load(sys.stdin), dict, "request")
    if request.get("schema_version") != 1:
        raise ValueError("unsupported bridge request schema")
    config = require(request.get("config"), dict, "config")
    cells = require(request.get("cells"), list, "cells")
    llm_verifier.USAGE.reset()
    results = []
    for index, cell_value in enumerate(cells):
        cell = require(cell_value, dict, f"cells[{index}]")
        candidates = require(cell.get("candidates"), list, f"cells[{index}].candidates")
        candidate_ids = [require(item, dict, "candidate").get("candidate_id") for item in candidates]
        traces = [require(item.get("trace"), str, "candidate.trace") for item in candidates]
        if any(not isinstance(candidate_id, str) or not candidate_id for candidate_id in candidate_ids):
            raise ValueError("candidate ids must be non-empty strings")
        result = llm_verifier.select(
            problem=require(cell.get("problem"), str, f"cells[{index}].problem"),
            candidates=traces,
            criteria=require(config.get("criteria"), dict, "config.criteria"),
            ground_truth_note=config.get("ground_truth_note"),
            n_evaluations=require(config.get("n_evaluations"), int, "config.n_evaluations"),
            pivots=require(config.get("pivots"), int, "config.pivots"),
            seed=require(config.get("seed"), int, "config.seed"),
            max_workers=require(config.get("max_workers"), int, "config.max_workers"),
            model=require(config.get("model"), str, "config.model"),
            progress=False,
            on_error="raise",
        )
        results.append({
            "task_name": cell.get("task_name"),
            "attempt": cell.get("attempt"),
            "candidate_ids": candidate_ids,
            "scores": {candidate_id: result.scores[position] for position, candidate_id in enumerate(candidate_ids)},
            "ranking_candidate_ids": [candidate_ids[position] for position in result.ranking],
            "winner_candidate_id": candidate_ids[result.index],
            "n_comparisons": result.n_comparisons,
            "criteria": result.criteria,
        })
    usage = llm_verifier.token_usage()
    json.dump({
        "schema_version": 1,
        "cells": results,
        "usage": {
            "model_requests": usage["calls"],
            "input_tokens": usage["input_tokens"],
            "cached_input_tokens": usage["cached_input_tokens"],
            "output_tokens": usage["output_tokens"],
            "reasoning_tokens": usage["reasoning_tokens"],
        },
    }, sys.stdout, separators=(",", ":"), sort_keys=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # the TypeScript side records the bounded stderr
        print(f"llm-verifier bridge failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
