"""CPU contract fixtures; these deliberately do not certify any real runtime."""
import copy
import tempfile
import unittest
from pathlib import Path
from gear_training.certification import REQUIRED, certify, inspect_certificate, missing_checks, scope
from gear_training.content import ContentStore, ContractError, digest_bytes, digest_json
from test_placement import request_fixture


class CertificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.store = ContentStore(self.root / 'cas')
        self.request = request_fixture()
        self.request.update(schemaVersion=2, fixedHarness={'commit': 'fixture', 'adapter': 'training-tool'},
            deployment={'schemaVersion': 2, 'taskExecution': {'placement': 'local', 'provider': 'local-docker', 'providerIdentityDigest': digest_json('controller')},
                'modelRuntime': {'launcher': 'process', 'nodeId': 'node', 'generation': 'boot', 'runtimeDigest': digest_json('runtime')},
                'gpuScheduling': {'actorRollout': 'colocated', 'trainEvaluation': 'sequential'}},
            trainingDevices=[{'nodeId': 'node', 'gpuUuid': 'GPU-fixture'}])
        self.request['trainer'].pop('placement')
        data = b'CPU contract fixture, NOT actual GPU evidence\n'; (self.root / 'fixture.log').write_bytes(data)
        self.audit = {'schemaVersion': 1, 'kind': 'gear-runtime-certification-audit', 'scope': scope(self.request),
            'observations': [{'check': check, 'method': method, 'passed': True,
                'artifacts': [{'path': 'fixture.log', 'size': len(data), 'sha256': digest_bytes(data)}]} for check, method in REQUIRED.items()]}

    def test_operator_audit_verifies_bytes_then_publishes_only_bounded_observations(self):
        lock = certify(self.request, self.audit, self.root, self.store)
        certificate = self.store.read_json(lock['probeEvidenceRefs'][0])
        self.assertNotIn('fixture.log', str(certificate)); self.assertNotIn('CPU contract fixture', str(certificate))
        self.assertEqual(inspect_certificate(self.request, certificate), [])
        self.request['trainer']['runtimeLock'] = lock
        self.assertEqual(missing_checks(self.request, self.store), [])

    def test_boolean_checklists_are_not_v2_certificates(self):
        self.request['trainer']['runtimeLock']['probeEvidenceRefs'] = [self.store.put_json({'schemaVersion': 1,
            'kind': 'gear-training-compatibility-probe', **scope(self.request), 'checks': dict.fromkeys(REQUIRED, True)})]
        self.assertEqual(missing_checks(self.request, self.store), sorted(REQUIRED))

    def test_cpu_method_cannot_replace_required_gpu_or_remote_process_evidence(self):
        for check in ('colocatedCheckpointRecovery', 'instanceDeadlineStop', 'remoteArtifactRetention'):
            audit = copy.deepcopy(self.audit)
            next(item for item in audit['observations'] if item['check'] == check)['method'] = 'process'
            with self.assertRaises(ContractError): certify(self.request, audit, self.root, self.store)

    def test_missing_recovery_or_isolation_never_creates_a_validated_lock(self):
        for check in ('colocatedCheckpointRecovery', 'informationIsolation', 'remoteArtifactRetention'):
            audit = copy.deepcopy(self.audit); audit['observations'] = [item for item in audit['observations'] if item['check'] != check]
            with self.assertRaisesRegex(ContractError, 'missing checks'): certify(self.request, audit, self.root, self.store)

    def test_same_size_artifact_corruption_is_rejected(self):
        path = self.root / 'fixture.log'; path.write_bytes(b'x' * path.stat().st_size)
        with self.assertRaisesRegex(ContractError, 'retained audit artifact'): certify(self.request, self.audit, self.root, self.store)

    def test_layout_model_recipe_harness_provider_and_source_changes_invalidate(self):
        certificate = self.store.read_json(certify(self.request, self.audit, self.root, self.store)['probeEvidenceRefs'][0])
        for change in (
            lambda r: r['trainingDevices'][0].update(gpuUuid='GPU-other'),
            lambda r: r['parentModel'].update(tokenizerDigest=digest_json('other tokenizer')),
            lambda r: r['trainer'].update(hyperparametersRef=self.store.put_json({'another': 'recipe'})),
            lambda r: r['trainer']['runtimeLock'].update(bridgeDigest=digest_json('changed bridge')),
            lambda r: r['fixedHarness'].update(commit='another'),
            lambda r: r['deployment']['taskExecution'].update(providerIdentityDigest=digest_json('changed provider')),
            lambda r: r['deployment']['modelRuntime'].update(generation='other-boot')):
            request = copy.deepcopy(self.request); change(request)
            with self.assertRaises(ContractError): inspect_certificate(request, certificate)

    def test_deferred_remote_harbor_and_dual_gpu_cannot_inherit_certificate(self):
        for change in (lambda r: r['deployment']['taskExecution'].update(placement='remote', provider='harbor-remote'),
                       lambda r: r['trainingDevices'].append({'nodeId': 'node', 'gpuUuid': 'GPU-second'})):
            request = copy.deepcopy(self.request); change(request)
            with self.assertRaisesRegex(ContractError, 'one process model-node GPU'): scope(request)

    def test_public_certificate_rejects_private_fields_duplicate_checks_and_failed_results(self):
        original = self.store.read_json(certify(self.request, self.audit, self.root, self.store)['probeEvidenceRefs'][0])
        for change in (lambda c: c.update(credential='secret'),
                       lambda c: c['observations'].append(copy.deepcopy(c['observations'][0])),
                       lambda c: c['observations'][0].update(passed=False)):
            c = copy.deepcopy(original); change(c)
            with self.assertRaises(ContractError): inspect_certificate(self.request, c)


if __name__ == '__main__': unittest.main()
