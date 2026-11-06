import json
import os
import unittest
from unittest.mock import patch

from gear.benchmark.limits import DEFAULT_LIMITS, LIMITS_ENV, benchmark_limits
from gear.benchmark.payload import Payload
from gear.benchmark.source import BenchmarkError


class BenchmarkLimitsTests(unittest.TestCase):
    def test_overrides_preserve_unselected_defaults(self):
        with patch.dict(os.environ, {LIMITS_ENV: '{"maxFiles": 300000}'}):
            self.assertEqual(benchmark_limits(), {**DEFAULT_LIMITS, "maxFiles": 300000})

    def test_invalid_budgets_fail_before_reading_payload(self):
        cases = [None, [], 1, {"unknown": 1}, {"maxFiles": 0}, {"maxFiles": -1},
                 {"maxFiles": 1.5}, {"maxFiles": True}, {"maxFiles": 2**53},
                 {"authorTimeoutMs": 2**31}, {"maxFiles": float("nan")},
                 {"maxFiles": float("inf")}]
        for value in cases:
            with self.subTest(value=value), patch.dict(os.environ, {LIMITS_ENV: json.dumps(value)}):
                with self.assertRaises(BenchmarkError):
                    Payload()

    def test_integral_json_floats_are_normalized(self):
        with patch.dict(os.environ, {LIMITS_ENV: '{"maxFiles":3e5,"maxDirectories":1.0}'}):
            limits = benchmark_limits()
            self.assertEqual(limits["maxFiles"], 300000)
            self.assertEqual(limits["maxDirectories"], 1)
            self.assertTrue(all(type(value) is int for value in limits.values()))

    def test_file_budget_includes_repeated_content(self):
        with patch.dict(os.environ, {LIMITS_ENV: '{"maxFiles": 2}'}):
            payload = Payload()
            payload.add("one", b"shared")
            payload.add("two", b"shared")
            self.assertEqual(len(payload.blobs), 1)
            with self.assertRaisesRegex(BenchmarkError, "maxFiles"):
                payload.add("three", b"shared")


if __name__ == "__main__":
    unittest.main()
