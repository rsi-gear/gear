"""One Python controller entry for native and arbitrary four-stage scripts."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import signal
import subprocess
import tempfile


def prepare_spec(value, base_directory=None):
    value = copy.deepcopy(value)
    base = Path(base_directory or Path.cwd())
    if not isinstance(value, dict):
        raise ValueError("expected a training spec object")
    if value.get("kind") == "training-script":
        if not isinstance(value.get("source"), str) or not value["source"]:
            raise ValueError("training-script requires a source directory")
        value["source"] = str((base / value["source"]).resolve())
        return value
    if not isinstance(value.get("trainer"), dict):
        raise ValueError("expected a model-training spec with trainer settings")
    if value.get("stages") or "pipeline" in value["trainer"]:
        raise ValueError("four-stage scripts replace legacy stages and trainer.pipeline")
    if value.get("scriptSource") and value["trainer"].get("script"):
        raise ValueError("select scriptSource or trainer.script, not both")
    if value.get("scriptSource"):
        source = value["scriptSource"]
        if not isinstance(source, dict) or not isinstance(source.get("directory"), str) or not source["directory"]:
            raise ValueError("scriptSource requires a directory")
        source["directory"] = str((base / source["directory"]).resolve())
    elif not value["trainer"].get("script"):
        value["scriptSource"] = {"directory": str(Path(__file__).parent / "recipes/dev_script"),
                                 "entrypoint": "recipe:build_loop"}
    return value


def controller_command(raw=None):
    if raw is not None:
        command = json.loads(raw)
        if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
            raise ValueError("--gear-command must be a nonempty JSON argv array")
        return command
    local = Path(__file__).resolve().parents[2] / "lib/cli.js"
    return ["node", str(local)] if local.is_file() else ["gear-refine"]


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
    parser = argparse.ArgumentParser(description=__doc__, prog="python -m gear_training")
    parser.add_argument("action", choices=("run", "resume", "pause", "status", "validate"))
    parser.add_argument("targets", nargs="+", help="SPEC.json, SCRIPT_ID, or EXP_ID RUN_ID")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--gear-command", help="optional controller argv JSON; defaults to this checkout's built CLI or gear-refine")
    args = parser.parse_args(argv)
    if len(args.targets) > 2 or (args.action == "validate" and len(args.targets) != 1):
        parser.error("expected SPEC.json, SCRIPT_ID, or EXP_ID RUN_ID")
    if args.action in ("resume", "pause") and len(args.targets) == 1 and not args.targets[0].startswith("script_"):
        parser.error("native jobs require EXP_ID RUN_ID; script jobs require SCRIPT_ID")
    try:
        command = controller_command(args.gear_command) + ["training"]
        config = ["--config", str(args.config.resolve())]
        if args.action == "run" and len(args.targets) == 1 and not args.targets[0].startswith("script_"):
            source = Path(args.targets[0]).resolve()
            spec = prepare_spec(json.loads(source.read_text()), source.parent)
            with tempfile.TemporaryDirectory(prefix="gear-training-") as directory:
                frozen = Path(directory) / "spec.json"
                frozen.write_text(json.dumps(spec, ensure_ascii=False))
                return _follow(command + ["run", str(frozen)] + config)
        if args.action == "resume" and len(args.targets) == 2:
            subprocess.run(command + ["resume", *args.targets] + config, check=True)
            return _follow(command + ["run", *args.targets] + config)
        return _follow(command + [args.action, *args.targets] + config)
    except subprocess.CalledProcessError as error:
        return error.returncode
    except (ValueError, OSError) as error:
        parser.error(str(error))
