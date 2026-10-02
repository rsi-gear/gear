"""Exercise the example's real CAS snapshots and its data-split boundaries."""
import copy
import runpy
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest

from gear_training.content import ContentStore
from gear_training.export import materialize, dataset_destination

EXAMPLE = Path(__file__).resolve().parents[2] / 'examples/training-loop/terminal-bench-2.1/prepare.py'
example = SimpleNamespace(**runpy.run_path(str(EXAMPLE)))


class TerminalBenchExampleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name); self.tasks = self.root / 'tasks'; self.tasks.mkdir()
        self.splits = {'train': ['one'], 'dev': ['two'], 'heldOut': ['three']}
        self.bindings = {}
        for name in ('one', 'two', 'three'):
            task = self.tasks / name; task.mkdir()
            (task / 'task.toml').write_text('version = "1.0"\n')
            (task / 'instruction.md').write_text(name)
            (task / 'tests').mkdir(); test = task / 'tests/test.sh'; test.write_text('exit 0\n'); test.chmod(0o755)
            self.bindings[name] = {'family': name, 'environment': {key: 'sha256:' + 'a' * 64 for key in
                ('hitchEnvironmentIdentity', 'taskDigest', 'verifierIdentity')}}
        self.store = ContentStore(self.root / 'cas')
        self.base = {'kind': 'model-training', 'trainer': {'recipe': 'agent-grpo-v1', 'updatesPerCandidate': 2},
                     'evaluation': {'policy': {'requiredTaskIds': ['old'], 'minDevGain': 0.1}},
                     'resources': {'sentinel': 'preserve'}, 'datasets': {'old': True}}

    def test_sealed_partitions_preserve_names_modes_and_source_without_mutating_base(self):
        before = copy.deepcopy(self.base)
        spec = example.prepare(self.base, self.tasks, self.splits, self.bindings, self.store)
        self.assertEqual(self.base, before)
        self.assertEqual(spec['resources'], before['resources'])
        self.assertEqual(spec['evaluation']['policy']['requiredTaskIds'], ['two', 'three'])
        self.assertEqual(spec['trainer']['updatesPerCandidate'], 2)
        for partition, names in self.splits.items():
            data = spec['datasets'][partition]
            self.assertEqual(data['exactDataAuthorized'], partition == 'train')
            snapshot = self.store.read_json(data['snapshotRef'])
            self.assertEqual(snapshot['name'], partition)
            self.assertTrue(all(item['path'].startswith(names[0] + '/') for item in snapshot['files']))
            task = data['tasks'][0]; manifest = self.store.read_json(task['taskRef'])
            destination = dataset_destination(manifest, self.root / 'materialized')
            materialize(self.store, task['taskRef'], destination)
            self.assertEqual(destination.name, names[0])
            self.assertEqual((destination / 'tests/test.sh').stat().st_mode & 0o777, 0o755)
        source = self.store.read_json(spec['trainer']['script']['sourceRef'])
        self.assertEqual(source['files'][0]['path'], 'tb21.py')
        self.assertIn(b'PolicyDatasetBuilder', self.store.read_bytes(source['files'][0]['contentRef']))

    def test_rejects_overlap_family_leakage_and_placeholder_identities(self):
        for change in ('overlap', 'family', 'identity'):
            splits, bindings = copy.deepcopy(self.splits), copy.deepcopy(self.bindings)
            if change == 'overlap': splits['dev'] = ['one']
            if change == 'family': bindings['two']['family'] = 'one'
            if change == 'identity': bindings['one']['environment']['taskDigest'] = 'REPLACE'
            with self.subTest(change=change), self.assertRaises(ValueError):
                example.prepare(self.base, self.tasks, splits, bindings, self.store)

    def test_rejects_traversal_and_symlink_tasks(self):
        splits = {**self.splits, 'train': ['../one']}
        with self.assertRaises(ValueError): example.prepare(self.base, self.tasks, splits, self.bindings, self.store)
        (self.tasks / 'one/link').symlink_to(self.tasks / 'two/instruction.md')
        with self.assertRaises(ValueError): example.prepare(self.base, self.tasks, self.splits, self.bindings, self.store)


if __name__ == '__main__': unittest.main()
