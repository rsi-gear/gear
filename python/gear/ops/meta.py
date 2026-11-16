"""Model calls are data. Prompts and output semantics remain Python-owned."""

from __future__ import annotations

from dataclasses import dataclass

from gear.canonical import JSON

from ._json import json_object
from .base import Module
from .calls import ArtifactRef, Call, CandidateRef, checked_name


@dataclass(frozen=True)
class MetaInput:
    candidate: CandidateRef
    task_ids: tuple[str, ...]
    sources: tuple[CandidateRef | ArtifactRef, ...] = ()
    data: JSON = None


class Meta(Module):
    def __init__(self, prompt: str, schema: dict[str, JSON], *, max_tokens: int | None = None):
        self.prompt = prompt
        self.schema = schema
        self.max_tokens = max_tokens

    def __call__(self, value: MetaInput, *, key: str) -> Call[JSON]:
        if not isinstance(self.prompt, str) or not self.prompt.strip():
            raise ValueError("Meta requires nonempty instructions")
        if self.max_tokens is not None and (
            type(self.max_tokens) is not int or self.max_tokens < 1
        ):
            raise ValueError("max_tokens must be positive")
        if not value.task_ids or len(set(value.task_ids)) != len(value.task_ids):
            raise ValueError("Meta requires an explicit task scope")
        for task in value.task_ids:
            checked_name(task)
        return Call(
            key,
            self.operator_ref,
            {
                "kind": "meta",
                "input": {
                    **json_object(value),
                    "prompt": self.prompt,
                    "schema": json_object(self.schema),
                    "max_tokens": self.max_tokens,
                },
            },
            self.schema,
        )

    def requirements(self) -> tuple[str, ...]:
        return ("meta", "artifact_read")
