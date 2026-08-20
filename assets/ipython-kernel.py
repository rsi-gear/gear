#!/usr/bin/env python3
"""Persistent, line-framed IPython execution helper for dsh-plugin-refine."""

import contextlib
import io
import json
import os
import sys
import traceback

try:
    from IPython.core.interactiveshell import InteractiveShell
except Exception as error:
    sys.stderr.write("IPython is required by dsh-plugin-refine: %s\n" % error)
    raise

WIRE_OUT = sys.stdout
WIRE_IN = sys.stdin
SHELL = InteractiveShell.instance()
EXECUTION_COUNT = 0
CURRENT_REQUEST = None
ALLOWED_METHODS = set()


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


class Namespace:
    def __init__(self, prefix):
        self._prefix = prefix

    def __getattr__(self, name):
        method = self._prefix + "." + name
        return lambda **kwargs: bridge_call(method, kwargs)


SHELL.user_ns.update({
    "harness": Namespace("harness"),
    "seed_tasks": Namespace("seed_tasks"),
    "trajectory": Namespace("trajectory"),
    "hitch": Namespace("hitch"),
    "refine": Namespace("refine"),
    "submit_refinement_proposal": lambda **kwargs: bridge_call("submit_refinement_proposal", kwargs),
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
