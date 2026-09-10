"""Canonical record comparison only; this replay does not admit GPU training data."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from gear_training.content import ContentStore, ContractError
from gear_training.hitch import validate_training_run


class CanonicalHitchTests(unittest.TestCase):
    def test_real_harbor_resolved_commit_and_all_frozen_identities(self):
        fixture = Path(__file__).parent / "fixtures/hitch-native-canonical.json"
        evidence = json.loads(fixture.read_text())
        loaded, expected = evidence["loaded"], evidence["expected"]
        with tempfile.TemporaryDirectory() as root:
            store = ContentStore(root)
            context = {**expected["context"], "environmentRef": store.put_json(expected["environment"]),
                       "harnessRef": store.put_json({"hitch": expected["harness"]})}
            def validate(record):
                return validate_training_run(store, record, context, expected["evalId"], expected["submittedHarnessRef"])
            self.assertEqual(validate(loaded)["observation"], {"status": "valid", "reward": 0, "verifier_result_ref": "verifier/result.json"})
            # Legacy raw refs remain accepted; normalized refs must retain the
            # complete commit, artifact and source-derived revision identity.
            legacy = copy.deepcopy(loaded)
            legacy["record"]["harness"]["requested_ref"] = expected["submittedHarnessRef"]
            validate(legacy)
            changes = [("harness", "requested_ref", "training-tool@commit:" + "f" * 40),
                       ("harness", "requested_ref", "training-tool@commit:e32ec88"),
                       ("harness", "artifact_id", "sha256:" + "f" * 64),
                       ("harness", "revision_identity", "sha256:" + "f" * 64),
                       ("context", "verifier_identity", "sha256:" + "f" * 64),
                       ("model", "effective_id", "another-policy")]
            for section, field, value in changes:
                with self.subTest(field=field):
                    changed = copy.deepcopy(loaded)
                    changed["record"][section][field] = value
                    with self.assertRaises(ContractError) as rejected: validate(changed)
                    self.assertEqual(rejected.exception.code, "training-canonical-identity-drift")
