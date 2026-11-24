"""Run the DiagEvo caller with an explicit frozen plan and controller configuration."""

from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import time
from pathlib import Path

from gear.training.cli.controller import controller_command
from gear.training.recipes.diagevo_run import evolve
from gear.training.storage.content import ContentStore


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m gear.training diagevo", description=__doc__)
    parser.add_argument("action", choices=("run", "advance", "status", "pause", "resume"))
    parser.add_argument("plan", type=Path)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--gear-command", help="optional controller command as a JSON argv array")
    parser.add_argument("--poll-seconds", type=float, default=2)
    args = parser.parse_args(argv)
    if not 0.1 <= args.poll_seconds <= 30:
        parser.error("--poll-seconds must be between 0.1 and 30")
    interrupted = False

    def stop(_number, _frame):
        nonlocal interrupted
        interrupted = True

    previous = {}
    try:
        config = json.loads(args.config.read_text())
        options = {
            "plan": json.loads(args.plan.read_text()),
            "controller_config": args.config,
            "gear_command": controller_command(args.gear_command),
            "hitch_command": config["hitch"]["command"],
        }
        store = ContentStore(config["storeRoot"])
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, stop)
        action = "advance" if args.action == "run" else args.action
        last_progress = None
        while True:
            result = evolve(
                store, args.directory, **options, action="pause" if interrupted else action
            )
            progress = (result["status"], result["roundsCompleted"], len(result["jobs"]))
            if progress != last_progress:
                print(
                    json.dumps(
                        {"status": progress[0], "roundsCompleted": progress[1], "jobs": progress[2]}
                    ),
                    file=sys.stderr,
                )
                last_progress = progress
            if interrupted and result["status"] not in ("completed", "stopped", "paused"):
                action = "pause"
            elif args.action in ("advance", "status") or result["status"] not in (
                "running",
                "pausing",
            ):
                print(json.dumps(result, ensure_ascii=False))
                return 1 if result["status"] == "needs-attention" else 0
            else:
                action = "pause" if args.action == "pause" else "advance"
            time.sleep(args.poll_seconds)
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        if interrupted:
            try:
                result = evolve(store, args.directory, **options, action="pause")
                print(json.dumps(result, ensure_ascii=False))
            except (ValueError, OSError, KeyError, subprocess.SubprocessError) as cleanup_error:
                print(f"DiagEvo pause reconciliation is pending: {cleanup_error}", file=sys.stderr)
        print(
            f"DiagEvo: {error}. Reuse the same --directory to reconcile the existing jobs.",
            file=sys.stderr,
        )
        return 1
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
