import json
import os
import subprocess
import unittest
from unittest.mock import patch

from gear_training.gpu_visibility import slime_device_environment, verify_visible_devices


class GpuVisibilityTests(unittest.TestCase):
    def result(self, rows):
        return subprocess.CompletedProcess([], 0, stdout=json.dumps(rows))

    def test_resolves_requested_uuids_in_order_without_reusing_a_parent_mask(self):
        rows = [{"uuid": "GPU-a", "ordinal": 0}, {"uuid": "GPU-b", "ordinal": 1}, {"uuid": "GPU-c", "ordinal": 2}]
        with patch.dict(os.environ, {"CUDA_VISIBLE_DEVICES": "2,0", "NVIDIA_VISIBLE_DEVICES": "GPU-a,GPU-c"}), \
                patch("gear_training.gpu_visibility.subprocess.run", return_value=self.result(rows)) as query:
            result = slime_device_environment(["GPU-c", "GPU-a"])
        self.assertEqual(result, {"CUDA_DEVICE_ORDER": "PCI_BUS_ID", "CUDA_VISIBLE_DEVICES": "2,0"})
        env = query.call_args.kwargs["env"]
        self.assertNotIn("CUDA_VISIBLE_DEVICES", env)
        self.assertEqual(env["NVIDIA_VISIBLE_DEVICES"], "GPU-a,GPU-c")
        self.assertEqual(env["CUDA_DEVICE_ORDER"], result["CUDA_DEVICE_ORDER"])

    def test_missing_duplicate_and_ambiguous_devices_fail_closed(self):
        cases = [([{"uuid": "GPU-a", "ordinal": 0}], ["GPU-b"]),
                 ([{"uuid": "GPU-a", "ordinal": 0}], ["GPU-a", "GPU-a"]),
                 ([{"uuid": "GPU-a", "ordinal": 0}, {"uuid": "GPU-a", "ordinal": 1}], ["GPU-a"]),
                 ([{"uuid": "GPU-a", "ordinal": 0}, {"uuid": "GPU-b", "ordinal": 0}], ["GPU-a"])]
        for rows, requested in cases:
            with self.subTest(rows=rows, requested=requested), \
                    patch("gear_training.gpu_visibility.subprocess.run", return_value=self.result(rows)), \
                    self.assertRaises(Exception):
                slime_device_environment(requested)

    def test_driver_rechecks_actual_visibility_before_training(self):
        rows = [{"uuid": "GPU-c", "ordinal": 0}, {"uuid": "GPU-a", "ordinal": 1}]
        with patch("gear_training.gpu_visibility.subprocess.run", return_value=self.result(rows)):
            verify_visible_devices(["GPU-c", "GPU-a"])
            for wrong in (["GPU-a", "GPU-c"], ["GPU-c"], ["GPU-b", "GPU-a"]):
                with self.subTest(wrong=wrong), self.assertRaisesRegex(Exception, "visibility differs"):
                    verify_visible_devices(wrong)


if __name__ == "__main__": unittest.main()
