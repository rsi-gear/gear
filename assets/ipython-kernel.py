#!/usr/bin/env python3
"""Persistent, line-framed IPython execution helper for gear."""

import contextlib
import io
import json
import os
import sys
import traceback

try:
    from IPython.core.interactiveshell import InteractiveShell
except Exception as error:
    sys.stderr.write("IPython is required by gear: %s\n" % error)
    raise

WIRE_OUT = sys.stdout
WIRE_IN = sys.stdin
SHELL = InteractiveShell.instance()
EXECUTION_COUNT = 0
CURRENT_REQUEST = None
ALLOWED_METHODS = set()


def compact(value):
    """Drop only unset optionals while preserving false/zero/empty values."""
    return {key: item for key, item in value.items() if item is not None}


def send(payload):
    WIRE_OUT.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    WIRE_OUT.flush()


def bridge_call(method, params=None):
    if method not in ALLOWED_METHODS:
        raise PermissionError("bridge method is not allowed in this notebook role: %s" % method)
    send({"type": "bridge_request", "requestId": CURRENT_REQUEST,
          "method": method, "params": {} if params is None else params})
    while True:
        line = WIRE_IN.readline()
        if not line:
            raise RuntimeError("host bridge closed while waiting for a response")
        response = json.loads(line)
        if response.get("type") != "bridge_response" or response.get("requestId") != CURRENT_REQUEST:
            raise RuntimeError("unexpected host bridge frame")
        if response.get("ok"):
            return response.get("result")
        raise RuntimeError(str(response.get("error", "host bridge failed")))


class HarnessAPI:
    """Read the immutable current champion. This never mounts it as Meta authority."""

    def current(self):
        """Return the current champion ref, digest, and manifest."""
        return bridge_call("harness.current")

    def read(self, ref, path, offset=0, limit=None):
        """Read one manifest-indexed champion file with byte/page bounds."""
        params = {"ref": ref, "path": path, "offset": offset}
        if limit is not None:
            params["limit"] = limit
        return bridge_call("harness.read", params)


class SeedTasksAPI:
    """Load only the configured seed task set. Held-out tasks are unavailable."""

    def load(self, partition="seed"):
        """Return the seed task configuration; partition must be 'seed'."""
        return bridge_call("seed_tasks.load", {"partition": partition})


class TrajectoryAPI:
    """Query seed evidence and Hitch canonical target trajectories."""

    def query(self, roundId=None, refs=None, view=None, offset=0, limit=20,
              turn=None, step=None, eventTypes=None, aroundSeq=None, radius=None,
              errorsOnly=None):
        """Read seed summaries/progress or bundle, steps, context, and raw-event views for eval/run refs."""
        params = {"offset": offset, "limit": limit}
        if roundId is not None:
            params["roundId"] = roundId
        if refs is not None:
            params["refs"] = refs
        params.update(compact({
            "view": view, "turn": turn, "step": step, "eventTypes": eventTypes,
            "aroundSeq": aroundSeq, "radius": radius, "errorsOnly": errorsOnly,
        }))
        return bridge_call("trajectory.query", params)


class HitchAPI:
    """Read the public, seed-only status of a refinement round."""

    def status(self, roundId):
        """Return baseline/candidate summaries without held-out fields."""
        return bridge_call("hitch.status", {"roundId": roundId})


class RefineAPI:
    """Target-session control APIs; unavailable to the refine-meta role."""

    def run(self, reason=None):
        params = {} if reason is None else {"reason": reason}
        return bridge_call("refine.run", params)

    def status(self, evolutionId, roundId=None):
        return bridge_call("refine.status", compact({"evolutionId": evolutionId, "roundId": roundId}))


class CandidateAPI:
    """Git-native candidate control plane; source editing uses DSH tools."""

    def diff(self, maxBytes=None):
        return bridge_call("candidate.diff", compact({"maxBytes": maxBytes}))

    def check(self, check=None):
        return bridge_call("candidate.check", compact({"check": check}))

    def finalize(self, rationale, expectedOutcome, evidenceRefs, semanticTargets=None):
        return bridge_call("candidate.finalize", compact({
            "rationale": rationale, "expectedOutcome": expectedOutcome,
            "evidenceRefs": evidenceRefs, "semanticTargets": semanticTargets,
        }))

    def decline(self, rationale, evidenceRefs=None):
        return bridge_call("candidate.decline", compact({"rationale": rationale, "evidenceRefs": evidenceRefs}))


SHELL.user_ns.update({
    "harness": HarnessAPI(),
    "seed_tasks": SeedTasksAPI(),
    "trajectory": TrajectoryAPI(),
    "hitch": HitchAPI(),
    "refine": RefineAPI(),
    "candidate": CandidateAPI(),
})


def execute(message):
    global EXECUTION_COUNT, CURRENT_REQUEST, ALLOWED_METHODS
    CURRENT_REQUEST = message["requestId"]
    ALLOWED_METHODS = set(message.get("allowedMethods", []))
    cwd = message.get("cwd")
    if cwd:
        os.chdir(cwd)
    stdout = io.StringIO()
    stderr = io.StringIO()
    EXECUTION_COUNT += 1
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            outcome = SHELL.run_cell(message.get("code", ""), store_history=True, silent=False)
        if outcome.error_before_exec is not None:
            raise outcome.error_before_exec
        if outcome.error_in_exec is not None:
            raise outcome.error_in_exec
        result = None if outcome.result is None else repr(outcome.result)
        send({"type": "result", "requestId": CURRENT_REQUEST, "ok": True, "result": {
            "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "result": result,
            "displays": [], "executionCount": EXECUTION_COUNT,
        }})
    except KeyboardInterrupt:
        send({"type": "result", "requestId": CURRENT_REQUEST, "ok": False,
              "error": {"message": "execution interrupted", "traceback": "KeyboardInterrupt"}})
    except BaseException as error:
        send({"type": "result", "requestId": CURRENT_REQUEST, "ok": False,
              "error": {"message": str(error), "traceback": traceback.format_exc()}})
    finally:
        CURRENT_REQUEST = None
        ALLOWED_METHODS = set()


for raw in WIRE_IN:
    try:
        message = json.loads(raw)
        if message.get("type") == "shutdown":
            break
        if message.get("type") == "execute":
            execute(message)
    except BaseException:
        send({"type": "result", "requestId": message.get("requestId") if "message" in locals() else "",
              "ok": False, "error": {"message": "helper protocol failure", "traceback": traceback.format_exc()}})
