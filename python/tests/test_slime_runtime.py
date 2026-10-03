import unittest
from types import SimpleNamespace
from unittest.mock import patch

from gear_training.slime_runtime import logging_api


class SlimeLoggingApiTests(unittest.TestCase):
    def test_old_layout(self):
        api = SimpleNamespace(configure_logger=object(), init_tracking=object(), finish_tracking=object())
        with patch("gear_training.slime_runtime.import_module", return_value=api) as load:
            self.assertEqual(logging_api(), (api.configure_logger, api.init_tracking, api.finish_tracking))
        load.assert_called_once_with("slime.utils.logging_utils")

    def test_moved_layout(self):
        api = SimpleNamespace(configure_logger=object(), init_tracking=object(), finish_tracking=object())
        missing = ModuleNotFoundError(name="slime.utils.logging_utils")
        with patch("gear_training.slime_runtime.import_module", side_effect=[missing, api]) as load:
            self.assertEqual(logging_api(), (api.configure_logger, api.init_tracking, api.finish_tracking))
        self.assertEqual([call.args[0] for call in load.call_args_list],
                         ["slime.utils.logging_utils", "slime.observability.logging_utils"])

    def test_missing_dependency_is_not_hidden(self):
        missing = ModuleNotFoundError(name="wandb")
        with patch("gear_training.slime_runtime.import_module", side_effect=missing) as load:
            with self.assertRaises(ModuleNotFoundError) as caught:
                logging_api()
        self.assertIs(caught.exception, missing)
        self.assertEqual(load.call_count, 1)


class SlimeLogprobOffloadTests(unittest.TestCase):
    def runtime(self, function):
        from contextlib import contextmanager
        import sys
        events = []

        @contextmanager
        def save_on_cpu(*, pin_memory):
            events.append(("enter", pin_memory))
            try:
                yield
            finally:
                events.append(("exit", pin_memory))

        actor = SimpleNamespace(get_log_probs_and_entropy=function)
        loss = SimpleNamespace(get_log_probs_and_entropy=function)
        modules = {
            "slime": SimpleNamespace(), "slime.backends": SimpleNamespace(),
            "slime.backends.megatron_utils": SimpleNamespace(actor=actor, loss=loss),
            "torch": SimpleNamespace(autograd=SimpleNamespace(graph=SimpleNamespace(save_on_cpu=save_on_cpu))),
        }
        return patch.dict(sys.modules, modules), actor, loss, events

    def test_scope_preserves_arguments_result_and_shared_alias(self):
        from gear_training.slime_runtime import offload_logprob_backward
        expected = object()
        original = lambda *args, **kw: (args, kw, expected)
        patched, actor, loss, events = self.runtime(original)
        with patched:
            offload_logprob_backward(SimpleNamespace(log_probs_chunk_size=256), [], "actor")
            self.assertIs(actor.get_log_probs_and_entropy, loss.get_log_probs_and_entropy)
            self.assertEqual(loss.get_log_probs_and_entropy(12, with_entropy=True), ((12,), {"with_entropy": True}, expected))
            installed = loss.get_log_probs_and_entropy
            offload_logprob_backward(SimpleNamespace(log_probs_chunk_size=256), [], "ref")
            self.assertIs(installed, loss.get_log_probs_and_entropy)
            self.assertEqual(events, [("enter", True), ("exit", True)])

    def test_dependency_exception_leaves_context_without_hiding_error(self):
        from gear_training.slime_runtime import offload_logprob_backward
        error = RuntimeError("native failure")
        def fail():
            raise error
        patched, actor, loss, events = self.runtime(fail)
        with patched:
            offload_logprob_backward(SimpleNamespace(log_probs_chunk_size=256), [], "actor")
            with self.assertRaises(RuntimeError) as caught:
                loss.get_log_probs_and_entropy()
            self.assertIs(caught.exception, error)
            self.assertEqual(events, [("enter", True), ("exit", True)])

    def test_rejects_unchunked_or_inconsistent_runtime_without_patching(self):
        from gear_training.slime_runtime import offload_logprob_backward
        original = lambda: None
        patched, actor, loss, _ = self.runtime(original)
        with patched:
            with self.assertRaises(ValueError):
                offload_logprob_backward(SimpleNamespace(log_probs_chunk_size=-1), [], "actor")
            self.assertIs(loss.get_log_probs_and_entropy, original)
            actor.get_log_probs_and_entropy = lambda: None
            with self.assertRaises(RuntimeError):
                offload_logprob_backward(SimpleNamespace(log_probs_chunk_size=256), [], "actor")
            self.assertIs(loss.get_log_probs_and_entropy, original)
