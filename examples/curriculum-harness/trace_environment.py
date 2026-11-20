"""Caller-owned isolated execution of generated TRACE Python games.

No generated code is imported in the host process. Each invocation replays
from a clean seed in a disposable, network-disabled, read-only CPU container.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import subprocess
import time
import uuid
from pathlib import Path

from gear.canonical import digest
from gear.core.schema import validate_output, validate_schema
from ifeval_experiment import read_json, write_json


def freeze(path, value):
    value = json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    if path.exists() and read_json(path) != value:
        raise ValueError("frozen TRACE input or evidence changed: " + str(path))
    write_json(path, value)
    return value


def frozen_file(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or (path.exists() and path.read_bytes() != raw):
        raise ValueError("frozen TRACE source changed: " + str(path))
    path.write_bytes(raw)


class TraceEnvironment:
    """One sealed code artifact, source interface, image, and resource budget."""

    def __init__(
        self, root, code, tools, *, image, timeout_seconds=20, max_output_bytes=1024 * 1024
    ):
        if not isinstance(code, str) or not code.strip() or len(code.encode()) > 256 * 1024:
            raise ValueError("generated environment code must be nonempty and at most 256 KiB")
        if not isinstance(image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
            raise ValueError("TRACE requires an explicit immutable local Docker image ID")
        if type(timeout_seconds) not in (int, float) or not 1 <= timeout_seconds <= 60:
            raise ValueError("TRACE execution timeout must lie in [1, 60] seconds")
        if type(max_output_bytes) is not int or not 4096 <= max_output_bytes <= 4 * 1024 * 1024:
            raise ValueError("TRACE output limit must lie in [4 KiB, 4 MiB]")
        if not isinstance(tools, list) or not 1 <= len(tools) <= 64:
            raise ValueError("supply a bounded authorized source tool interface")
        self.tools = {}
        for tool in tools:
            name = tool["function"]["name"]
            if (
                tool.get("type") != "function"
                or not isinstance(name, str)
                or not name
                or name in self.tools
                or name == "respond_to_user"
            ):
                raise ValueError(
                    "source tools need unique names; respond_to_user is a protocol action"
                )
            validate_schema(tool["function"]["parameters"])
            self.tools[name] = json.loads(json.dumps(tool, allow_nan=False))
        self.root = Path(root).resolve()
        if "," in str(self.root):
            raise ValueError("Docker bind source paths cannot contain commas")
        self.root.mkdir(parents=True, exist_ok=True)
        self.image = image
        self.timeout_seconds = timeout_seconds
        self.max_output_bytes = max_output_bytes
        self.platform = None
        driver = Path(__file__).with_name("trace_driver.py").read_bytes()
        frozen_file(self.root / "environment.py", code.encode())
        frozen_file(self.root / "driver.py", driver)
        self.identity = {
            "schema_version": 1,
            "code_digest": hashlib.sha256(code.encode()).hexdigest(),
            "driver_digest": hashlib.sha256(driver).hexdigest(),
            "tools": self.tools,
            "image": image,
            "timeout_seconds": timeout_seconds,
            "max_output_bytes": max_output_bytes,
            "isolation": {
                "network": "none",
                "user": "65534:65534",
                "memory_bytes": 268435456,
                "cpus": 1,
                "pids": 32,
                "read_only": True,
            },
        }
        freeze(self.root / "identity.json", self.identity)

    def image_platform(self):
        if self.platform is not None:
            return self.platform
        result = subprocess.run(
            [
                "docker",
                "image",
                "inspect",
                self.image,
                "--format",
                "{{.Id}} {{.Os}}/{{.Architecture}}",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        fields = result.stdout.strip().split()
        if (
            len(fields) != 2
            or fields[0] != self.image
            or fields[1] not in ("linux/amd64", "linux/arm64")
        ):
            raise ValueError("local Docker image differs from the frozen identity")
        self.platform = fields[1]
        return self.platform

    def preflight(self):
        platform = self.image_platform()
        result = self.invoke({"operation": "preflight"})
        if result["python"][:2] < [3, 10]:
            raise ValueError("TRACE requires Python 3.10 or newer in the declared image")
        return freeze(
            self.root / "runtime.json", {**result, "image": self.image, "platform": platform}
        )

    def invoke(self, request):
        for name, expected in (
            ("environment.py", self.identity["code_digest"]),
            ("driver.py", self.identity["driver_digest"]),
        ):
            path = self.root / name
            if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise ValueError("sealed TRACE execution source changed: " + name)
        data = json.dumps(request, ensure_ascii=False, allow_nan=False).encode()
        if len(data) > 1024 * 1024:
            raise ValueError("TRACE input exceeds 1 MiB")
        name = "gear-trace-" + uuid.uuid4().hex
        command = [
            "docker",
            "run",
            "--rm",
            "--name",
            name,
            "--pull",
            "never",
            "--platform",
            self.image_platform(),
            "--network",
            "none",
            "--read-only",
            "--user",
            "65534:65534",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "32",
            "--memory",
            "256m",
            "--memory-swap",
            "256m",
            "--cpus",
            "1",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=16777216",
            "--interactive",
            "--mount",
            f"type=bind,src={self.root / 'environment.py'},dst=/input/environment.py,readonly",
            "--mount",
            f"type=bind,src={self.root / 'driver.py'},dst=/input/driver.py,readonly",
            "--workdir",
            "/tmp",
            "--entrypoint",
            "/usr/bin/env",
            self.image,
            "-i",
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "python3",
            "-I",
            "-S",
            "-B",
            "/input/driver.py",
        ]
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
        selector = selectors.DefaultSelector()
        selector.register(process.stdin, selectors.EVENT_WRITE)
        selector.register(process.stdout, selectors.EVENT_READ)
        output, offset = bytearray(), 0
        deadline = time.monotonic() + self.timeout_seconds
        try:
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("TRACE environment exceeded its execution timeout")
                for key, _ in selector.select(min(remaining, 0.2)):
                    if key.fileobj is process.stdin:
                        count = os.write(process.stdin.fileno(), data[offset : offset + 4096])
                        offset += count
                        if offset == len(data):
                            selector.unregister(process.stdin)
                            process.stdin.close()
                    else:
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if not chunk:
                            selector.unregister(process.stdout)
                        output.extend(chunk)
                        if len(output) > self.max_output_bytes:
                            raise ValueError("TRACE environment exceeded its output limit")
            code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
            if code:
                raise RuntimeError(
                    "TRACE isolated execution failed: " + output.decode(errors="replace")[-2000:]
                )
            result = json.loads(output)
            if not isinstance(result, dict):
                raise ValueError("TRACE driver returned a non-object result")
            if "error" in result:
                raise ValueError(
                    "generated TRACE environment violated its execution contract: "
                    + json.dumps(result["error"])
                )
            return result
        finally:
            selector.close()
            # The name is generated here and cannot name another user's resource.
            # A timeout is local execution failure, never a synthetic zero reward.
            try:
                subprocess.run(
                    ["docker", "rm", "--force", name], capture_output=True, timeout=15, check=False
                )
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
                if not process.stdin.closed:
                    process.stdin.close()
                process.stdout.close()

    def action(self, value, available):
        if not isinstance(value, dict) or set(value) != {"name", "arguments"}:
            raise ValueError("TRACE action requires a name and arguments")
        if value["name"] == "respond_to_user":
            validate_output(
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["message"],
                    "properties": {
                        "message": {"type": "string", "minLength": 1, "maxLength": 8192}
                    },
                },
                value["arguments"],
            )
        elif value["name"] in available:
            validate_output(self.tools[value["name"]]["function"]["parameters"], value["arguments"])
        else:
            raise ValueError("generated environment requested an unavailable source tool")

    def replay(self, seed, actions):
        result = self.invoke({"operation": "replay", "seed": seed, "actions": actions})
        snapshots = result["snapshots"]
        if not isinstance(snapshots, list) or len(snapshots) != len(actions) + 1:
            raise ValueError("generated environment omitted actual interaction states")
        previous_tools = None
        for index, state in enumerate(snapshots):
            if state["max_steps"] != snapshots[0]["max_steps"]:
                raise ValueError("generated episode step budget changed during execution")
            available = {}
            for tool in state["tools"]:
                name = tool["function"]["name"]
                if name not in self.tools or tool != self.tools[name] or name in available:
                    raise ValueError("generated environment changed the authorized tool interface")
                available[name] = tool
            if previous_tools is not None and available != previous_tools:
                raise ValueError("generated tool interface changed during the episode")
            previous_tools = available
            if index < len(actions):
                self.action(actions[index], available)
        return result

    def reference(self, seed):
        return self.invoke({"operation": "reference", "seed": seed})["actions"]

    @property
    def environment_id(self):
        return digest(self.identity)
