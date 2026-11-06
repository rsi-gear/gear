"""Read-only seed archive projections; never execute a recipe or draw a new parent."""

from __future__ import annotations

from typing import Any

from gear.canonical import digest

from .objective import comparison_key
from .projection import project_candidate


def project_research(input: dict[str, Any]) -> dict[str, Any]:
    objects = input["objects"]
    conditions = [item["value"] for item in objects if item["kind"] == "conditions"]
    if len(conditions) != 1:
        raise ValueError("research archive needs exactly one set of conditions")
    condition = conditions[0]
    candidates = [item["value"] for item in objects if item["kind"] == "candidate"]
    candidate_ids = [candidate["id"] for candidate in candidates]
    tasks = [task["id"] for task in condition["tasks"]]
    evidence = [item["value"] for item in objects if item["kind"] == "evidence"]
    cells: dict[str, list[dict[str, Any]]] = {candidate: [] for candidate in candidate_ids}
    for cell in evidence:
        if cell["candidate_id"] not in cells or cell["task_id"] not in tasks:
            raise ValueError("research evidence is outside the admitted seed scope")
        cells[cell["candidate_id"]].append(cell)
    base = {
        "partition": "seed",
        "repetitions": condition["repetitions"],
        "anchor_id": condition["anchor"]["id"],
        "objective": condition["objective"],
    }
    precision = (
        condition["objective"]["definition"]["comparisonPrecision"]
        if condition["objective"]
        else 1e-9
    )
    scopes: dict[str, dict[str, Any]] = {}
    unavailable = []
    selections = []
    rankings = []

    def add_scope(record: dict[str, Any], source: dict[str, Any]) -> None:
        data = record["data"]
        weights = data.get("weights") if isinstance(data, dict) else None
        # Arbitrary recipes may publish opaque annotations. Do not invent their weights.
        if not isinstance(weights, dict):
            unavailable.append({**source, "scope": record["scope"], "reason": "missing weights"})
            return
        manifest = {
            "task_ids": sorted(record["task_ids"]),
            "weights": weights,
            "repetitions": condition["repetitions"],
        }
        try:
            project_candidate({**base, **manifest, "candidate_id": "", "evidence": []})
        except (KeyError, TypeError, ValueError) as error:
            unavailable.append({**source, "scope": record["scope"], "reason": str(error)})
            return
        identity = digest(manifest)
        group = scopes.setdefault(
            identity,
            {"digest": identity, **manifest, "occurrences": [], "candidate_ids": []},
        )
        group["occurrences"].append({**source, "scope": record["scope"], "data": data})
        for candidate in record["candidate_ids"]:
            if candidate not in cells or any(task not in tasks for task in record["task_ids"]):
                raise ValueError("research scope is outside the admitted seed view")
            if candidate not in group["candidate_ids"]:
                group["candidate_ids"].append(candidate)

    # This reference projection covers the admitted seed set, including candidates
    # never sent to the global stage. Their absent cells remain incomplete.
    if tasks:
        add_scope(
            {
                "scope": "admitted_seed",
                "task_ids": tasks,
                "candidate_ids": candidate_ids,
                "data": {"weights": {task: 1 / len(tasks) for task in tasks}},
            },
            {"authority": "admission", "step_id": None},
        )
    for item in objects:
        if item["kind"] != "decision":
            continue
        decision = item["value"]
        source = {
            "authority": "algorithm-reported",
            "step_id": decision["step_id"],
            "decision_digest": decision["decision_digest"],
        }
        for record in decision["records"]:
            if record["kind"] == "scope":
                add_scope(record, source)
            elif record["kind"] == "parents":
                selections.append({**source, "record": record})
            elif record["kind"] == "ranking":
                rankings.append({**source, "record": record})

    projected_slots = sum(
        len(group["candidate_ids"]) * len(group["task_ids"]) * condition["repetitions"]
        for group in scopes.values()
    )
    if projected_slots > 10_000:
        raise ValueError(
            "research projection exceeds 10000 scoped slots; read the complete raw archive"
        )

    for group in scopes.values():
        profiles = []
        for candidate in group["candidate_ids"]:
            anchor = base["anchor_id"]
            selected = cells[candidate] + (cells[anchor] if anchor != candidate else [])
            request = {
                **base,
                "candidate_id": candidate,
                "evidence": selected,
                "task_ids": group["task_ids"],
                "weights": group["weights"],
            }
            profile = project_candidate(request)
            by_task = {
                task: project_candidate({**request, "task_ids": [task], "weights": {task: 1}})
                for task in group["task_ids"]
            }
            profiles.append({"candidate_id": candidate, **profile, "by_task": by_task})
        leaders: dict[str, list[str]] = {}
        for task in group["task_ids"]:
            eligible = [
                profile
                for profile in profiles
                if profile["complete"]
                and profile["constraints_passed"]
                and profile["by_task"][task]["complete"]
                and profile["by_task"][task]["constraints_passed"]
            ]
            maximum = max(
                (
                    comparison_key(profile["by_task"][task]["score"], precision)
                    for profile in eligible
                ),
                default=None,
            )
            leaders[task] = [
                profile["candidate_id"]
                for profile in eligible
                if comparison_key(profile["by_task"][task]["score"], precision) == maximum
            ]
        group.update(profiles=profiles, task_leaders=leaders)

    return {
        "version": 1,
        "partition": "seed",
        "scopes": list(scopes.values()),
        "unavailable_scopes": unavailable,
        # Historical draws are preserved verbatim. Task leaders above are a
        # descriptive comparison, not a recomputed GEPA eligibility distribution.
        "parent_selections": selections,
        "rankings": rankings,
        "generations": [
            {
                "operation_id": item["value"]["operation_id"],
                "parent_id": item["value"]["operation"]["parent_id"],
                "candidate_id": item["value"]["operation"]["candidate_id"],
                "status": item["value"]["status"],
                "result": (item["value"].get("receipt") or {}).get("result"),
            }
            for item in objects
            if item["kind"] == "operation"
            and item["value"]["operation"]["kind"] == "generate_candidate"
        ],
    }
