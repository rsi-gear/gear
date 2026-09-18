"""Collect bounded diagnostic log tails, never model or checkpoint payloads."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat

from gear_training.content import require
from single_gpu_recovery_smoke import context


def log_tail(path, limit=64 * 1024):
    require(not path.is_symlink(), "diagnostic-log-symlink", "log must be an ordinary file")
    with path.open("rb") as stream:
        before = path.stat()
        require(stat.S_ISREG(before.st_mode), "diagnostic-log-type", "log must be an ordinary file")
        offset = max(0, before.st_size - limit)
        stream.seek(offset)
        chunk = stream.read(limit)
        after = path.stat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
            "diagnostic-log-changing", "log changed while collecting evidence")
    return {"name": path.name, "fileBytes": before.st_size, "offset": offset,
            "tailBytes": len(chunk), "tailDigest": "sha256:" + hashlib.sha256(chunk).hexdigest(),
            "text": chunk.decode("utf-8", errors="replace")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-config", required=True)
    options = parser.parse_args()
    node, service, directory, _, handle = context(options.node_config)
    status = service.inspect(handle)
    require(status["execution"] in ("failed", "interrupted", "paused") and status["resourcesReleased"],
            "diagnostic-job-active", "collect failure logs only after physical release")
    worker = json.loads((directory / "worker.json").read_text())
    incarnation = worker["incarnation"]
    require(isinstance(incarnation, str) and re.fullmatch(r"[0-9a-f]{32}", incarnation),
            "diagnostic-incarnation-invalid", "invalid diagnostic incarnation")
    paths = [directory / ("slime-" + incarnation + ".log"), directory / "supervisor.log"]
    report = {"kind": "training-failure-log-tails", "node": node.identity, "handle": handle,
              "status": status, "incarnation": incarnation, "logs": [log_tail(p) for p in paths if p.exists()]}
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
