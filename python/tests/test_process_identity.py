import os
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import psutil

from gear.training.runtime.recovery import (
    owned_alive,
    owned_session_alive,
    process_identity,
    same_identity,
    stop_owned,
)


def sleeper(script="import time; time.sleep(60)"):
    return subprocess.Popen([sys.executable, "-c", script], start_new_session=True)


@unittest.skipUnless(sys.platform.startswith("linux"), "boot-relative start time is read from /proc")
class BootTimeShiftTests(unittest.TestCase):
    """psutil derives create_time() from /proc/stat btime, which moves with wall-clock updates (#102)."""

    def setUp(self):
        self.child = sleeper(); self.addCleanup(self.reap, self.child)
        self.identity = process_identity(self.child.pid)
        real = psutil._pslinux.boot_time
        # btime observed moving by 1-2 s on WSL2; shift it backwards so session members also look older.
        shifted = patch("psutil._pslinux.boot_time", side_effect=lambda: real() - 2)
        self.start_shift = lambda: (shifted.start(), self.addCleanup(shifted.stop))

    @staticmethod
    def reap(process):
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)

    def test_live_process_stays_owned_after_boot_time_shift(self):
        self.start_shift()
        self.assertNotEqual(psutil.Process(self.child.pid).create_time(), self.identity["createdAt"])
        self.assertTrue(owned_alive(self.identity))
        self.assertTrue(owned_session_alive(self.identity))
        stop_owned([self.identity])
        self.assertIsNotNone(self.child.poll())

    def test_session_member_stays_owned_after_leader_exit_and_boot_time_shift(self):
        leader = sleeper("import subprocess, sys; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])")
        identity = process_identity(leader.pid)
        leader.wait(timeout=10)
        members = [p for p in psutil.process_iter(["pid"]) if p.pid != leader.pid and _sid(p.pid) == leader.pid]
        self.assertEqual(len(members), 1)
        self.addCleanup(lambda: _kill(members[0]))
        self.start_shift()
        self.assertTrue(owned_session_alive(identity))

    def test_worker_fence_identity_survives_boot_time_shift(self):
        self.start_shift()
        current = process_identity(self.child.pid)
        self.assertNotEqual(current["createdAt"], self.identity["createdAt"])
        self.assertTrue(same_identity(self.identity, current))
        self.assertFalse(same_identity(self.identity, {**current, "startTicks": current["startTicks"] + 1}))
        self.assertFalse(same_identity({**self.identity, "pgid": 1}, {**current, "pgid": 2}))

    def test_reused_pid_is_not_owned(self):
        reused = {**self.identity, "createdAt": self.identity["createdAt"] - 1, "startTicks": self.identity.get("startTicks", 0) - 1}
        self.assertFalse(owned_alive(reused))
        stop_owned([reused]); time.sleep(0.2)
        self.assertIsNone(self.child.poll())

    def test_identity_from_an_earlier_boot_is_not_owned(self):
        self.assertIn("bootId", self.identity)
        self.assertFalse(owned_alive({**self.identity, "bootId": "0" * 36}))

    def test_legacy_identity_without_start_ticks_still_matches(self):
        legacy = {"pid": self.identity["pid"], "createdAt": self.identity["createdAt"]}
        self.assertTrue(owned_alive(legacy))
        self.assertTrue(owned_session_alive(legacy))


def _sid(pid):
    try:
        return os.getsid(pid)
    except (ProcessLookupError, PermissionError):
        return None


def _kill(process):
    try:
        process.kill(); process.wait(timeout=5)
    except psutil.NoSuchProcess:
        pass


if __name__ == "__main__":
    unittest.main()
