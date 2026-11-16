"""DarwinX-style provisional acceptance followed by independent confirmation.

Uses the same prompt-search recipe with a fresh baseline and candidate sample
plan. This exercises confirmation semantics, not DarwinX's full branch search.
"""

from opro import PromptSearch


def algorithm():
    return PromptSearch(confirmation=True)
