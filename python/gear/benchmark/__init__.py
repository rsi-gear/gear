"""Stable benchmark author entrypoints."""

from .compiler import BenchmarkError, compile_benchmark
from .scorers import Score, score_output

__all__ = ["BenchmarkError", "compile_benchmark", "Score", "score_output"]
