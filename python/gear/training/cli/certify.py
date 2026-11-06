"""Command-line entrypoint; service behavior lives in the implementation package."""

import argparse
import json
from pathlib import Path

from gear.training.runtime.certification import certify
from gear.training.storage.content import ContentStore, atomic_json


def main():
    parser = argparse.ArgumentParser(
        description="Seal a complete, independently audited runtime profile"
    )
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text())
    audit = json.loads(args.audit.read_text())
    result = certify(request, audit, args.audit.parent, ContentStore(args.store))
    atomic_json(args.output, result)


if __name__ == "__main__":
    main()
