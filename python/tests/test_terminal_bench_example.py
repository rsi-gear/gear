"""Exercise the example's real CAS snapshots and its data-split boundaries."""
import copy
import runpy
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gear_training.offline import seal_dataset

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
        self.base = {'kind': 'model-training', 'trainer': {'recipe': 'agent-grpo-v1', 'updatesPerCandidate': 2, 'scriptConfig': {'custom': 3}},
                     'evaluation': {'policy': {'requiredTaskIds': ['old'], 'minDevGain': 0.1}},
                     'resources': {'sentinel': 'preserve'}, 'datasets': {'old': True}}

    def test_sealed_partitions_preserve_names_modes_and_source_without_mutating_base(self):
        before = copy.deepcopy(self.base)
        spec = example.prepare(self.base, self.tasks, self.splits, self.bindings, self.store)
        self.assertEqual(self.base, before)
        self.assertEqual(spec['resources'], before['resources'])
        self.assertEqual(spec['evaluation']['policy']['requiredTaskIds'], ['two', 'three'])
        self.assertEqual(spec['trainer']['updatesPerCandidate'], 2)
        self.assertEqual(spec['trainer']['scriptConfig'], {'custom': 3})
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
            # Harbor discovers child tasks, rather than a task at the dataset root.
            discovered = [p.name for p in destination.iterdir() if p.is_dir() and (p / 'task.toml').is_file()]
            self.assertEqual(discovered, names)
            self.assertEqual((destination / names[0] / 'tests/test.sh').stat().st_mode & 0o777, 0o755)
        source = self.store.read_json(spec['trainer']['script']['sourceRef'])
        self.assertEqual(source['files'][0]['path'], 'tb21.py')
        self.assertIn(b'PolicyDatasetBuilder', self.store.read_bytes(source['files'][0]['contentRef']))

    def sft_fixture(self):
        base = copy.deepcopy(self.base)
        base['trainer'].update(recipe='offline-sft-v1', rolloutBatchSize=1)
        base['initialModel'] = self.store.put_json({
            'tokenizerDigest': 'sha256:' + 'b' * 64, 'chatTemplateDigest': 'sha256:' + 'c' * 64})
        base['offlineTraining'] = {'maxEpochs': 2, 'maxSequenceTokens': 64,
                                   'shuffleSeed': 23, 'maskContract': 'assistant-token-mask-v1'}
        spec = example.prepare(base, self.tasks, self.splits, self.bindings, self.store)
        task = spec['datasets']['train']['tasks'][0]
        payload = {'schemaVersion': 1, 'modelRef': spec['initialModel'], 'maxSequenceTokens': 64,
                   'records': [{'source': {'taskId': task['id'], 'family': task['family'],
                                           'taskDigest': task['taskRef']['digest']},
                                'segments': [{'role': 'user', 'tokens': [1, 2]},
                                             {'role': 'assistant', 'tokens': [3, 4]},
                                             {'role': 'tool', 'tokens': [5, 6]},
                                             {'role': 'assistant', 'tokens': [7]}]}]}
        return spec, payload

    def test_sft_factory_and_real_sealer_keep_only_assistant_loss(self):
        spec, payload = self.sft_fixture()
        example.check_sft_input(spec, payload)
        source = self.store.read_json(spec['trainer']['script']['sourceRef'])
        self.assertEqual(spec['trainer']['script']['entrypoint'], 'tb21_sft:build_loop')
        self.assertEqual(source['files'][0]['path'], 'tb21_sft.py')
        self.assertIn(b'OfflineRolloutExecutor', self.store.read_bytes(source['files'][0]['contentRef']))
        sealed = seal_dataset(self.store, payload)
        data = self.store.read_json(sealed['datasetRef'])
        record = self.store.read_json(data['records'][0])
        self.assertEqual(record['lossMask'], [0, 0, 1, 1, 0, 0, 1])
        self.assertEqual(record['source'], payload['records'][0]['source'])

    def test_sft_rejects_model_length_provenance_and_epoch_mismatch(self):
        spec, payload = self.sft_fixture()
        for change in ('model', 'length', 'dev', 'digest', 'capacity'):
            changed_spec, changed = copy.deepcopy(spec), copy.deepcopy(payload)
            if change == 'model': changed['modelRef'] = self.store.put_json({'other': True})
            if change == 'length': changed['maxSequenceTokens'] = 32
            if change == 'dev': changed['records'][0]['source']['taskId'] = 'two'
            if change == 'digest': changed['records'][0]['source']['taskDigest'] = 'sha256:' + 'd' * 64
            if change == 'capacity': changed_spec['offlineTraining']['maxEpochs'] = 1
            with self.subTest(change=change), self.assertRaises(ValueError):
                example.check_sft_input(changed_spec, changed)

    def test_run_validates_before_submission_and_preserves_failure_status(self):
        with patch.dict(example.run_spec.__globals__, {'training_main': unittest.mock.Mock(side_effect=[0, 7])}):
            self.assertEqual(example.run_spec(self.root / 'spec.json', self.root / 'controller.json'), 7)
            runner = example.run_spec.__globals__['training_main']
            self.assertEqual([call.args[0][0] for call in runner.call_args_list], ['validate', 'run'])
        with patch.dict(example.run_spec.__globals__, {'training_main': unittest.mock.Mock(return_value=2)}):
            self.assertEqual(example.run_spec(self.root / 'spec.json', self.root / 'controller.json'), 2)
            self.assertEqual(example.run_spec.__globals__['training_main'].call_count, 1)

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
