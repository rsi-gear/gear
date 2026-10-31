"""Independent assertion extraction and per-repetition protection decisions."""

from __future__ import annotations

from typing import Any


def extract_assertions(input: dict[str, Any]) -> list[dict[str, Any]]:
    values = []
    for contract in input["contracts"]:
        observation = {
            "id": contract["id"],
            "schemaDigest": contract["digest"],
            "evidenceRefs": input["evidence_refs"],
        }
        if not input["certified"]:
            values.append(
                {
                    **observation,
                    "status": "invalid",
                    "reason": "original observation is not certified",
                }
            )
            continue
        current = input["trial"]
        for part in contract["source"]["path"].split("."):
            current = current.get(part) if isinstance(current, dict) else None
        status = None
        if contract["source"]["extractor"] == "boolean-v1" and type(current) is bool:
            status = "passed" if current else "failed"
        elif contract["source"]["extractor"] == "assertion-status-v1" and current in (
            "passed",
            "failed",
            "excluded",
        ):
            status = current
        if status is None:
            values.append(
                {
                    **observation,
                    "status": "missing" if current is None else "invalid",
                    "reason": "assertion source is absent"
                    if current is None
                    else "assertion source type does not match its contract",
                }
            )
        else:
            values.append({**observation, "status": status})
    return values


def assertion_passed(rule: str, baseline: str, candidate: str) -> bool:
    if rule == "must_pass":
        return candidate == "passed"
    if rule == "no_new_violation":
        return baseline == "failed" or candidate != "failed"
    raise ValueError("unsupported assertion protection rule")


def project_assertions(input: dict[str, Any]) -> list[dict[str, Any]]:
    configuration = input.get("objective") or {}
    result = []
    contracts = {item["id"]: item for item in configuration.get("assertions", [])}
    cells: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
    for cell in input["evidence"]:
        cells.setdefault((cell["candidate_id"], cell["task_id"], cell["repetition"]), []).append(
            cell
        )

    def observation(
        candidate: str, task: str, repetition: int, identifier: str
    ) -> dict[str, Any] | None:
        slot = cells.get((candidate, task, repetition), [])
        if len(slot) != 1 or slot[0]["status"] not in ("valid", "task_failed"):
            return None
        cell = slot[0]
        values = [item for item in cell.get("assertions") or [] if item["id"] == identifier]
        if len(values) > 1:
            raise ValueError("duplicate independent assertion identity")
        return values[0] if values else None

    for guard in configuration.get("assertion_protection", []):
        if (
            guard["partition"] != input.get("partition", "seed")
            or guard["task_id"] not in input["task_ids"]
        ):
            continue
        contract = contracts.get(guard["assertion_id"])
        if contract is None:
            raise ValueError("protected assertion has no frozen contract")
        for repetition in range(input["repetitions"]):
            before = observation(
                input["anchor_id"], guard["task_id"], repetition, guard["assertion_id"]
            )
            after = observation(
                input["candidate_id"], guard["task_id"], repetition, guard["assertion_id"]
            )
            for item in (before, after):
                if item and item["schemaDigest"] != contract["digest"]:
                    raise ValueError("protected assertion schema mismatch")
            outcome = "unavailable"
            if (
                before
                and after
                and all(
                    item["status"] in ("passed", "failed", "excluded") for item in (before, after)
                )
            ):
                passed = assertion_passed(guard["rule"], before["status"], after["status"])
                outcome = "passed" if passed else "failed"
            result.append(
                {
                    **guard,
                    "repetition": repetition,
                    "schemaDigest": contract["digest"],
                    "status": outcome,
                    "baseline_status": before["status"] if before else None,
                    "candidate_status": after["status"] if after else None,
                }
            )
    return result


def assertion_rows(input: dict[str, Any]) -> list[dict[str, Any]]:
    """Operator projection of every declared assertion, including unguarded ones."""
    contracts = (input.get("objective") or {}).get("assertions", [])
    if not contracts:
        return []
    cells = {
        (cell["task_id"], cell["repetition"]): cell
        for cell in input["evidence"]
        if cell["candidate_id"] == input["candidate_id"]
    }
    rows = []
    for task in input["task_ids"]:
        for repetition in range(input["repetitions"]):
            cell = cells.get((task, repetition))
            values = {item["id"]: item for item in (cell or {}).get("assertions") or []}
            rows.append(
                {
                    "task_id": task,
                    "repetition": repetition,
                    "trial_status": cell["status"] if cell else None,
                    "values": [
                        {
                            **values[contract["id"]],
                            "evidenceRefs": list(values[contract["id"]]["evidenceRefs"]),
                        }
                        if contract["id"] in values
                        else {
                            "id": contract["id"],
                            "schemaDigest": contract["digest"],
                            "status": "missing",
                            "evidenceRefs": [],
                            "reason": "no independent assertion observation",
                        }
                        for contract in contracts
                    ],
                }
            )
    return rows
