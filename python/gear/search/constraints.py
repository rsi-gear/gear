"""Pure constraints on proposed prompt text; no generation or implicit repair."""

from gear.core import Module
from gear.search.screening import ScreenVerdict


class PromptConstraints(Module):
    def __init__(self, max_characters: int = 1800):
        if type(max_characters) is not int or max_characters < 1:
            raise ValueError("max_characters must be a positive integer")
        self.max_characters = max_characters

    def __call__(self, text: str) -> ScreenVerdict:
        if not isinstance(text, str) or not text.strip():
            return ScreenVerdict("reject", "prompt must contain nonempty text")
        if "\x00" in text:
            return ScreenVerdict("reject", "prompt contains a NUL character")
        if len(text) > self.max_characters:
            return ScreenVerdict(
                "reject", f"prompt has {len(text)} characters; maximum is {self.max_characters}"
            )
        return ScreenVerdict("allow", "prompt constraints passed")
