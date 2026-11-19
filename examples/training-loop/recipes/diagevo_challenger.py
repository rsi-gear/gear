"""Freeze this entrypoint with a declared objective and local HF solver snapshot."""

from gear.training.pipelines.diagevo_challenger import build_loop

__all__ = ["build_loop"]
