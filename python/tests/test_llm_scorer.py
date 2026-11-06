import io
import json
import unittest
import urllib.error
from unittest.mock import Mock, patch

from gear.benchmark.llm_scorer import (
    NoRedirect, rubric_request, score_llm, validate_llm_scorer,
)
from gear.benchmark.source import BenchmarkError


def config():
    return {
        "version": "rubric-v1", "protocol": "chat-completions@1",
        "endpoint": "https://judge.example/v1/chat/completions",
        "api_key_env": "GEAR_SCORER_TEST_API_KEY", "model": "pinned-test-model",
        "rubric": "Pass only when the output satisfies the task and reference.",
        "randomness": {"temperature": 0, "seed": 7},
        "cost": {"price_version": "fixture-prices", "input_usd_per_million": 2,
                 "cached_input_usd_per_million": 1, "output_usd_per_million": 4},
        "limits": {"max_request_bytes": 65536, "max_completion_tokens": 128, "timeout_seconds": 15},
        "artifacts": ["proof.txt"],
    }


def response(passed=True):
    return {
        "id": "test-response", "model": "pinned-test-model", "system_fingerprint": "fp_test",
        "choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"passed": passed, "reason": "fixture decision"}), "refusal": None,
        }}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
                  "prompt_tokens_details": {"cached_tokens": 40}},
    }


class LLMScorerTests(unittest.TestCase):
    def judge(self, result=None, settings=None, actual="answer", failure=None):
        settings = settings or config()
        markers = []
        opener = Mock()

        def request(req, timeout):
            self.assertEqual(markers[-1]["request_attempts"], 1)
            self.assertIsNone(markers[-1]["model_requests"])
            self.assertIsNone(markers[-1]["tokens"])
            self.assertEqual(timeout, 15)
            self.assertEqual(req.get_header("Authorization"), "Bearer test-secret")
            self.assertEqual(req.method, "POST")
            if failure:
                raise failure
            data = json.dumps(result if result is not None else response()).encode()
            return io.BytesIO(data)

        opener.open.side_effect = request
        with patch.dict("os.environ", {"GEAR_SCORER_TEST_API_KEY": "test-secret"}), patch(
            "urllib.request.build_opener", return_value=opener,
        ) as factory:
            value = score_llm(actual, "expected", settings, "task", {}, markers.append)
        self.assertNotIn("test-secret", json.dumps(value))
        return value, markers, opener, factory

    def test_static_validation_does_not_read_credentials_or_use_network(self):
        with patch("os.environ", {}), patch("urllib.request.build_opener", side_effect=AssertionError("network")):
            self.assertEqual(validate_llm_scorer(config()), config())
        for field, values in {
            "endpoint": ["http://judge.example/api", "https://user:secret@judge.example/api", "https://judge.example/api?key=secret", "https://judge.example:444/api"],
            "api_key_env": ["OPENAI_API_KEY", "PATH", "GEAR_SCORER_TEST_API_KEY\n"],
            "rubric": ["", None], "model": ["", []], "protocol": ["auto"],
            "randomness": [{"seed": True, "temperature": 0}, {"seed": 7, "temperature": float("nan")}, {"seed": 2**53, "temperature": 0}],
            "cost": [{}, {**config()["cost"], "input_usd_per_million": -1}],
            "limits": [{}, {**config()["limits"], "timeout_seconds": True}],
            "artifacts": [["../outside"], ["answer.txt"], [{}]],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(BenchmarkError):
                    settings = config()
                    settings[field] = value
                    validate_llm_scorer(settings)

    def test_request_keeps_rubric_separate_from_task_data_and_fixes_protocol(self):
        body = json.loads(rubric_request("actual", "PRIVATE", config(), "task", {"proof.txt": "file"}))
        self.assertTrue(body["response_format"]["json_schema"]["strict"])
        self.assertFalse(body["store"])
        self.assertFalse(body["stream"])
        self.assertEqual(body["n"], 1)
        self.assertEqual(body["max_completion_tokens"], 128)
        self.assertEqual(body["seed"], 7)
        self.assertEqual(json.loads(body["messages"][1]["content"])["expected"], "PRIVATE")
        settings = config()
        settings["randomness"] = {"temperature": None, "seed": None}
        body = json.loads(rubric_request("x", "y", settings, "task", {}))
        self.assertNotIn("seed", body)
        self.assertNotIn("temperature", body)

    def test_valid_zero_and_one_retain_actual_token_counts_and_price_estimate(self):
        for passed in (True, False):
            result, markers, opener, factory = self.judge(response(passed))
            self.assertEqual(result["status"], "valid")
            self.assertEqual(result["value"], float(passed))
            self.assertEqual(result["usage"]["tokens"], 120)
            self.assertEqual(result["usage"]["cached_input_tokens"], 40)
            self.assertAlmostEqual(result["usage"]["estimated_dollars"], 0.00024)
            self.assertIsNone(result["usage"]["dollars"])
            self.assertEqual([m["model_requests"] for m in markers], [0, None, 1])
            opener.open.assert_called_once()
            handlers = factory.call_args.args
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsInstance(handlers[1], NoRedirect)

    def test_missing_key_or_oversized_input_never_submits(self):
        with patch.dict("os.environ", {}, clear=True), patch("urllib.request.build_opener") as factory:
            result = score_llm("a", "b", config(), "task", {}, lambda usage: None)
            self.assertEqual(result["reason"], "judge-credentials-missing")
            self.assertEqual(result["usage"]["model_requests"], 0)
            factory.assert_not_called()
        settings = config()
        settings["limits"]["max_request_bytes"] = 1024
        result, markers, opener, factory = self.judge(settings=settings, actual="X" * 2048)
        self.assertEqual(result["reason"], "judge-input-limit")
        self.assertEqual(result["usage"]["model_requests"], 0)
        factory.assert_not_called()

    def test_transport_failure_never_retries_and_keeps_unknown_charged_usage(self):
        for error in (TimeoutError("test-secret"), urllib.error.HTTPError("https://judge.example", 429, "test-secret", {}, None)):
            result, markers, opener, _ = self.judge(failure=error)
            self.assertEqual(result["reason"], "judge-request-failed")
            self.assertIsNone(result["value"])
            self.assertIsNone(result["usage"]["model_requests"])
            self.assertEqual(result["usage"]["request_attempts"], 1)
            self.assertIsNone(result["usage"]["tokens"])
            self.assertIsNone(result["usage"]["estimated_dollars"])
            opener.open.assert_called_once()
            self.assertEqual(len(markers), 2)
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, None, None, "https://other.example"))

    def test_refusal_incomplete_invalid_content_and_model_drift_are_not_zero(self):
        mutations = [
            lambda r: r["choices"][0]["message"].update(refusal="refused"),
            lambda r: r["choices"][0].update(finish_reason="length"),
            lambda r: r["choices"][0]["message"].update(content='{"passed":1,"reason":"x"}'),
            lambda r: r["choices"][0]["message"].update(content='{"passed":true,"passed":false,"reason":"x"}'),
            lambda r: r["choices"][0]["message"].update(content='{}'),
            lambda r: r.update(model="different-model"),
            lambda r: r.update(system_fingerprint={"invalid": "object"}),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                reply = response()
                mutation(reply)
                result, _, opener, _ = self.judge(reply)
                self.assertEqual(result["status"], "scoring_failed")
                self.assertIsNone(result["value"])
                self.assertEqual(result["usage"]["tokens"], 120)
                opener.open.assert_called_once()

    def test_missing_usage_and_missing_cached_counts_are_not_filled_with_zero(self):
        reply = response()
        reply.pop("usage")
        result, _, _, _ = self.judge(reply)
        self.assertEqual(result["reason"], "judge-usage-invalid")
        self.assertIsNone(result["usage"]["tokens"])
        reply = response()
        reply["usage"].pop("prompt_tokens_details")
        result, _, _, _ = self.judge(reply)
        self.assertEqual(result["status"], "valid")
        self.assertIsNone(result["usage"]["cached_input_tokens"])
        self.assertIsNone(result["usage"]["estimated_dollars"])
        reply = response()
        reply["usage"].update(prompt_tokens=True)
        result, _, _, _ = self.judge(reply)
        self.assertEqual(result["reason"], "judge-usage-invalid")


class CompiledLLMScorerTests(unittest.TestCase):
    def test_static_compilation_freezes_rubric_and_keeps_credentials_in_verifier_scope(self):
        import tempfile
        import subprocess
        import sys
        from pathlib import Path
        from gear.benchmark import compile_benchmark
        from gear.benchmark.harbor import compile_harbor
        from gear.benchmark.probe import prepare_probe, read_probe_case

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tasks.jsonl").write_text(json.dumps({
                "id": "a", "instruction": "Task instruction", "expected": "PRIVATE", "split": "seed",
            }))
            author = {"version": 1, "source": "tasks.jsonl", "template": "llm", "scorer": config(),
                      "fixtures": {"a": [{"actual": "correct", "score": 1}, {"actual": "wrong", "score": 0}]}}
            with patch.dict("os.environ", {}, clear=True), patch("urllib.request.build_opener") as network:
                benchmark = compile_benchmark(root, author)
                self.assertEqual(benchmark["checks"]["verifier_fixtures"], "not_run")
                network.assert_not_called()
            self.assertNotIn("PRIVATE", json.dumps(benchmark["tasks"]))
            image = "python@sha256:" + "1" * 64
            compiled = compile_harbor(benchmark, str(root / "harbor"), ["a"], image)
            task = Path(compiled["directory"]) / "a"
            toml = (task / "task.toml").read_text()
            self.assertIn('[verifier.env]\nGEAR_SCORER_TEST_API_KEY = "${GEAR_SCORER_TEST_API_KEY}"', toml)
            self.assertIn('environment_mode = "separate"', toml)
            self.assertIn('network_mode = "public"', toml)
            self.assertNotIn("GEAR_SCORER_TEST_API_KEY", (task / "environment/Dockerfile").read_text())
            environment = prepare_probe(benchmark, str(root / "env-probe"), "a", image)
            self.assertFalse(environment["usage_required"])
            self.assertEqual(environment["credential_env"], [])
            plan = prepare_probe(benchmark, str(root / "probe"), "a", image, True)
            self.assertTrue(plan["usage_required"])
            self.assertEqual(plan["credential_env"], ["GEAR_SCORER_TEST_API_KEY"])
            self.assertEqual(plan["scorer_metadata"]["cost"], config()["cost"])
            case = plan["cases"][0]
            with patch.dict("os.environ", {}, clear=True):
                process = subprocess.run([sys.executable, str(Path(plan["tests"]) / "verify.py"), case["workspace"], case["logs"]], capture_output=True, text=True, timeout=10)
            self.assertEqual(process.returncode, 2, process.stderr)
            observed = read_probe_case(case["logs"], 1, True)
            self.assertEqual(observed["status"], "scoring_failed")
            self.assertEqual(observed["usage"]["request_attempts"], 0)
            self.assertEqual(observed["usage"]["model_requests"], 0)
            self.assertIn("GEAR_SCORER_USAGE", process.stdout)
            before = benchmark["digest"]
            author["scorer"]["rubric"] += " Additional requirement."
            self.assertNotEqual(before, compile_benchmark(root, author)["digest"])

    def test_probe_preserves_attempt_marker_after_a_lost_response(self):
        import tempfile
        from pathlib import Path
        from gear.benchmark.probe import read_probe_case

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertIsNone(read_probe_case(directory, 1, True)["usage"]["model_requests"])
            usage = {"request_attempts": 1, "model_requests": None, "input_tokens": None,
                     "cached_input_tokens": None, "output_tokens": None, "tokens": None,
                     "dollars": None, "estimated_dollars": None, "price_version": "v1"}
            (root / "gear-usage.json").write_text(json.dumps(usage))
            observed = read_probe_case(directory, 1, True)
            self.assertEqual(observed["status"], "scoring_failed")
            self.assertEqual(observed["usage"]["request_attempts"], 1)
            self.assertIsNone(observed["usage"]["model_requests"])
            self.assertIsNone(observed["usage"]["dollars"])
            usage["tokens"] = True
            (root / "gear-usage.json").write_text(json.dumps(usage))
            self.assertIsNone(read_probe_case(directory, 1, True)["usage"]["tokens"])
