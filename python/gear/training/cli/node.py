"""Command-line entrypoint; service behavior lives in the implementation package."""

import argparse
import json
import sys

from gear.training.runtime.node import NodeService, read_header
from gear.training.storage.state import load


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("rpc", "cas-import", "cas-export"))
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        node = NodeService(load(args.config))
        if args.action == "rpc":
            result = node.rpc(json.load(sys.stdin))
        else:
            envelope = read_header(sys.stdin.buffer)
            if args.action == "cas-import":
                result = node.import_stream(envelope, sys.stdin.buffer)
            else:
                node.export_stream(envelope, sys.stdout.buffer)
                return
        print(json.dumps(result, allow_nan=False, separators=(",", ":")))
    except Exception as error:
        print(
            json.dumps(
                {
                    "error": {
                        "code": getattr(error, "code", "node-operation-failed"),
                        "message": str(error),
                    }
                }
            ),
            file=sys.stdout,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
