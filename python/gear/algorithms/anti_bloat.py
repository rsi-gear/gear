"""Anti-bloat candidate validation and dynamic workflow catalog contracts."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class WorkflowEntry:
    id: str
    trigger: str
    path: str
    summary: str
    helper: str | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> WorkflowEntry:
        if not isinstance(data.get("id"), str) or not data["id"].strip():
            raise ValueError("WorkflowEntry 'id' must be a non-empty string")
        if not isinstance(data.get("trigger"), str) or not data["trigger"].strip():
            raise ValueError("WorkflowEntry 'trigger' must be a non-empty string")
        if not isinstance(data.get("path"), str) or not data["path"].strip():
            raise ValueError("WorkflowEntry 'path' must be a non-empty string")
        if not isinstance(data.get("summary"), str) or not data["summary"].strip():
            raise ValueError("WorkflowEntry 'summary' must be a non-empty string")
        return cls(
            id=data["id"].strip(),
            trigger=data["trigger"].strip(),
            path=data["path"].strip(),
            summary=data["summary"].strip(),
            helper=str(data["helper"]).strip() if data.get("helper") else None,
        )


@dataclass(frozen=True)
class WorkflowCatalog:
    entries: tuple[WorkflowEntry, ...]

    @classmethod
    def parse_json(cls, text: str) -> WorkflowCatalog:
        parsed = json.loads(text)
        if not isinstance(parsed, list):
            raise ValueError("Workflow catalog root must be a JSON array")
        return cls(tuple(WorkflowEntry.from_dict(item) for item in parsed))

    def format_prompt_section(self) -> str:
        """Formats a compact system prompt section describing available on-demand procedures."""
        if not self.entries:
            return "No specialized on-demand workflows registered."
        lines = ["Available on-demand procedures (read with the read tool when relevant):"]
        for item in self.entries:
            helper_note = f" (Helper tool: {item.helper})" if item.helper else ""
            lines.append(
                f'- [{item.id}] Trigger: "{item.trigger}". {item.summary} [Path: {item.path}]{helper_note}'
            )
        return "\n".join(lines)


def validate_anti_bloat_candidate(
    candidate_or_diff: Mapping[str, Any] | Any,
    max_prompt_delta_bytes: int = 800,
) -> tuple[bool, str | None]:
    """
    Validates that candidate changes do not bloat system prompts directly.

    Substantive procedures must be structured as on-demand files in workflows/
    rather than monolithic prompt additions in plugins/policy.js.
    """
    diff = candidate_or_diff
    if hasattr(diff, "candidate_change"):
        diff = getattr(diff, "candidate_change")

    diff_map: dict[str, str] = {}
    if isinstance(diff, dict):
        files = diff.get("files")
        if isinstance(files, list):
            for f in files:
                if isinstance(f, dict):
                    path = f.get("path")
                    patch = f.get("patch")
                    if isinstance(path, str) and isinstance(patch, str):
                        diff_map[path] = patch
        else:
            for path, patch in diff.items():
                if isinstance(path, str) and isinstance(patch, str):
                    diff_map[path] = patch

    policy_additions_bytes = 0

    for path, patch in diff_map.items():
        if "plugins/policy.js" in path or "policy.js" in path or "systemPrompt" in path:
            for line in patch.splitlines():
                if line.startswith("+") and not line.startswith("+++"):
                    policy_additions_bytes += len(line[1:].strip().encode("utf-8"))

    if policy_additions_bytes > max_prompt_delta_bytes:
        return (
            False,
            f"Prompt bloat rejected: {policy_additions_bytes} bytes added to policy/prompt "
            f"(limit is {max_prompt_delta_bytes} bytes). "
            f"Modularize procedures into standalone files under workflows/ and register in catalog.",
        )

    return True, None
