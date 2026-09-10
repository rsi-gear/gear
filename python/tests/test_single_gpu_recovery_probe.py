"""Real CPU process signals; GPU ownership/accounting below is a fixture."""
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from gear_training.content import atomic_json
from gear_training.ledger import Ledger
from gear_training.recovery import process_identity
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'probes'))
import single_gpu_recovery_smoke as probe


class RecoveryProbeTests(unittest.TestCase):
    def test_external_watcher_hits_each_durable_boundary_and_kills_only_the_owned_process(self):
        for boundary in ('sealed-batch', 'pending-update', 'committed-update'):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as root:
                root = Path(root)
                child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', '-m', 'gear_training.driver'])
                unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
                try:
                    owned = process_identity(child.pid)
                    atomic_json(root / 'owned-processes.json', [owned])
                    atomic_json(root / 'progress.json', {'phase': 'collecting'})
                    atomic_json(root / 'batch.json', {'batchRef': 'fixture'})
                    if boundary != 'sealed-batch': atomic_json(root / 'pending-update.json', {'fixture': True})
                    ledger = Ledger(root / 'ledger.sqlite')
                    if boundary == 'committed-update': ledger.commit_update(1, 'fixture', {'fixture': True})
                    ledger.close()
                    started = time.monotonic()
                    service = SimpleNamespace(inspect=lambda handle: {'execution': 'running', 'resourcesReleased': False, 'usage': {'gpuSeconds': time.monotonic()-started}})
                    with patch.object(probe, 'context', return_value=(SimpleNamespace(identity={'fixture': True}), service, root, {}, {'fixture': True})):
                        probe.watch('fixture', boundary, root / 'fault.json', 10)
                    child.wait(timeout=5)
                    report = json.loads((root / 'fault.json').read_text())
                    self.assertTrue(report['injected']); self.assertEqual(report['process'], owned)
                    self.assertLess(child.returncode, 0); self.assertIsNone(unrelated.poll())
                    self.assertGreaterEqual(report['unresponsiveGpuSeconds'], 2.5)
                finally:
                    for process in (child, unrelated):
                        if process.poll() is None: process.kill()
                        process.wait(timeout=5)


if __name__ == '__main__': unittest.main()
