"""Compatibility spelling for the unified Python training controller."""
import argparse
from .cli import main as controller_main, prepare_spec


def main(argv=None):
    parser = argparse.ArgumentParser(description="Alias of python -m gear_training")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--spec")
    source.add_argument("--experiment")
    parser.add_argument("--run")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--config", required=True)
    parser.add_argument("--gear-command")
    args = parser.parse_args(argv)
    if bool(args.experiment) != bool(args.run) or (args.resume and not args.experiment):
        parser.error("--experiment and --run must be supplied together; --resume requires both")
    targets = [args.spec] if args.spec else [args.experiment, args.run]
    forwarded = ["resume" if args.resume else "run", *targets, "--config", args.config]
    if args.gear_command is not None:
        forwarded += ["--gear-command", args.gear_command]
    return controller_main(forwarded)
