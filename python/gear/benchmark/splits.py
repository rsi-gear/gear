"""Deterministic, reviewable partitions; family and duplicate inputs stay together."""

from __future__ import annotations

from gear.canonical import digest

from .source import BenchmarkError


def propose_splits(tasks: list[dict], supplied: dict[str, str], mode: str = "holdout") -> dict:
    if mode not in ("holdout", "research"):
        raise BenchmarkError("validation mode must be holdout or research", "validation.mode")
    if any(value not in (None, "", "seed", "held_out") for value in supplied.values()):
        raise BenchmarkError("invalid explicit split", "split")
    roots = {task["id"]: task["id"] for task in tasks}

    def root(identifier):
        while roots[identifier] != identifier:
            roots[identifier] = roots[roots[identifier]]
            identifier = roots[identifier]
        return identifier

    families, inputs = {}, {}
    for task in sorted(tasks, key=lambda value: value["id"]):
        identifier = task["id"]
        input_digest = digest({"instruction": task["instruction"], "resources": task["resources"]})
        for owners, key in ((families, task["family"]), (inputs, input_digest)):
            previous = owners.setdefault(key, identifier)
            roots[root(identifier)] = root(previous)
    grouped = {}
    for task in tasks:
        grouped.setdefault(root(task["id"]), []).append(task["id"])
    groups = sorted(
        (sorted(ids) for ids in grouped.values()), key=lambda ids: digest(["family-split-v1", ids])
    )
    selected, unassigned = {}, []
    for ids in groups:
        explicit = {supplied[identifier] for identifier in ids if supplied.get(identifier)}
        if explicit - {"seed", "held_out"} or len(explicit) > 1:
            raise BenchmarkError(
                "conflicting or invalid explicit split in a family/input group",
                "split:" + ",".join(ids),
            )
        if mode == "research" and "held_out" in explicit:
            raise BenchmarkError(
                "research import cannot discard an explicit held_out annotation",
                "split:" + ",".join(ids),
            )
        if mode == "research":
            selected[tuple(ids)] = "seed"
        elif explicit:
            selected[tuple(ids)] = next(iter(explicit))
        else:
            unassigned.append(ids)
    if mode == "holdout":
        if len(groups) < 2:
            raise BenchmarkError(
                "independent validation needs at least two family/input groups; add tasks or explicitly choose research",
                "split",
            )
        # Aim for one fifth of groups, respecting all author annotations. Whole groups remain indivisible.
        desired = max(1, (len(groups) + 4) // 5)
        held = sum(value == "held_out" for value in selected.values())
        for index, ids in enumerate(unassigned):
            seed_exists = "seed" in selected.values()
            must_seed = not seed_exists and index == len(unassigned) - 1
            partition = "held_out" if held < desired and not must_seed else "seed"
            selected[tuple(ids)] = partition
            held += partition == "held_out"
        if set(selected.values()) != {"seed", "held_out"}:
            raise BenchmarkError(
                "explicit assignments leave no independent seed/held_out pair", "split"
            )
    splits = {
        partition: sorted(
            identifier
            for ids, selected_split in selected.items()
            if selected_split == partition
            for identifier in ids
        )
        for partition in ("seed", "held_out")
    }
    return {
        "version": 1,
        **splits,
        "allocation": {
            "method": "family-input-hash-v1",
            "validation_mode": mode,
            "groups": [{"task_ids": ids, "split": selected[tuple(ids)]} for ids in groups],
            "note": "同集优化，未做独立验证"
            if mode == "research"
            else "Whole family/identical-input groups; explicit annotations retained; deterministic hash order for unassigned groups.",
        },
    }
