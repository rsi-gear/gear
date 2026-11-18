"""Stateless indexed randomness for any pure component."""

from typing import Protocol

from gear.canonical import digest


class RandomSource(Protocol):
    def value(self, key: str, index: int = 0) -> float: ...


class DeterministicRandom:
    def __init__(self, seed: str):
        self.seed = seed

    def value(self, key: str, index: int = 0) -> float:
        if not key or type(index) is not int or index < 0:
            raise ValueError("random draws require a named key and a nonnegative index")
        return int(digest([self.seed, key, index])[7:20], 16) / 2**52
