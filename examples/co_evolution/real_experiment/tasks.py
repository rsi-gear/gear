"""Verifiable instruction tasks for real co-evolution experiments.

Graders are exact / regex. Families are disjoint across train/seed/held_out
by task id; content families may overlap in style but ids never cross splits.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

Grader = Callable[[str], bool]


def _extract_answer_tag(text: str) -> str | None:
    match = re.search(r"<answer>\s*(.*?)\s*</answer>", text, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    return match.group(1).strip()


def _extract_json_field(text: str, field: str) -> str | None:
    # Prefer fenced or raw JSON object containing the field.
    candidates = re.findall(r"\{[^{}]*\}", text, flags=re.DOTALL)
    for blob in candidates:
        try:
            payload = json.loads(blob)
        except json.JSONDecodeError:
            continue
        if field in payload:
            return str(payload[field]).strip()
    match = re.search(rf'"{field}"\s*:\s*"([^"]+)"', text)
    if match:
        return match.group(1).strip()
    match = re.search(rf'"{field}"\s*:\s*([0-9.\-]+)', text)
    if match:
        return match.group(1).strip()
    return None


def make_grader(spec: dict[str, Any]) -> Grader:
    kind = spec["type"]
    if kind == "answer_tag_exact":
        expected = str(spec["value"]).strip()

        def grade(text: str) -> bool:
            got = _extract_answer_tag(text)
            return got is not None and got == expected

        return grade
    if kind == "answer_tag_int":
        expected = int(spec["value"])

        def grade(text: str) -> bool:
            got = _extract_answer_tag(text)
            if got is None:
                return False
            try:
                return int(got.strip()) == expected
            except ValueError:
                return False

        return grade
    if kind == "json_field_exact":
        field = spec["field"]
        expected = str(spec["value"]).strip()

        def grade(text: str) -> bool:
            got = _extract_json_field(text, field)
            return got is not None and got == expected

        return grade
    if kind == "regex_full":
        pattern = re.compile(spec["pattern"], flags=re.IGNORECASE | re.DOTALL)

        def grade(text: str) -> bool:
            return pattern.fullmatch(text.strip()) is not None

        return grade
    raise ValueError(f"unknown grader type: {kind}")


def _math_tag(a: int, b: int, op: str) -> dict[str, Any]:
    if op == "+":
        value = a + b
        prompt = f"Compute {a} + {b}."
    elif op == "-":
        value = a - b
        prompt = f"Compute {a} - {b}."
    elif op == "*":
        value = a * b
        prompt = f"Compute {a} * {b}."
    else:
        raise ValueError(op)
    return {
        "user": (
            f"{prompt} Put the final integer inside <answer>...</answer> and nothing else "
            "outside that tag."
        ),
        "grader": {"type": "answer_tag_int", "value": value},
        "family": "math_tag",
        "target": str(value),
    }


def _sentiment_json(text: str, label: str) -> dict[str, Any]:
    return {
        "user": (
            f'Classify the sentiment of this sentence as positive, negative, or neutral.\n'
            f'Sentence: "{text}"\n'
            'Respond with JSON only: {"label":"..."}'
        ),
        "grader": {"type": "json_field_exact", "field": "label", "value": label},
        "family": "sentiment_json",
        "target": label,
    }


def _entity_tag(sentence: str, entity: str) -> dict[str, Any]:
    return {
        "user": (
            f"Extract the person name from: {sentence}\n"
            "Return only <answer>NAME</answer>."
        ),
        "grader": {"type": "answer_tag_exact", "value": entity},
        "family": "entity_tag",
        "target": entity,
    }


def _route_tool(query: str, tool: str) -> dict[str, Any]:
    return {
        "user": (
            "Choose exactly one tool for the query.\n"
            "Tools: search, calculator, calendar.\n"
            f"Query: {query}\n"
            'Respond with JSON only: {"tool":"..."}'
        ),
        "grader": {"type": "json_field_exact", "field": "tool", "value": tool},
        "family": "tool_route",
        "target": tool,
    }


def build_task_bank() -> dict[str, list[dict[str, Any]]]:
    train = []
    seed = []
    held = []

    train_math = [(12, 7, "+"), (19, 4, "+"), (8, 3, "*"), (15, 6, "-"), (9, 9, "*"), (21, 8, "+"), (14, 5, "-"), (6, 7, "*")]
    seed_math = [(11, 9, "+"), (18, 5, "-"), (7, 8, "*"), (13, 6, "+")]
    held_math = [(16, 9, "+"), (22, 7, "-"), (5, 12, "*"), (17, 8, "+"), (10, 11, "-")]

    for index, (a, b, op) in enumerate(train_math):
        item = _math_tag(a, b, op)
        train.append({"id": f"train_math_{index}", "split": "train", **item})
    for index, (a, b, op) in enumerate(seed_math):
        item = _math_tag(a, b, op)
        seed.append({"id": f"seed_math_{index}", "split": "seed", **item})
    for index, (a, b, op) in enumerate(held_math):
        item = _math_tag(a, b, op)
        held.append({"id": f"held_math_{index}", "split": "held_out", **item})

    train_sent = [
        ("I love this product", "positive"),
        ("This is terrible service", "negative"),
        ("The box arrived today", "neutral"),
        ("Absolutely wonderful experience", "positive"),
        ("I hate waiting forever", "negative"),
        ("The meeting is at noon", "neutral"),
    ]
    seed_sent = [
        ("Great job on the release", "positive"),
        ("Awful quality and broken parts", "negative"),
        ("The document has three pages", "neutral"),
    ]
    held_sent = [
        ("Fantastic support from the team", "positive"),
        ("Disappointing and frustrating outcome", "negative"),
        ("The train leaves at 9", "neutral"),
        ("Best purchase I made this year", "positive"),
    ]
    for index, (text, label) in enumerate(train_sent):
        item = _sentiment_json(text, label)
        train.append({"id": f"train_sent_{index}", "split": "train", **item})
    for index, (text, label) in enumerate(seed_sent):
        item = _sentiment_json(text, label)
        seed.append({"id": f"seed_sent_{index}", "split": "seed", **item})
    for index, (text, label) in enumerate(held_sent):
        item = _sentiment_json(text, label)
        held.append({"id": f"held_sent_{index}", "split": "held_out", **item})

    train_ent = [
        ("Alice met Bob at the cafe.", "Alice"),
        ("Please call Jordan after lunch.", "Jordan"),
        ("Mia delivered the report early.", "Mia"),
        ("Ask Priya about the budget.", "Priya"),
    ]
    seed_ent = [
        ("Chen signed the contract yesterday.", "Chen"),
        ("Noah fixed the printer.", "Noah"),
    ]
    held_ent = [
        ("Olivia reviewed the pull request.", "Olivia"),
        ("Sam scheduled the interview.", "Sam"),
        ("Elena approved the design.", "Elena"),
    ]
    for index, (sentence, entity) in enumerate(train_ent):
        item = _entity_tag(sentence, entity)
        train.append({"id": f"train_ent_{index}", "split": "train", **item})
    for index, (sentence, entity) in enumerate(seed_ent):
        item = _entity_tag(sentence, entity)
        seed.append({"id": f"seed_ent_{index}", "split": "seed", **item})
    for index, (sentence, entity) in enumerate(held_ent):
        item = _entity_tag(sentence, entity)
        held.append({"id": f"held_ent_{index}", "split": "held_out", **item})

    train_route = [
        ("What is 45*12?", "calculator"),
        ("Find restaurants near me", "search"),
        ("When is my next meeting?", "calendar"),
        ("sqrt of 144", "calculator"),
        ("Look up Python dataclasses", "search"),
        ("Add lunch with Alex on Friday", "calendar"),
    ]
    seed_route = [
        ("Compute 9**3", "calculator"),
        ("Search for mlx documentation", "search"),
        ("Show events tomorrow morning", "calendar"),
    ]
    held_route = [
        ("Calculate 128/4", "calculator"),
        ("Find papers about LoRA", "search"),
        ("Book a slot next Tuesday", "calendar"),
        ("What is 19+23?", "calculator"),
    ]
    for index, (query, tool) in enumerate(train_route):
        item = _route_tool(query, tool)
        train.append({"id": f"train_route_{index}", "split": "train", **item})
    for index, (query, tool) in enumerate(seed_route):
        item = _route_tool(query, tool)
        seed.append({"id": f"seed_route_{index}", "split": "seed", **item})
    for index, (query, tool) in enumerate(held_route):
        item = _route_tool(query, tool)
        held.append({"id": f"held_route_{index}", "split": "held_out", **item})

    return {"train": train, "seed": seed, "held_out": held}


BASE_HARNESS = {
    "id": "base",
    "version": 0,
    "system": (
        "You are a careful assistant. Follow the user instructions exactly. "
        "Prefer short answers that match the requested format."
    ),
}

HARNESS_CANDIDATES = [
    {
        "id": "format_strict",
        "system": (
            "You must obey output formats exactly. "
            "If asked for <answer> tags, output only that tag. "
            "If asked for JSON, output only a single JSON object. No preamble."
        ),
    },
    {
        "id": "format_strict_v2",
        "system": (
            "Formatting is mandatory. Never add explanations. "
            "Use <answer>...</answer> when requested. "
            "Use compact JSON when requested. Incorrect format counts as failure."
        ),
    },
    {
        "id": "math_helper",
        "system": (
            "For arithmetic, compute carefully then place only the integer in <answer>. "
            "For JSON tasks, return only JSON. Do not show steps."
        ),
    },
    {
        "id": "router_focus",
        "system": (
            "When choosing tools: calculator for numeric computation, "
            "search for lookup, calendar for scheduling. "
            "Always match the requested schema exactly."
        ),
    },
    {
        "id": "mixed_protocol",
        "system": (
            "Protocol: (1) detect required schema from the user message, "
            "(2) produce only that schema, (3) never mix prose with structured output."
        ),
    },
]


def save_task_bank(path: Path) -> dict[str, list[dict[str, Any]]]:
    bank = build_task_bank()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(bank, indent=2) + "\n", encoding="utf-8")
    return bank


def load_task_bank(path: Path | None = None) -> dict[str, list[dict[str, Any]]]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return build_task_bank()
