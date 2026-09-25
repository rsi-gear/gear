#!/usr/bin/env python3
"""Wait for a benchmark controller and report its reaped process-tree CPU.

On macOS, wait4's rusage includes children that the controller waited for.
The benchmark's Node controller waits for author workers and lock helpers.
The supervisor is measurement apparatus and is excluded from CPU totals.
"""

import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: supervisor executable [arguments...]", file=sys.stderr)
        return 2
    pid = os.fork()
    if pid == 0:
        try:
            os.execv(sys.argv[1], sys.argv[1:])
        except OSError as exc:
            print(f"benchmark controller exec failed: {exc}", file=sys.stderr)
            os._exit(127)
    _, status, usage = os.wait4(pid, 0)
    print(json.dumps({"event": "usage", "processTreeCpuMs":
                      (usage.ru_utime + usage.ru_stime) * 1000}), flush=True)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    raise SystemExit(main())
