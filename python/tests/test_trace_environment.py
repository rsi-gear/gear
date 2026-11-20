"""Opt-in actual Docker isolation and execution of generated-code fixtures."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

EXAMPLES = Path(__file__).resolve().parents[2] / "examples/curriculum-harness"
sys.path.insert(0, str(EXAMPLES))
from fixtures.trace_game import TOOLS, source  # noqa: E402
from trace_environment import TraceEnvironment  # noqa: E402

IMAGE = os.environ.get("GEAR_TRACE_PYTHON_IMAGE")


@unittest.skipUnless(IMAGE, "requires an explicit local CPU Python Docker image ID")
class TraceEnvironmentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def environment(self, code=None, name="environment", **settings):
        return TraceEnvironment(self.root / name, code or source(), TOOLS, image=IMAGE, **settings)

    def test_real_reference_replay_seed_diversity_and_reset(self):
        env = self.environment()
        self.assertEqual(env.preflight()["image"], IMAGE)
        reference = env.reference(17)
        result = env.replay(17, reference)
        self.assertEqual(result["snapshots"][-1]["summary"], {"reward": 1.0, "steps": 4})
        self.assertTrue(result["snapshots"][-1]["done"])
        self.assertEqual(result, env.replay(17, reference))
        self.assertEqual(env.replay(17, [])["snapshots"][0]["summary"]["reward"], 0)
        self.assertNotEqual(
            env.replay(18, [])["snapshots"][0]["messages"], result["snapshots"][0]["messages"]
        )
        wrong = reference[:-1] + [
            {"name": "respond_to_user", "arguments": {"message": "wrong order"}}
        ]
        self.assertLess(env.replay(17, wrong)["snapshots"][-1]["summary"]["reward"], 1)
        self.assertLess(env.replay(17, reference[-1:])["snapshots"][-1]["summary"]["reward"], 1)

    def test_host_files_secrets_network_and_source_writes_are_unavailable(self):
        canary = self.root / "host-only.txt"
        canary.write_text("explicit isolation test canary")
        probe = f"""
import os
import socket
def attempted(operation):
    try:
        operation()
        return True
    except Exception:
        return False
observed = {{
    "host_read": attempted(lambda: open({str(canary)!r}).read()),
    "source_write": attempted(lambda: open("/input/environment.py", "a").write("changed")),
    "network": attempted(lambda: socket.create_connection(("1.1.1.1", 443), timeout=0.2)),
    "inherited_secret": "GEAR_TRACE_HOST_CANARY" in os.environ,
    "uid": os.getuid(),
}}
original_summary = CapabilityGame.get_summary
def summary(self):
    return {{**original_summary(self), "isolation": observed}}
CapabilityGame.get_summary = summary
"""
        env = self.environment(source() + probe)
        with patch.dict(os.environ, {"GEAR_TRACE_HOST_CANARY": "explicit test value"}):
            result = env.replay(2, [])
        self.assertEqual(
            result["snapshots"][0]["summary"]["isolation"],
            {
                "host_read": False,
                "source_write": False,
                "network": False,
                "inherited_secret": False,
                "uid": 65534,
            },
        )
        self.assertEqual(canary.read_text(), "explicit isolation test canary")

    def test_changed_interfaces_invalid_rewards_and_nontermination_are_rejected(self):
        changed = source().replace(
            "return TOOLS",
            'return [{"type": "function", "function": {"name": "invented", "parameters": {}}}]',
        )
        with self.assertRaisesRegex(ValueError, "tool interface"):
            self.environment(changed, name="changed").replay(1, [])
        invalid = source().replace("self.reward = 0.0", 'self.reward = float("nan")')
        with self.assertRaisesRegex(ValueError, "reward must be finite"):
            self.environment(invalid, name="nan").replay(1, [])
        with self.assertRaises(TimeoutError):
            self.environment("while True: pass", name="loop", timeout_seconds=2).replay(1, [])

    def test_output_limit_and_frozen_source_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "output limit"):
            self.environment('print("x" * 100000)', max_output_bytes=4096).replay(1, [])
        with self.assertRaisesRegex(ValueError, "frozen TRACE source"):
            self.environment(source())
        env = self.environment(name="valid")
        action = {"name": "get_order_details", "arguments": {"unexpected": "value"}}
        with self.assertRaises(ValueError):
            env.action(action, {"get_order_details"})
        (env.root / "environment.py").write_text("print('changed')")
        with self.assertRaisesRegex(ValueError, "sealed TRACE execution source"):
            env.replay(1, [])


if __name__ == "__main__":
    unittest.main()
