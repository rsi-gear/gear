"""Prompt optimization with an independent fresh-sample confirmation."""

from gear.algorithms.opro import OPRO


class DarwinX(OPRO):
    default_confirmation = True
