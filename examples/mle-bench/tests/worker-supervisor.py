"""Exercise supervisor races with sandbox/process creation stubbed at the boundary."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'target-carrier/fixed'))
import worker


class SupervisorTest(unittest.TestCase):
    def run_supervisor(self, error=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / 'runtime'
            (runtime / 'usr/bin').mkdir(parents=True)
            (runtime / 'usr/bin/python3').touch()
            scratch = runtime / 'work/scratch'
            vanishing = scratch / 'temporary'
            actual_lstat, actual_mkdtemp = Path.lstat, tempfile.mkdtemp
            removed = []

            class Child:
                returncode = 0

                def __init__(self):
                    self.polls = iter([None, 0])

                def poll(self):
                    return next(self.polls)

                def wait(self, timeout):
                    return 0

            def launch(*args, **kwargs):
                (scratch / 'result.txt').write_bytes(b'completed')
                vanishing.write_bytes(b'temporary training data')
                return Child()

            def lstat(path, *args, **kwargs):
                if path == vanishing:
                    if error:
                        raise error
                    vanishing.unlink()
                    removed.append(path)
                return actual_lstat(path, *args, **kwargs)

            def logs(**kwargs):
                return actual_mkdtemp(**{**kwargs, 'dir': root})

            with patch.object(worker, 'preflight'), patch.object(worker, 'stop_children'), \
                    patch.object(worker.os, 'chown'), patch.object(worker, 'Path',
                    lambda path: runtime if str(path) == '/opt/kaggle-runtime' else Path(path)), \
                    patch.object(subprocess, 'Popen', launch), patch.object(tempfile, 'mkdtemp', logs), \
                    patch.object(Path, 'lstat', lstat):
                result = worker.run_python({'solution.py': b''}, {}, 'solution.py', [], 10, 10)
            self.assertEqual(removed, [vanishing])
            self.assertEqual(result['exitCode'], 0)
            self.assertIsNone(result['limit'])
            self.assertEqual(result['outputs'], {'result.txt': b'completed'})

    def test_temporary_file_removed_between_enumeration_and_stat(self):
        self.run_supervisor()

    def test_other_disk_inspection_errors_remain_fatal(self):
        with self.assertRaisesRegex(PermissionError, 'disk cannot be inspected'):
            self.run_supervisor(PermissionError('disk cannot be inspected'))


if __name__ == '__main__':
    unittest.main()
