import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gear_training.dev_launcher import main, prepare_spec


class LauncherTests(unittest.TestCase):
    def test_preserves_real_refs_and_original_input(self):
        original = {"trainer": {"runtimeLock": {"digest": "real"}}, "initialModel": {"uri": "cas:real"}}
        selected = prepare_spec(original)
        self.assertEqual(selected["initialModel"], original["initialModel"])
        self.assertEqual(selected["trainer"]["runtimeLock"], original["trainer"]["runtimeLock"])
        self.assertEqual(selected["trainer"]["pipeline"], "four-stage")
        self.assertNotIn("pipeline", original["trainer"])
        with self.assertRaises(ValueError):
            prepare_spec({**original, "stages": {"taskSource": {"runner": "custom"}}})

    def test_launches_selected_spec_without_shell_or_modifying_source(self):
        with tempfile.TemporaryDirectory(prefix="gear launcher ") as directory:
            spec = Path(directory) / "dev spec.json"
            spec.write_text(json.dumps({"trainer": {}, "name": "dev"}))
            observed = []
            def follow(argv):
                self.assertEqual(argv[:4], ["node", "a path/cli.js", "training", "run"])
                observed.append(json.loads(Path(argv[4]).read_text()))
                return 0
            with patch("gear_training.dev_launcher._follow", side_effect=follow):
                self.assertEqual(main(["--spec", str(spec), "--config", str(Path(directory)/"config.json"),
                                       "--gear-command", '["node", "a path/cli.js"]']), 0)
            self.assertEqual(observed[0]["trainer"]["pipeline"], "four-stage")
            self.assertEqual(json.loads(spec.read_text())["trainer"], {})

    def test_resume_checks_frozen_recipe_then_resumes_existing_ids(self):
        with patch("gear_training.dev_launcher.subprocess.run") as run, patch("gear_training.dev_launcher._follow", return_value=0) as follow:
            run.return_value.stdout = json.dumps({"spec": {"trainer": {"pipeline": "four-stage"}}})
            main(["--experiment", "exp_existing", "--run", "run_existing", "--resume", "--config", "controller.json"])
            self.assertEqual(run.call_args_list[0].args[0][1:4], ["training", "status", "exp_existing"])
            self.assertEqual(run.call_args_list[1].args[0][1:5], ["training", "resume", "exp_existing", "run_existing"])
            self.assertEqual(follow.call_args.args[0][1:5], ["training", "run", "exp_existing", "run_existing"])
            run.return_value.stdout = json.dumps({"spec": {"trainer": {}}})
            with self.assertRaises(SystemExit):
                main(["--experiment", "exp_legacy", "--run", "run_old", "--config", "controller.json"])
