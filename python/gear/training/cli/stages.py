"""Agent-stage subprocess CLI; orchestration and data builders have no CLI side effects."""

import asyncio
import json
from pathlib import Path

from gear.training.adapters.agent_stage import run_agent_stage
from gear.training.storage.content import ContentStore, atomic_json
from gear.training.storage.state import load


def main():
    import argparse
    import sys

    parser = argparse.ArgumentParser()
    parser.add_argument("--store-root", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--execution-root")
    parser.add_argument("--response-file")
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    response = Path(args.response_file) if args.response_file else None
    execution = Path(args.execution_root or args.workspace)
    if args.inspect:
        from gear.training.runtime.recovery import owned_alive

        owner = load(execution / "worker.json")
        print(json.dumps({"alive": bool(owner and owned_alive(owner))}))
        return
    if args.stop:
        atomic_json(execution / "cancel.json", {"cancelled": True})
        from gear.training.runtime.recovery import stop_owned

        owner = load(execution / "worker.json")
        if owner:
            import psutil

            from gear.training.runtime.recovery import owned_alive, process_identity

            if owned_alive(owner):
                descendants = [
                    process_identity(p.pid)
                    for p in psutil.Process(owner["pid"]).children(recursive=True)
                ]
                stop_owned([owner, *[p for p in descendants if p]])
        print(json.dumps({"stopped": True}))
        return
    payload = json.load(sys.stdin)
    if response:
        import os

        from gear.training.runtime.recovery import process_identity

        atomic_json(execution / "worker.json", process_identity(os.getpid()))
    try:
        result = asyncio.run(
            run_agent_stage(
                ContentStore(args.store_root),
                args.workspace,
                payload["stage"],
                payload["config"],
                payload["payload"],
                cancel_path=execution / "cancel.json",
            )
        )
        if response:
            atomic_json(response, {"outcome": "completed", "result": result})
        else:
            print(json.dumps(result))
    except Exception as error:
        if response:
            atomic_json(response, {"outcome": "infra-error", "message": str(error)})
        else:
            print(
                json.dumps(
                    {
                        "error": {
                            "code": getattr(error, "code", "stage-error"),
                            "message": str(error),
                        }
                    }
                )
            )
        sys.exit(1)


if __name__ == "__main__":
    main()
