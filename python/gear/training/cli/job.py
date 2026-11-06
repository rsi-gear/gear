"""Command-line entrypoint; service behavior lives in the implementation package."""

import argparse
import json
import sys

from gear.training.runtime.job import JobService, driver, worker
from gear.training.runtime.preflight import preflight
from gear.training.storage.content import require
from gear.training.storage.state import load


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=(
            "preflight",
            "submit",
            "inspect",
            "cancel",
            "collect",
            "_worker",
            "_driver",
        ),
    )
    parser.add_argument("--config")
    parser.add_argument("--job-dir")
    parser.add_argument("--incarnation")
    args = parser.parse_args()
    if args.action == "_worker":
        worker(args.job_dir, args.incarnation)
        return
    if args.action == "_driver":
        driver(args.job_dir, args.incarnation)
        return
    try:
        require(args.config, "missing-config", "job RPC requires --config")
        service = JobService(load(args.config))
        payload = json.load(sys.stdin)
        if args.action == "preflight":
            result = preflight(payload["request"], service.config)
        elif args.action == "submit":
            result = service.submit(payload["request"], payload["idempotencyKey"])
        else:
            result = getattr(service, args.action)(payload["handle"])
        print(json.dumps(result, allow_nan=False, separators=(",", ":")))
    except Exception as error:
        print(
            json.dumps(
                {
                    "error": {
                        "code": getattr(error, "code", "training-job-error"),
                        "message": str(error),
                    }
                },
                allow_nan=False,
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
