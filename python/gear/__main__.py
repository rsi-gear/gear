"""CPU-only author tools and a transparent bridge to the installed Gear runtime."""

import argparse
import json
import sys
from dataclasses import asdict


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m gear")
    commands = parser.add_subparsers(dest="command", required=True)
    algorithm = commands.add_parser("algorithm").add_subparsers(dest="action", required=True)
    test = algorithm.add_parser("test")
    test.add_argument("entrypoint", nargs="?", default="gepa")
    benchmark = commands.add_parser("benchmark").add_subparsers(dest="action", required=True)
    check = benchmark.add_parser("compile")
    check.add_argument("--root", required=True)
    benchmark.add_parser("score")
    benchmark.add_parser("import")
    benchmark.add_parser("images")
    benchmark.add_parser("seal-harbor")
    benchmark.add_parser("probe-plan")
    benchmark.add_parser("probe-result")
    harbor = benchmark.add_parser("harbor")
    harbor.add_argument("--output", required=True)
    commands.add_parser("training").add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.command == "algorithm":
            from gear.algorithms import GEPA, MetaHarness, RandomSearch
            from gear.algorithms.testkit import test_parent_policy, toy_round
            from gear.refine.worker import load_entrypoint

            if args.entrypoint in ("gepa", "random-search", "meta-harness"):
                algorithms = {
                    "gepa": GEPA,
                    "random-search": RandomSearch,
                    "meta-harness": MetaHarness,
                }
                result = toy_round(algorithms[args.entrypoint]())
            else:
                policy = load_entrypoint(args.entrypoint)
                result = {
                    "policy": test_parent_policy(policy),
                    "round": toy_round(GEPA(parent_policy=policy)),
                }
        elif args.command == "benchmark":
            from gear.benchmark import compile_benchmark, score_output

            value = json.load(sys.stdin)
            if args.action == "probe-plan":
                from gear.benchmark.probe import prepare_probe

                result = prepare_probe(**value)
            elif args.action == "probe-result":
                from gear.benchmark.probe import read_probe_case

                result = read_probe_case(**value)
            elif args.action == "images":
                from gear.benchmark.native import required_images

                result = required_images(**value)
            elif args.action == "import":
                from gear.benchmark.importer import prepare_import

                result = prepare_import(**value)
            elif args.action == "seal-harbor":
                from gear.benchmark.manifest import seal_harbor

                seal_harbor(**value)
                result = {"status": "sealed"}
            elif args.action == "harbor":
                from gear.benchmark.harbor import compile_harbor

                result = compile_harbor(destination=args.output, **value)
            elif args.action == "compile":
                result = compile_benchmark(args.root, value)
            else:
                result = asdict(score_output(**value))
        else:
            from gear.training.cli.controller import main as training_main

            return training_main(args.args)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        print(
            json.dumps(
                {
                    "code": "authoring-error",
                    "message": str(error),
                    "location": getattr(error, "location", None),
                }
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
