import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from episode_fixture import EpisodeFixture
from gear_training.content import atomic_json
from gear_training.export import dataset_destination, materialize, seal_directory
from gear_training.hitch import HitchClient, frozen_harness_ref
from gear_training.recovery import reconcile_slots


class SubmissionRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_lost_submit_reply_reuses_the_original_named_or_legacy_dataset(self):
        for version in (1, 2):
            with self.subTest(snapshot_version=version), tempfile.TemporaryDirectory() as root:
                fixture = EpisodeFixture(root)
                try:
                    source = Path(root) / "named-training-task"
                    source.mkdir()
                    (source / "task.toml").write_text('version = "1"\n')
                    ref = seal_directory(fixture.store, source, dataset=True)
                    manifest = fixture.store.read_json(ref)
                    if version == 1:
                        manifest = {"schemaVersion": 1, "format": "harbor-dataset", "files": manifest["files"]}
                        ref = fixture.store.put_json(manifest)
                    destination = dataset_destination(manifest, fixture.directory / "datasets" / ref["digest"][7:])
                    materialize(fixture.store, ref, destination)
                    slot = fixture.directory / "slots" / "original-slot"
                    binding = {"bindingId": "original-policy-binding"}
                    atomic_json(slot / "binding.json", binding)
                    atomic_json(slot / "intent.json", {"context": {"batchId": "batch-0", "taskRef": ref},
                                                       "binding": binding, "key": "original-submit-key"})
                    request = {"fixedHarness": {"adapter": "training-tool", "commit": "a" * 40}}
                    config = {"storeRoot": str(fixture.store.root), "hitchCommand": ["fixture-hitch"],
                              "hitchRoot": str(Path(root) / "hitch"), "hitchPath": str(Path(root) / "hitch-source"), "episodeTimeoutSeconds": 30}
                    # Record the accepted public CLI arguments, then lose the reply
                    # before handle.json is written. Hitch requires an exact retry.
                    calls = []
                    async def hitch_call(args, *unused, **kwargs):
                        calls.append(args)
                        if len(calls) == 1:
                            raise OSError("submit response lost")
                        self.assertEqual(args, calls[0])
                        return {"eval_id": "original-eval"}
                    with patch.object(HitchClient, "call", side_effect=hitch_call), \
                         patch.object(HitchClient, "cancel", new_callable=AsyncMock) as cancel, \
                         patch.object(HitchClient, "inspect", new_callable=AsyncMock,
                                      return_value={"result": {"done": True}, "control": {"state": "completed"}}):
                        client = HitchClient(config["hitchCommand"], config["hitchRoot"])
                        with self.assertRaises(OSError):
                            await client.submit(dataset=destination, harness=frozen_harness_ref(request, config),
                                binding_path=slot / "binding.json", binding=binding, key="original-submit-key", timeout_seconds=30)
                        await reconcile_slots(fixture.directory, request, config)
                        cancel.assert_awaited_once_with("original-eval")
                    self.assertEqual(len(calls), 2)
                    self.assertEqual(fixture.ledger.lease("batch-0")["state"], "closed")
                finally:
                    fixture.close()
