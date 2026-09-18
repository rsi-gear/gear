#!/usr/bin/env python3
"""Standard-library protocol double for the Node notebook-runtime tests."""
import contextlib
import io
import json
import os
import sys
import traceback

namespace = {}
wire_in = sys.stdin
wire_out = sys.stdout
current = None
allowed = set()
count = 0


def send(value):
    wire_out.write(json.dumps(value) + "\n")
    wire_out.flush()


def call(method, params=None):
    if method not in allowed:
        raise PermissionError("bridge method is not allowed: " + method)
    send({"type": "bridge_request", "requestId": current, "method": method, "params": params or {}})
    response = json.loads(wire_in.readline())
    if response.get("ok"):
        return response.get("result")
    raise RuntimeError(response.get("error"))


class Namespace:
    def __init__(self, prefix):
        self.prefix = prefix

    def __getattr__(self, name):
        return lambda **kwargs: call(self.prefix + "." + name, kwargs)


namespace.update({
    "harness": Namespace("harness"),
    "candidate": Namespace("candidate"),
})

for raw in wire_in:
    message = json.loads(raw)
    if message.get("type") == "shutdown":
        break
    if message.get("type") != "execute":
        continue
    current = message["requestId"]
    allowed = set(message.get("allowedMethods", []))
    os.chdir(message["cwd"])
    count += 1
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        code = message.get("code", "")
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                compiled = compile(code, "<notebook>", "eval")
                value = eval(compiled, namespace)
            except SyntaxError:
                exec(compile(code, "<notebook>", "exec"), namespace)
                value = None
        send({"type": "result", "requestId": current, "ok": True, "result": {
            "stdout": stdout.getvalue(), "stderr": stderr.getvalue(),
            "result": None if value is None else repr(value), "displays": [], "executionCount": count,
        }})
    except BaseException as error:
        send({"type": "result", "requestId": current, "ok": False,
              "error": {"message": str(error), "traceback": traceback.format_exc()}})
