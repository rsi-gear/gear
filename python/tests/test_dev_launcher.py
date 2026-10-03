import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gear_training.cli import main, prepare_spec
from gear_training.dev_launcher import main as legacy_main


class LauncherTests(unittest.TestCase):
    def test_default_preserves_real_refs_and_input(self):
        original = {'trainer': {'runtimeLock': {'digest': 'real'}}, 'initialModel': {'uri': 'cas:real'}}
        selected = prepare_spec(original)
        self.assertEqual(selected['initialModel'], original['initialModel'])
        self.assertEqual(selected['trainer'], original['trainer'])
        self.assertEqual(selected['scriptSource']['entrypoint'], 'recipe:build_loop')
        self.assertNotIn('scriptSource', original)
        with self.assertRaises(ValueError): prepare_spec({**original, 'stages': {'taskSource': {}}})

    def test_new_run_accepts_default_custom_frozen_and_generic_scripts(self):
        with tempfile.TemporaryDirectory(prefix='gear launcher ') as directory:
            root = Path(directory).resolve()
            frozen = {'entrypoint': 'tb21:build_loop', 'sourceRef': {'digest': 'existing'}}
            variants = [
                {'trainer': {'recipe': 'agent-grpo-v1'}},
                {'trainer': {'recipe': 'offline-sft-v1'}},
                {'trainer': {}, 'scriptSource': {'directory': './recipes', 'entrypoint': 'custom:build_loop'}},
                {'trainer': {'script': frozen}},
                {'kind': 'training-script', 'source': './recipes', 'entrypoint': 'linear:build_loop'},
            ]
            for value in variants:
                spec = root / 'spec.json'; spec.write_text(json.dumps(value))
                def follow(argv):
                    self.assertEqual(argv[:4], ['node', 'a path/cli.js', 'training', 'run'])
                    selected = json.loads(Path(argv[4]).read_text())
                    if value.get('kind') == 'training-script': self.assertEqual(selected['source'], str(root / 'recipes'))
                    elif 'scriptSource' in value: self.assertEqual(selected['scriptSource']['directory'], str(root / 'recipes'))
                    elif value['trainer'].get('script'):
                        self.assertEqual(selected['trainer']['script'], frozen)
                        self.assertNotIn('scriptSource', selected)
                    else: self.assertEqual(selected['scriptSource']['entrypoint'], 'recipe:build_loop')
                    return 0
                with self.subTest(value=value), patch('gear_training.cli._follow', side_effect=follow):
                    self.assertEqual(main(['run', str(spec), '--config', str(root/'controller.json'), '--gear-command', '["node", "a path/cli.js"]']), 0)
                self.assertEqual(json.loads(spec.read_text()), value)

    def test_resume_native_uses_frozen_ids_and_follows_without_new_spec(self):
        with patch('gear_training.cli.subprocess.run') as run, patch('gear_training.cli._follow', return_value=0) as follow:
            main(['resume', 'exp_existing', 'run_existing', '--config', 'controller.json', '--gear-command', '["gear-refine"]'])
            run.assert_called_once()
            self.assertEqual(run.call_args.args[0][1:5], ['training', 'resume', 'exp_existing', 'run_existing'])
            self.assertEqual(follow.call_args.args[0][1:5], ['training', 'run', 'exp_existing', 'run_existing'])

    def test_script_resume_is_one_controller_call_and_status_never_reads_spec(self):
        with patch('gear_training.cli.subprocess.run') as run, patch('gear_training.cli._follow', return_value=0) as follow:
            main(['resume', 'script_existing', '--config', 'c.json', '--gear-command', '["gear-refine"]'])
            run.assert_not_called()
            self.assertEqual(follow.call_args.args[0][1:4], ['training', 'resume', 'script_existing'])
            main(['status', 'exp_existing', '--config', 'c.json', '--gear-command', '["gear-refine"]'])
            self.assertEqual(follow.call_args.args[0][1:4], ['training', 'status', 'exp_existing'])

    def test_duplicate_source_rejected_and_child_failure_propagates(self):
        with self.assertRaises(ValueError): prepare_spec({'trainer': {'script': {'entrypoint': 'a:b'}}, 'scriptSource': {'directory': 'x'}})
        with patch('gear_training.cli._follow', return_value=7):
            self.assertEqual(main(['run', 'exp_x', 'run_x', '--config', 'c.json']), 7)

    def test_old_spelling_delegates_to_same_entry(self):
        with patch('gear_training.dev_launcher.controller_main', return_value=0) as unified:
            legacy_main(['--spec', 'tb21.json', '--config', 'c.json'])
            self.assertEqual(unified.call_args.args[0], ['run', 'tb21.json', '--config', 'c.json'])
            legacy_main(['--experiment', 'exp_x', '--run', 'run_x', '--resume', '--config', 'c.json'])
            self.assertEqual(unified.call_args.args[0], ['resume', 'exp_x', 'run_x', '--config', 'c.json'])


if __name__ == '__main__': unittest.main()
