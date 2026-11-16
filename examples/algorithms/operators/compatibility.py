"""Keep GEPA/RandomSearch's existing six-policy protocols and fixed-slot behavior.

These remain protocol v1. New compositions explicitly opt into gear.search.Algorithm
and protocol v2; changing an old frozen run's protocol is not a migration.
"""

from gear.algorithms import GEPA, RandomSearch
from gear.search.testkit import toy_round


def check_compatibility():
    return {
        name: toy_round(recipe)
        for name, recipe in (
            ("GEPA", GEPA()),
            ("RandomSearch", RandomSearch()),
        )
    }
