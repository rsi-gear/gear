"""Paired fixed/random/failure retail study, with frozen weights and sealed final tests.

This is a concrete caller of collection, generation, pools and Project.refine.
Seeds schedule sampling and paired trials; the model API does not promise seeded inference.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import hashlib
import inspect
import json
import os
from pathlib import Path

from gear.canonical import digest
from gear.core import DeterministicRandom
from gear.search import PromptConstraints
from ifeval_experiment import read_json
from model_calls import TextCalls, token_usage
from sentinel_collect import RetailCollector
from sentinel_generate import RetailGenerator, freeze, implementation_identity
from sentinel_pool import build_pool
from sentinel_retail import load_backend
from sentinel_search import search

ARMS = ("fixed", "random", "failure")


def validate_config(config):
    required = {
        "schema_version",
        "training",
        "validation",
        "test",
        "seeds",
        "rounds",
        "harness",
        "model",
        "meta_model",
        "effort",
        "max_steps",
        "calls_per_task",
        "calls_per_generation",
        "calls_per_search",
        "fixed_count",
        "generated_count",
        "generation_attempts",
        "random_targets",
        "max_characters",
        "target_characters",
        "max_repairs",
    }
    if (
        set(config) - {"generator_model", "final_reply_on_limit"} != required
        or type(config["schema_version"]) is not int
        or config["schema_version"] != 1
    ):
        raise ValueError("retail study requires the complete preregistered configuration")
    if any(
        not isinstance(config[key], str) or not config[key].strip()
        for key in ("harness", "model", "meta_model", "effort")
    ):
        raise ValueError("retail study requires explicit nonempty model and harness settings")
    if type(config.get("final_reply_on_limit", False)) is not bool:
        raise ValueError("final_reply_on_limit must be an explicit boolean")
    if (
        not isinstance(config.get("generator_model", config["model"]), str)
        or not config.get("generator_model", config["model"]).strip()
    ):
        raise ValueError("generator_model must be a nonempty model name")
    bounds = {
        "rounds": 8,
        "max_steps": 64,
        "calls_per_task": 256,
        "calls_per_generation": 256,
        "calls_per_search": 65536,
        "fixed_count": 128,
        "generated_count": 128,
        "generation_attempts": 128,
    }
    if any(type(config[key]) is not int or not 1 <= config[key] <= n for key, n in bounds.items()):
        raise ValueError("retail study requires positive bounded rounds, quotas and pool counts")
    if config["generation_attempts"] < config["generated_count"]:
        raise ValueError("generation attempt quota cannot be smaller than the requested pool")
    seeds = config["seeds"]
    if (
        not isinstance(seeds, list)
        or not 1 <= len(seeds) <= 32
        or any(type(value) not in (int, str) or not str(value).strip() for value in seeds)
        or len({str(value) for value in seeds}) != len(seeds)
    ):
        raise ValueError("retail study requires distinct explicit scheduling seeds")
    targets = config["random_targets"]
    if (
        not isinstance(targets, list)
        or not 1 <= len(targets) <= 128
        or any(not isinstance(value, str) or not value.strip() for value in targets)
        or len(set(targets)) != len(targets)
    ):
        raise ValueError("random targets must be a distinct predeclared domain inventory")
    training = config["training"]
    if set(training) != {"family", "database", "user_id", "fixed"}:
        raise ValueError("training requires an explicit domain and fixed task inventory")
    count = config["fixed_count"] + config["generated_count"]
    if not isinstance(training["fixed"], list) or not count <= len(training["fixed"]) <= 128:
        raise ValueError("fixed arm requires enough distinct original tasks for an equal size pool")
    if (
        type(config["target_characters"]) is not int
        or type(config["max_repairs"]) is not int
        or not 0 < config["target_characters"] < config["max_characters"]
        or not 0 <= config["max_repairs"] <= 8
    ):
        raise ValueError("retail study requires explicit prompt constraints and bounded repair")
    PromptConstraints(config["max_characters"]).describe()
    return json.loads(json.dumps(config, allow_nan=False))


def aggregate(rows):
    """Unknown outcomes stay unknown, including the aggregate pass rate."""
    count = len(rows)
    complete = sum(row["complete"] for row in rows)
    passed = sum(row["passed"] is True for row in rows)
    return {
        "tasks": count,
        "complete": complete,
        "passed": passed,
        "unknown": count - complete,
        "pass_rate": passed / count if count and complete == count else None,
    }


class RetailStudy:
    def __init__(self, root, source_root, config, *, calls_factory=TextCalls, provider_script=None):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.source_root = Path(source_root).resolve()
        self.config = validate_config(config)
        self.calls_factory = calls_factory
        self.provider_script = Path(
            provider_script or Path(__file__).with_name("sentinel_provider.py")
        ).resolve()
        factory_file = inspect.getsourcefile(calls_factory)
        repository = Path(__file__).resolve().parents[2]
        search_sources = (
            list((repository / "python/gear/algorithms").glob("*.py"))
            + list((repository / "python/gear/search").glob("*.py"))
            + list((repository / "lib").rglob("*.js"))
            + [Path(__file__).with_name("formal_provider.py")]
        )
        self.identity = {
            "config": self.config,
            "backend": load_backend(source_root)["identity"],
            "implementation": implementation_identity(),
            "search_implementation": {
                str(path.relative_to(repository)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted(search_sources)
            },
            "model_calls": {
                "module": calls_factory.__module__,
                "name": calls_factory.__qualname__,
                "source": hashlib.sha256(Path(factory_file).read_bytes()).hexdigest()
                if factory_file
                else None,
                "fixture": calls_factory is not TextCalls,
            },
            "provider": {
                "path": str(self.provider_script),
                "digest": hashlib.sha256(self.provider_script.read_bytes()).hexdigest(),
            },
            "profiles": str(Path(os.environ["GEAR_PROFILE_ROOT"]).resolve()),
        }
        freeze(self.root / "input.json", self.identity)

    def pool_config(self, seed, *, generated=(), fixed_only=False):
        c = self.config
        return {
            "schema_version": 1,
            "partition": "train",
            **c["training"],
            "seed": str(seed),
            "generated": list(generated),
            "fixed_count": c["fixed_count"] + (c["generated_count"] if fixed_only else 0),
            "generated_count": 0 if fixed_only else c["generated_count"],
        }

    def search_config(self, pool_root, harness):
        c = self.config
        return {
            "schema_version": 1,
            "pool_workspace": str(pool_root),
            "harness": harness,
            **{
                key: c[key]
                for key in (
                    "validation",
                    "test",
                    "model",
                    "meta_model",
                    "effort",
                    "max_steps",
                    "max_characters",
                    "target_characters",
                    "max_repairs",
                )
            },
            "max_calls": c["calls_per_search"],
            **(
                {"final_reply_on_limit": c["final_reply_on_limit"]}
                if "final_reply_on_limit" in c
                else {}
            ),
        }

    async def collect(self, seed, round_index, bundle, harness):
        c = self.config
        # Identical harnesses within one paired trial share the exact observation.
        key = digest([str(seed), round_index, bundle, harness]).removeprefix("sha256:")
        root = self.root / "observations" / key
        config = {
            "schema_version": 1,
            **{
                name: bundle[name]
                for name in (
                    "partition",
                    "family",
                    "database",
                    "user_id",
                    "task",
                    "reference",
                )
            },
            **{name: c[name] for name in ("model", "effort", "max_steps")},
            "harness": harness,
            "max_calls": c["calls_per_task"],
            "sample_id": key,
            "attempt": 0,
            **(
                {"final_reply_on_limit": c["final_reply_on_limit"]}
                if "final_reply_on_limit" in c
                else {}
            ),
        }
        async with self.calls_factory(
            root / "calls", max_calls=c["calls_per_task"], concurrency=1
        ) as calls:
            result = await RetailCollector(root, self.source_root, config, calls).collect()
        return {
            "workspace": str(root),
            "result_digest": digest(result),
            "observation": result["observation"],
        }

    async def generate(self, root, seed, arm, observations):
        c = self.config
        config = {
            "schema_version": 1,
            "partition": "train",
            **{key: c["training"][key] for key in ("family", "database", "user_id")},
            **{key: c[key] for key in ("effort", "max_steps")},
            "model": c.get("generator_model", c["model"]),
            **(
                {"final_reply_on_limit": c["final_reply_on_limit"]}
                if "final_reply_on_limit" in c
                else {}
            ),
            "max_calls": c["calls_per_generation"],
            "max_cases": 128,
            "seed": seed,
            "conditioning": arm,
            "observations": observations if arm == "failure" else [],
            **({"random_targets": c["random_targets"]} if arm == "random" else {}),
        }
        async with self.calls_factory(
            root / "calls", max_calls=c["calls_per_generation"], concurrency=1
        ) as calls:
            result = await RetailGenerator(root, self.source_root, config, calls).generate()
        return {
            "workspace": str(root),
            "status": result["status"],
            "result_digest": digest(result),
            "model_usage": result["model_usage"],
        }

    async def run(self, *, preflight=False):
        with (self.root / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return await self._run(preflight)

    async def _run(self, preflight):
        c = self.config
        # Before any model turn, native calibration and search admission check ALL
        # original tasks and both private partitions, including overlap/family rules.
        pool_root = self.root / "preflight/pool"
        all_fixed = self.pool_config("preflight", fixed_only=True)
        all_fixed["fixed_count"] = len(c["training"]["fixed"])
        await build_pool(pool_root, self.source_root, all_fixed)
        await search(
            self.root / "preflight/search",
            self.source_root,
            self.search_config(pool_root, c["harness"]),
            provider_script=self.provider_script,
            preflight=True,
        )
        if preflight:
            return {"status": "preflight", "model_calls": 0, "test_opened": False}
        decisions, selections = [], []
        fixed = [
            {
                "partition": "train",
                **{k: c["training"][k] for k in ("family", "database", "user_id")},
                **row,
            }
            for row in c["training"]["fixed"]
        ]
        for seed in c["seeds"]:
            seed_root = self.root / "trials" / digest(str(seed)).removeprefix("sha256:")
            rng = DeterministicRandom(str(seed))
            arm_order = sorted(ARMS, key=lambda arm: (rng.value("arm-order-" + arm, 0), arm))
            for arm in arm_order:
                harness = c["harness"]
                eligible = True
                for index in range(c["rounds"]):
                    root = seed_root / arm / str(index)
                    # Fixed and random arms collect the same training probes. Their
                    # generation never receives these observations or their failures.
                    source = [await self.collect(seed, index, row, harness) for row in fixed]
                    freeze(root / "sources.json", source)
                    attempts = []
                    if arm != "fixed":
                        for attempt in range(c["generation_attempts"]):
                            attempts.append(
                                await self.generate(
                                    root / "generation" / str(attempt),
                                    f"{seed}/{index}/{attempt}",
                                    arm,
                                    [row["observation"] for row in source],
                                )
                            )
                    generated = [row["workspace"] for row in attempts if row["status"] == "ready"]
                    pool_root = root / "pool"
                    pool = await build_pool(
                        pool_root,
                        self.source_root,
                        self.pool_config(
                            f"{seed}/{index}", generated=generated, fixed_only=arm == "fixed"
                        ),
                    )
                    searched = None
                    if pool["status"] == "ready":
                        searched = await search(
                            root / "search",
                            self.source_root,
                            self.search_config(pool_root, harness),
                            provider_script=self.provider_script,
                        )
                        harness = searched["harness"]
                        if searched["status"] != "completed":
                            eligible = False
                    else:
                        eligible = False
                    decision = {
                        "seed": seed,
                        "arm": arm,
                        "round": index,
                        "arm_order": arm_order,
                        "source_digest": digest(source),
                        "attempts": attempts,
                        "pool_status": pool["status"],
                        "pool_digest": digest(pool),
                        "search": searched,
                        "harness": harness,
                    }
                    freeze(root / "decision.json", decision)
                    decisions.append(decision)
                    print(
                        json.dumps(
                            {
                                "phase": "search",
                                "seed": seed,
                                "arm": arm,
                                "round": index,
                                "pool": pool["status"],
                            }
                        ),
                        flush=True,
                    )
                selections.append(
                    {"seed": seed, "arm": arm, "harness": harness, "eligible": eligible}
                )
            selections.append(
                {"seed": seed, "arm": "baseline", "harness": c["harness"], "eligible": True}
            )
        selections.sort(
            key=lambda row: (
                c["seeds"].index(row["seed"]),
                DeterministicRandom(str(row["seed"])).value("test-order-" + row["arm"], 0),
                row["arm"],
            )
        )
        # The same final test is opened only after every trial has finished selection.
        seal = freeze(
            self.root / "test-admission.json",
            {
                "study_digest": digest(self.identity),
                "decisions_digest": digest(decisions),
                "selections": selections,
                "test_digest": digest(c["test"]),
            },
        )
        evaluations = []
        for selected in selections:
            rows = [
                await self.collect(selected["seed"], "final-test", bundle, selected["harness"])
                for bundle in c["test"]
            ]
            records = [row["observation"]["record"] for row in rows]
            if any(row["partition"] != "test" for row in records):
                raise ValueError("final test observation lost its private partition")
            evaluations.append(
                {
                    **selected,
                    "harness_digest": digest(selected["harness"]),
                    "rows": rows,
                    "metrics": aggregate(records),
                }
            )
        rates = {
            arm: [row["metrics"]["pass_rate"] for row in evaluations if row["arm"] == arm]
            for arm in (*ARMS, "baseline")
        }
        complete = all(rate is not None for values in rates.values() for rate in values)
        comparable = complete and all(row["eligible"] for row in selections)
        means = {
            arm: sum(values) / len(values) if all(value is not None for value in values) else None
            for arm, values in rates.items()
        }
        differences = (
            {
                arm: [
                    failure - control
                    for failure, control in zip(rates["failure"], rates[arm], strict=True)
                ]
                for arm in ("fixed", "random")
            }
            if comparable
            else None
        )
        # Native stores include source, generation, Meta and target turns, counted
        # once even when several arms reuse an identical policy observation.
        native_paths = list(self.root.glob("**/calls/*/result.json"))
        receipts = [read_json(path)["receipt"] for path in native_paths]
        fixture = self.identity["model_calls"]["fixture"]
        submitted = len(list(self.root.glob("**/calls/*/pending.json")))
        ceiling = len(c["seeds"]) * (
            c["rounds"]
            * (
                3 * len(fixed) * c["calls_per_task"]
                + 2 * c["generation_attempts"] * c["calls_per_generation"]
                + 3 * c["calls_per_search"]
            )
            + 4 * len(c["test"]) * c["calls_per_task"]
        )
        return freeze(
            self.root / "result.json",
            {
                "schema_version": 1,
                "status": "completed",
                "comparable": comparable,
                "test_admission_digest": digest(seal),
                "decisions": decisions,
                "evaluations": evaluations,
                "mean_pass_rate": means,
                "paired_failure_minus_control": differences,
                "no_gpu_training": True,
                "model_seed_control": False,
                "model_fixture": fixture,
                "generation_failures_are_not_replaced": True,
                "usage": {
                    "completed_native_receipts": len(receipts),
                    "submitted_native_turns": submitted,
                    "tokens": token_usage(receipts).get("tokens") if not fixture else None,
                    "configured_logical_turn_ceiling": ceiling,
                    "complete_native_accounting": not fixture and submitted == len(receipts),
                },
                "inference": "Descriptive paired trials; no claim of statistical significance or generalization.",
            },
        )


def main():
    parser = argparse.ArgumentParser(
        description="Compare fixed/random/failure retail practice without GPU training"
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    os.environ.setdefault("GEAR_PROFILE_ROOT", str(args.workspace.resolve() / "profiles"))
    result = asyncio.run(
        RetailStudy(args.workspace, args.tau2_source, read_json(args.input)).run(
            preflight=args.preflight
        )
    )
    print(
        json.dumps(
            {
                key: result[key]
                for key in ("status", "comparable", "mean_pass_rate")
                if key in result
            }
        )
    )


if __name__ == "__main__":
    main()
