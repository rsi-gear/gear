"""Shared workspace runner. Training validation belongs to stages, never runners."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from .content import atomic_json


@dataclass(frozen=True)
class AgentRequest:
    workspace: Path
    instructions: str
    timeout_seconds: int
    recovery_id: str | None = None


@dataclass(frozen=True)
class AgentResult:
    status: str
    artifacts: list[str] = field(default_factory=list)
    log: str = ""
    recovery_id: str | None = None


class AgentRunner(Protocol):
    async def run(self, request: AgentRequest) -> AgentResult: ...


class CodexRunner:
    """Official optional Python SDK. No subprocess CLI approximation or token claims."""
    def __init__(self, model: str, effort: str = "high", *, client_factory=None):
        self.model, self.effort, self.client_factory = model, effort, client_factory

    async def run(self, request):
        from openai_codex import AsyncCodex, Sandbox, ApprovalMode
        factory = self.client_factory or AsyncCodex
        async with factory() as codex:
            options = dict(cwd=str(request.workspace), model=self.model, sandbox=Sandbox.workspace_write,
                           approval_mode=ApprovalMode.deny_all)
            thread = (await codex.thread_resume(request.recovery_id, **options) if request.recovery_id
                      else await codex.thread_start(**options))
            # Persist before inference: an interrupted caller can resume this thread.
            atomic_json(request.workspace / "runner.json", {"recoveryId": thread.id})
            try:
                result = await asyncio.wait_for(thread.run(request.instructions, effort=self.effort), request.timeout_seconds)
            except asyncio.TimeoutError:
                return AgentResult("infra-error", log="Codex turn exceeded the stage timeout", recovery_id=thread.id)
            status = getattr(result.status, "value", result.status)
            artifacts = [str(p.relative_to(request.workspace)) for p in sorted((request.workspace / "outputs").rglob("*")) if p.is_file()]
            return AgentResult("completed" if status == "completed" else "infra-error", artifacts,
                               result.final_response or "", thread.id)


def configured_runner(config):
    """Operator-controlled adapter hook; stage agents cannot choose executable code.

    Additional providers implement AgentRunner and are installed/configured on
    the controller, without changing any training contract or stage code.
    """
    import importlib
    import os
    from .content import require
    factory = os.environ.get("GEAR_AGENT_RUNNER_FACTORY")
    if factory:
        module, separator, name = factory.partition(":")
        require(separator and module and name, "invalid-runner-factory", "runner factory must be module:callable")
        return getattr(importlib.import_module(module), name)(config["runner"], config.get("options", {}))
    require(config.get("runner") == "codex", "unsupported-agent-runner", "configure GEAR_AGENT_RUNNER_FACTORY for another installed provider")
    options = config.get("options", {})
    require(isinstance(options.get("model"), str) and options["model"], "invalid-codex-options", "Codex requires an explicit model")
    return CodexRunner(options["model"], options.get("effort", "high"))
