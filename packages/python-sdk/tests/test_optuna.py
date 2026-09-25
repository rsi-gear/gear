import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gear_algorithm import MemoryArtifactBridge, ValidationError


@unittest.skipUnless(importlib.util.find_spec("optuna"), "optional Optuna is not installed")
class OptunaAdapterTests(unittest.TestCase):
    def test_constructor_rejects_incompatible_optuna_at_check_time(self):
        import optuna
        from gear_algorithm.adapters.optuna import OptunaAskProvider
        with patch.object(optuna, "__version__", "0.0.0"):
            with self.assertRaisesRegex(ValidationError, "requires 4.9.0"):
                OptunaAskProvider(checkpoint_key=b"version-check-key-32bytes-minimum!!")

    def test_two_ask_evaluate_tell_steps_and_restart(self):
        from gear_algorithm.adapters.optuna import OptunaAskProvider, OptunaTellProvider

        with tempfile.TemporaryDirectory() as directory:
            bridge = MemoryArtifactBridge()
            key = b"optuna-provider-test-key-32bytes!!"
            def ask_provider():
                return OptunaAskProvider(checkpoint_key=key, record_dir=str(Path(directory, "ask")),
                                         artifacts=bridge.client())
            def tell_provider():
                return OptunaTellProvider(checkpoint_key=key, record_dir=str(Path(directory, "tell")),
                                          artifacts=bridge.client())
            configuration = {"studyName": "two-trials", "direction": "minimize", "sampler": "random",
                             "seed": 7, "space": {"x": {"type": "float", "low": -1.0, "high": 1.0}}}
            def request(kind, key_name, input_value):
                return {"operationId": key_name, "idempotencyKey": key_name, "inputDigest": key_name * 64,
                        "implementationDigest": "a" * 64, "kind": kind, "input": input_value}

            first_ask = request("optuna.ask", "1", configuration)
            first = ask_provider().submit(first_ask)
            self.assertEqual(first["status"], "completed")
            trial0 = first["completion"]["outcome"]["value"]
            self.assertEqual(trial0["trialNumber"], 0)
            self.assertEqual(ask_provider().inspect(first_ask), first)
            self.assertEqual(ask_provider().submit(first_ask), first)
            score0 = (trial0["params"]["x"] - 0.25) ** 2

            first_tell = request("optuna.tell", "2", {
                "checkpointRef": trial0["checkpointRef"], "trialNumber": 0,
                "state": "COMPLETE", "value": score0,
            })
            told0 = tell_provider().submit(first_tell)
            self.assertEqual(tell_provider().inspect(first_tell), told0)
            checkpoint1 = told0["completion"]["outcome"]["value"]["checkpointRef"]
            second_ask = request("optuna.ask", "3", {**configuration, "checkpointRef": checkpoint1})
            trial1 = ask_provider().submit(second_ask)["completion"]["outcome"]["value"]
            self.assertEqual(trial1["trialNumber"], 1)
            score1 = (trial1["params"]["x"] - 0.25) ** 2
            second_tell = request("optuna.tell", "4", {
                "checkpointRef": trial1["checkpointRef"], "trialNumber": 1,
                "state": "COMPLETE", "value": score1,
            })
            told1 = tell_provider().submit(second_tell)
            self.assertEqual(told1["completion"]["outcome"]["value"]["bestValue"], min(score0, score1))
            self.assertEqual(ask_provider().inspect(second_ask)["completion"]["outcome"]["value"], trial1)

    def test_checkpoint_authentication_and_running_trial_guard(self):
        from gear_algorithm.adapters.optuna import OptunaAskProvider, OptunaTellProvider

        with tempfile.TemporaryDirectory() as directory:
            bridge = MemoryArtifactBridge()
            key = b"optuna-provider-test-key-32bytes!!"
            ask = OptunaAskProvider(checkpoint_key=key, record_dir=str(Path(directory, "ask")),
                                    artifacts=bridge.client())
            initial = {"studyName": "guard", "direction": "minimize", "sampler": "random",
                       "seed": 4, "space": {"x": {"type": "int", "low": 0, "high": 3}}}
            request = {"operationId": "one", "idempotencyKey": "one", "inputDigest": "a" * 64,
                       "implementationDigest": "b" * 64, "kind": "optuna.ask", "input": initial}
            ref = ask.submit(request)["completion"]["outcome"]["value"]["checkpointRef"]
            with self.assertRaises(ValidationError):
                ask.execute({**request, "input": {**initial, "checkpointRef": ref}})
            other = OptunaTellProvider(checkpoint_key=b"different-provider-checkpoint-key!!",
                                       record_dir=str(Path(directory, "other")), artifacts=bridge.client())
            with self.assertRaisesRegex(ValidationError, "authentication"):
                other.execute({"input": {"checkpointRef": ref, "trialNumber": 0,
                                          "state": "COMPLETE", "value": 1.0}})


if __name__ == "__main__":
    unittest.main()
