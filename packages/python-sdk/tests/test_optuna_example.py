import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


EXAMPLE = Path(__file__).parents[3] / "examples/algorithms/optuna/make_config.py"


class OptunaExampleConfigTests(unittest.TestCase):
    def test_key_and_config_are_private_and_crash_retry_keeps_original_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copyfile(EXAMPLE, root / "make_config.py")
            command = [sys.executable, str(root / "make_config.py")]
            subprocess.run(command, cwd=root, check=True, capture_output=True, text=True)
            key, config = root / "checkpoint.key", root / "gear.algorithm.json"
            self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
            original = key.read_bytes()
            config.unlink()  # Crash after durable key creation but before config publish.
            subprocess.run(command, cwd=root, check=True, capture_output=True, text=True)
            self.assertEqual(key.read_bytes(), original)
            config_value = config.read_bytes()
            subprocess.run(command, cwd=root, check=True, capture_output=True, text=True)
            self.assertEqual(config.read_bytes(), config_value)
            key.unlink()
            missing = subprocess.run(command, cwd=root, capture_output=True, text=True)
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn("restore its original key", missing.stderr + missing.stdout)
            self.assertFalse(key.exists())


if __name__ == "__main__":
    unittest.main()
