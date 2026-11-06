"""Bounded supervision of one admitted run through Gear's public Python API."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
import traceback
from pathlib import Path

from gear import Project, ProjectError

RECOVERABLE = {
    "hitch-call-failed",
    "provider-environment-unavailable",
    "operation-needs-recovery",
    "hitch-operation-pending",
    "operation-interrupted",
}


def supervise(
    project: Project,
    run_id: str,
    output: Path,
    *,
    max_attempts: int = 12,
    retry_delay_seconds: float = 30,
    min_free_bytes: int = 8 * 2**30,
) -> int:
    if max_attempts < 1 or retry_delay_seconds < 0 or min_free_bytes < 0:
        raise ValueError(
            "supervision needs a positive attempt limit and nonnegative delay/disk limit"
        )
    # A fresh private directory prevents a restarted supervisor from overwriting diagnostics.
    output.mkdir(parents=True, mode=0o700)

    def save(state: str, **extra: object) -> None:
        temporary = output / "status.tmp"
        temporary.write_text(
            json.dumps(
                dict(
                    state=state,
                    updated_at=time.time(),
                    supervisor_pid=os.getpid(),
                    run_id=run_id,
                    **extra,
                ),
                indent=2,
            )
        )
        temporary.replace(output / "status.json")

    for attempt in range(max_attempts):
        try:
            report = project.report(run_id).summary
            if report["status"] in ("completed", "cancelled"):
                save("finished", attempt=attempt, run_status=report["status"])
                return 0
            if shutil.disk_usage(output).free < min_free_bytes:
                save(
                    "needs_attention",
                    attempt=attempt,
                    reason="insufficient ordinary free disk space",
                )
                return 1
            save("running", attempt=attempt)
            result = project.resume(run_id)
            (output / f"execution-{attempt}.report.json").write_text(
                json.dumps(result.report.summary, indent=2)
            )
            status = result.report.summary["status"]
            if status not in ("completed", "cancelled"):
                save(
                    "needs_attention",
                    attempt=attempt,
                    reason="resume did not confirm a terminal run",
                )
                return 1
            save("finished", attempt=attempt, run_status=status)
            return 0
        except ProjectError as error:
            # The SDK preserves exact bytes without rendering them in the exception message.
            (output / f"execution-{attempt}.stderr.log").write_bytes(
                error.stderr or b""
            )
            if error.code not in RECOVERABLE:
                save("needs_attention", attempt=attempt, error_code=error.code)
                return 1
            if attempt + 1 == max_attempts:
                save(
                    "needs_attention",
                    attempt=attempt,
                    reason="bounded recovery limit reached",
                )
                return 1
            save("recovering", attempt=attempt, error_code=error.code)
            time.sleep(retry_delay_seconds)
        except Exception:  # noqa: BLE001 - unclassified failures must stop supervision.
            (output / f"execution-{attempt}.stderr.log").write_text(
                traceback.format_exc()
            )
            save("needs_attention", attempt=attempt, reason="supervisor failed")
            return 1
    raise AssertionError("unreachable bounded supervision state")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    return supervise(Project.open(args.project), args.run_id, args.output)


if __name__ == "__main__":
    raise SystemExit(main())
