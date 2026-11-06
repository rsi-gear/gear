"""Command-line entrypoint; service behavior lives in the implementation package."""

import argparse
import json
import sys

from gear.training.runtime.script_job import ScriptService, worker_run
from gear.training.storage.loop_journal import _read


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("control", "inspect", "_worker"))
    parser.add_argument("config_or_directory")
    parser.add_argument("token", nargs="?")
    args = parser.parse_args()
    if args.operation == "_worker":
        return worker_run(args.config_or_directory, args.token)
    service = ScriptService(_read(args.config_or_directory))
    print(json.dumps(getattr(service, args.operation)(json.load(sys.stdin))))


if __name__ == "__main__":
    main()
