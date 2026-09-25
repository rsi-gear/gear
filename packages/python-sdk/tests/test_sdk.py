import importlib.util
from pathlib import Path
import tempfile
import unittest

from gear_algorithm import (AlgorithmDecision, AlgorithmManifest, ArtifactRef, DurableLocalProvider, ProviderManifest, OperationIntent, ValidationError,
                            check_durable_provider, check_repeated_usage, check_unreleased_cancel, MemoryArtifactBridge,
                            assert_schema, validate_json, validate_schema)

EXAMPLE = Path(__file__).parents[3] / "examples/algorithms/python-provider/provider.py"


class SdkTests(unittest.TestCase):
    def test_json_and_schema_negative(self):
        for value in (float("nan"), 2**53, {"__proto__": 1}, chr(0xD800)):
            with self.assertRaises(ValidationError):
                validate_json(value)
        with self.assertRaises(ValidationError):
            assert_schema({"type": "any", "minimum": 0})
        with self.assertRaises(ValidationError):
            validate_schema({"type": "integer", "enum": [True]}, 1)
        with self.assertRaises(ValidationError):
            validate_schema({"type": "object", "properties": {"x": {"type": "integer"}},
                             "required": ["x"], "additionalProperties": False}, {"x": "1"})

    def test_parallel_key_uniqueness(self):
        with self.assertRaises(ValidationError):
            AlgorithmDecision(None, (OperationIntent("same", "a", 1), OperationIntent("same", "b", 2))).to_wire()

    def test_projection_manifest_and_decision_wire_contract(self):
        base = ("projector", {"type": "object"}, {"type": "object"}, {"id": "empty", "slots": {}})
        self.assertNotIn("requiredProjectionSchemas", AlgorithmManifest(*base).to_wire())
        declared = AlgorithmManifest(*base, requiredProjectionSchemas=("science.v1", "archive.v1"))
        self.assertEqual(declared.to_wire()["requiredProjectionSchemas"], ["science.v1", "archive.v1"])
        for invalid in (("science.v1", "science.v1"), ("",), (1,), "science.v1"):
            with self.assertRaisesRegex(ValidationError, "requiredProjectionSchemas"):
                AlgorithmManifest(*base, requiredProjectionSchemas=invalid).to_wire()
        self.assertNotIn("projections", AlgorithmDecision({}).to_wire())
        projection = ArtifactRef("a" * 64, 2, "application/json", "science.v1")
        self.assertEqual(AlgorithmDecision({}, projections=(projection,)).to_wire()["projections"],
                         [projection.to_wire()])
        with self.assertRaisesRegex(ValidationError, "projections"):
            AlgorithmDecision({}, projections=(ArtifactRef("a" * 64, 2, "application/json"),)).to_wire()

    def test_optional_budget_clock_intent_requires_a_real_boolean(self):
        self.assertNotIn("startsBudgetClock", OperationIntent("one", "a", {}).to_wire())
        self.assertIs(OperationIntent("one", "a", {}, startsBudgetClock=False).to_wire()["startsBudgetClock"], False)
        self.assertIs(OperationIntent("one", "a", {}, startsBudgetClock=True).to_wire()["startsBudgetClock"], True)
        for invalid in (0, 1, "true"):
            with self.assertRaisesRegex(ValidationError, "startsBudgetClock must be a boolean"):
                OperationIntent("one", "a", {}, startsBudgetClock=invalid).to_wire()

    def test_external_usage_and_unreleased_cancel_probes(self):
        class External:
            def inspect(self, request):
                return {"status": "running", "receipt": {"source": "external", "scope": "operation",
                        "operationId": request["operationId"], "cursor": "1", "cumulative": {"tokens": 3}}}
            def cancel(self, request):
                return {"status": "cancelled", "releaseConfirmed": False}
        request = {"operationId": "op"}
        check_repeated_usage(External(), request)
        check_unreleased_cancel(External(), request)
        class Incorrect(External):
            def cancel(self, request):
                return {"status": "cancelled", "releaseConfirmed": True}
        with self.assertRaises(AssertionError):
            check_unreleased_cancel(Incorrect(), request)

    def test_started_provider_stays_unknown_and_checks_full_identity(self):
        class Failing(DurableLocalProvider):
            calls = 0
            def execute(self, request):
                self.calls += 1
                raise RuntimeError("lost local computation")
        with tempfile.TemporaryDirectory() as root:
            manifest = ProviderManifest("toy.fail", {"type": "object"}, {"type": "object"})
            provider = Failing(manifest, root)
            request = {"operationId": "op", "idempotencyKey": "key", "inputDigest": "a" * 64,
                       "implementationDigest": "b" * 64, "kind": "toy.fail", "input": {}}
            with self.assertRaises(RuntimeError):
                provider.submit(request)
            restarted = Failing(manifest, root)
            self.assertEqual(restarted.inspect(request), {"status": "unknown"})
            self.assertEqual(restarted.cancel(request), {"status": "unknown"})
            with self.assertRaises(ValidationError):
                restarted.submit(request)
            self.assertEqual(restarted.calls, 0)
            for field in ("operationId", "inputDigest", "implementationDigest"):
                drift = dict(request, **{field: "changed"})
                with self.assertRaises(ValidationError):
                    restarted.inspect(drift)

    def test_explicit_execution_error_is_sealed_and_replayed(self):
        class Failed(DurableLocalProvider):
            calls = 0
            def execute(self, request):
                self.calls += 1
                return {"kind": "error", "code": "DATASET_INVALID",
                        "message": "task payload failed validation", "retryable": False}
        with tempfile.TemporaryDirectory() as root:
            manifest = ProviderManifest("toy.error", {"type": "object"}, {"type": "object"})
            request = {"operationId": "op", "idempotencyKey": "key", "inputDigest": "a" * 64,
                       "implementationDigest": "b" * 64, "kind": "toy.error", "input": {}}
            first = Failed(manifest, root)
            completed = first.submit(request)
            self.assertEqual(completed["completion"]["outcome"]["code"], "DATASET_INVALID")
            restarted = Failed(manifest, root)
            self.assertEqual(restarted.inspect(request), completed)
            self.assertEqual(restarted.submit(request), completed)
            self.assertEqual(restarted.calls, 0)

    def test_cancelled_before_submit_is_durable_and_never_executes(self):
        class Counted(DurableLocalProvider):
            calls = 0
            def execute(self, request):
                self.calls += 1
                return {"kind": "result", "value": {}}
        with tempfile.TemporaryDirectory() as root:
            manifest = ProviderManifest("toy.cancel", {"type": "object"}, {"type": "object"})
            request = {"operationId": "op", "idempotencyKey": "key", "inputDigest": "a" * 64,
                       "implementationDigest": "b" * 64, "kind": "toy.cancel", "input": {}}
            first = Counted(manifest, root)
            zero = {"source": "toy.cancel", "scope": "operation", "operationId": "op",
                    "cursor": "cancelled-before-start", "cumulative": {}}
            self.assertEqual(first.cancel(request), {"status": "cancelled", "releaseConfirmed": True,
                                                     "receipt": zero})
            restarted = Counted(manifest, root)
            self.assertEqual(restarted.inspect(request), {"status": "cancelled", "releaseConfirmed": True,
                                                          "receipt": zero})
            with self.assertRaisesRegex(ValidationError, "cancelled"):
                restarted.submit(request)
            self.assertEqual(restarted.calls, 0)

    def test_metered_cancel_has_zero_final_receipt_and_success_requires_usage(self):
        class Metered(DurableLocalProvider):
            calls = 0
            def execute(self, request):
                self.calls += 1
                return {"kind": "result", "value": {}}
            def usage_receipt(self, request, outcome):
                return {"source": "host-budget", "scope": "operation", "operationId": request["operationId"],
                        "cursor": "finished", "cumulative": {"tokens": 2}}
        manifest = ProviderManifest("toy.metered", {"type": "object"}, {"type": "object"},
                                    meteredDimensions=("tokens",))
        request = {"operationId": "op", "idempotencyKey": "key", "inputDigest": "a" * 64,
                   "implementationDigest": "b" * 64, "kind": "toy.metered", "input": {}}
        with tempfile.TemporaryDirectory() as root:
            provider = Metered(manifest, root, metering_source="host-budget")
            cancelled = provider.cancel(request)
            self.assertEqual(cancelled["receipt"]["cumulative"], {"tokens": 0})
            self.assertEqual(cancelled["receipt"]["source"], "host-budget")
            self.assertEqual(Metered(manifest, root, metering_source="host-budget").inspect(request), cancelled)
        with tempfile.TemporaryDirectory() as root:
            provider = Metered(manifest, root, metering_source="host-budget")
            completed = provider.submit(request)["completion"]
            self.assertEqual(completed["receipt"]["cumulative"], {"tokens": 2})

    def test_fake_provider_durable_and_no_candidate(self):
        spec = importlib.util.spec_from_file_location("fake_provider_test", EXAMPLE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as root:
            bridge = MemoryArtifactBridge()
            def factory():
                instance = module.FakeTrainer(root)
                instance.bind_artifacts(bridge.client())
                return instance
            base = {"operationId": "op", "idempotencyKey": "key", "inputDigest": "a" * 64,
                    "implementationDigest": "b" * 64, "kind": "training.fake_sft_dpo",
                    "input": {"mode": "dpo", "samples": 2}}
            result = check_durable_provider(factory, base)
            self.assertEqual(result["outcome"]["kind"], "result")
            ref = result["outcome"]["value"]["checkpoint"]
            self.assertEqual(bridge.client().read(__import__("gear_algorithm").ArtifactRef(
                digest=ref["digest"], size=ref["size"], mediaType=ref["mediaType"], schemaId=ref["schemaId"])),
                b'{"fakeWeights": 2, "mode": "dpo"}')
            empty = dict(base, idempotencyKey="empty", inputDigest="c" * 64,
                         input={"mode": "sft", "samples": 0})
            self.assertEqual(check_durable_provider(factory, empty)["outcome"]["kind"], "no-result")


if __name__ == "__main__":
    unittest.main()
