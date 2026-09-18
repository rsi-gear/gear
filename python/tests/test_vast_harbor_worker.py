"""CPU-only tests of paid-instance and diagnostic-copy boundaries."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / "probes/vast_harbor_worker.py"
spec = importlib.util.spec_from_file_location("vast_harbor_worker", source)
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)


class VastHarborWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.inputs = self.root / "inputs"
        self.overlay = self.root / "overlay"
        self.inputs.mkdir()
        self.overlay.mkdir()
        payload = self.inputs / "payload.bin"
        payload.write_bytes(b"fixed installation input")
        manifest = {"kind": "remote-harbor-installation-inputs", "validated": False,
                    "expectedRuntime": {}, "files": {"payload.bin": {"bytes": payload.stat().st_size, "sha256": vm.sha(payload)}}}
        vm.write_json(self.inputs / "worker-inputs.json", manifest)
        (self.inputs / "worker-inputs.sha256").write_text(f"{vm.sha(payload)}  payload.bin\n")
        body = b"console.log('diagnostic fixture');"
        with tarfile.open(self.overlay / "worker-canary-overlay.tar.gz", "w:gz") as archive:
            item = tarfile.TarInfo("dist/scripts/canary-worker-peer.js")
            item.size = len(body)
            archive.addfile(item, io.BytesIO(body))
        vm.write_json(self.overlay / "worker-canary-overlay.json", {
            "archiveSha256": vm.sha(self.overlay / "worker-canary-overlay.tar.gz"),
            "files": {"dist/scripts/canary-worker-peer.js": {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}},
        })

    def test_price_rejects_unknown_nonfinite_and_over_cap(self):
        self.assertEqual(vm.price(0.12), 0.12)
        for value in [None, "0.09", True, -0.01, 0.12001, float("nan"), float("inf")]:
            with self.subTest(value=value), self.assertRaises(AssertionError):
                vm.price(value)

    def test_instance_label_id_and_model_exclusion(self):
        rows = [{"id": 11, "label": "model"}, {"id": 12, "label": "owned"}]
        self.assertEqual(vm.owned_instance(rows, "owned", 11, 12)["id"], 12)
        for source_rows, label, expected in [(rows, "model", None), (rows, "owned", 99), (rows + [rows[1]], "owned", None)]:
            with self.assertRaises(AssertionError):
                vm.owned_instance(source_rows, label, 11, expected)

    def test_stop_only_owned_vm_and_require_actual_stopped_state(self):
        running = {"id": 12, "label": "owned", "actual_status": "running", "cur_state": "running", "intended_status": "stopped"}
        terminal = {**running, "actual_status": "exited", "cur_state": "stopped"}
        self.assertFalse(vm.stopped(running))
        with patch.object(vm, "instances", side_effect=[[running], [terminal]]), patch.object(vm, "call") as command:
            result = vm.stop_owned("vast-fixture", "owned", 11, 12)
        self.assertEqual(result["id"], 12)
        command.assert_called_once_with(["vast-fixture", "stop", "instance", "12", "--raw"], timeout=30)

    def test_missing_instance_is_not_release_confirmation(self):
        with patch.object(vm, "instances", return_value=[]), patch.object(vm, "call") as command:
            self.assertIsNone(vm.stop_owned("vast-fixture", "owned", 11, 12))
        command.assert_not_called()

    def test_valid_copy_inputs_and_overlay(self):
        manifest, overlay = vm.verify_inputs(self.inputs, self.overlay)
        self.assertEqual(len(manifest["files"]), 1)
        self.assertEqual(len(overlay["files"]), 1)

    def test_changed_input_and_sha_list_rejected(self):
        (self.inputs / "worker-inputs.sha256").write_text("changed SHA list\n")
        with self.assertRaises(AssertionError):
            vm.verify_inputs(self.inputs, self.overlay)
        payload = self.inputs / "payload.bin"
        (self.inputs / "worker-inputs.sha256").write_text(f"{vm.sha(payload)}  payload.bin\n")
        payload.write_bytes(b"changed installation input")
        with self.assertRaises(AssertionError):
            vm.verify_inputs(self.inputs, self.overlay)

    def test_unsafe_manifest_names_rejected(self):
        for name in ["../file", "/file", "a//b", "a/./b", "a\nb", "", "a\0b"]:
            with self.subTest(name=name), self.assertRaises(AssertionError):
                vm.safe_relative(name)

    def test_default_execution_only_reads_and_writes_a_non_authorizing_plan(self):
        model = {"id": 11, "machine_id": 100, "label": "model", "actual_status": "exited", "cur_state": "stopped", "intended_status": "stopped"}
        offer = {"id": 20, "machine_id": 200, "vms_enabled": True, "dph_total": 0.09, "cpu_ram": 8192, "cpu_cores_effective": 2, "num_gpus": 1}
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if args[0] == "node-fixture":
                value = {}
            elif args[1:3] == ["show", "instances"]:
                value = [model]
            elif args[1:3] == ["show", "ssh-keys"]:
                value = [{"id": 1}]
            elif args[1:3] == ["search", "offers"]:
                value = [offer]
            else:
                raise AssertionError(f"unexpected command: {args}")
            return subprocess.CompletedProcess(args, 0, json.dumps(value), "")
        output = self.root / "result"
        argv = [str(source), "--vast", "vast-fixture", "--node", "node-fixture", "--hitch", str(self.root),
                "--harbor-python", "/unused/python", "--inputs", str(self.inputs), "--overlay", str(self.overlay),
                "--model-instance", "11", "--output", str(output)]
        with patch.object(vm.sys, "argv", argv), patch.object(vm, "call", side_effect=command), patch.object(vm.subprocess, "Popen") as spawn:
            self.assertEqual(vm.main(), 0)
        spawn.assert_not_called()
        self.assertFalse(json.loads((output / "plan.json").read_text())["authorizedByThisFile"])
        self.assertFalse(any(args[1] in ["create", "start", "stop", "destroy"] for args in calls))


if __name__ == "__main__":
    unittest.main()
