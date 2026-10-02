"""Controller-side entry for the fixed-task dev GRPO four-stage recipe."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import subprocess
import tempfile


def prepare_spec(value):
    """Keep the real deployment/model/data refs; select the worker recipe only."""
    value = json.loads(json.dumps(value))
    if not isinstance(value, dict) or not isinstance(value.get("trainer"), dict):
        raise ValueError("expected an existing Gear model-training spec with trainer settings")
    if value.get("stages"):
        raise ValueError("dev_grpo uses the original fixed task source and strict GRPO builder; remove agent stages")
    if "pipeline" in value["trainer"]:
        raise ValueError("replace trainer.pipeline with a script entrypoint")
    if value["trainer"].get("script") or value.get("scriptSource"):
        raise ValueError("use training run directly for an already selected script")
    value["scriptSource"] = {"directory": str(Path(__file__).parent / "recipes" / "dev_script"),
                             "entrypoint": "recipe:build_loop"}
    return value


def _follow(command):
    # Keep stdout/stderr and progress visible. Forward termination so the
    # controller can pause the job and persist its last native checkpoint.
    child = subprocess.Popen(command, start_new_session=True)
    previous = {}
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, lambda number, frame: child.send_signal(number) if child.poll() is None else None)
        return child.wait()
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run the original dev GRPO workflow as four Python stages.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--spec", type=Path, help="existing dev training spec; starts a new experiment")
    source.add_argument("--experiment", help="existing four-stage experiment ID")
    parser.add_argument("--run", help="existing run ID, required with --experiment")
    parser.add_argument("--resume", action="store_true", help="explicitly resume a paused/interrupted existing run")
    parser.add_argument("--config", required=True, type=Path, help="existing Gear controller configuration")
    parser.add_argument("--gear-command", default='["gear-refine"]', help='CLI argv as JSON, e.g. ["node", "lib/cli.js"]')
    args = parser.parse_args(argv)
    if bool(args.experiment) != bool(args.run) or (args.resume and not args.experiment):
        parser.error("--experiment and --run must be supplied together; --resume requires both")
    try:
        command = json.loads(args.gear_command)
        if not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
            raise ValueError()
    except (ValueError, TypeError):
        parser.error("--gear-command must be a nonempty JSON array of command arguments")
    config = ["--config", str(args.config.resolve())]
    if args.experiment:
        # Inspect the frozen spec before following a run, so a mistyped ID
        # cannot silently launch the legacy training path.
        result = subprocess.run(command + ["training", "status", args.experiment] + config,
                                check=True, stdout=subprocess.PIPE, text=True)
        experiment = json.loads(result.stdout)
        if not experiment["spec"]["trainer"].get("script") or experiment["spec"].get("stages"):
            parser.error("existing experiment is not the fixed-task four-stage dev recipe")
        ids = [args.experiment, args.run]
        if args.resume:
            subprocess.run(command + ["training", "resume"] + ids + config, check=True)
        return _follow(command + ["training", "run"] + ids + config)
    try:
        spec = prepare_spec(json.loads(args.spec.read_text()))
    except (ValueError, OSError) as error:
        parser.error(str(error))
    with tempfile.TemporaryDirectory(prefix="gear-dev-grpo-") as directory:
        frozen = Path(directory) / "spec.json"
        frozen.write_text(json.dumps(spec, ensure_ascii=False))
        return _follow(command + ["training", "run", str(frozen)] + config)
