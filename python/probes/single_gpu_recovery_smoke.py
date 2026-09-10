"""External process-kill canary; never a production admission bypass.

Observe durable boundaries without injecting hooks into Slime or the bridge.
Resume uses the same pending-gpu diagnostic request and runs every runtime check
except certification, which is the output of these probes.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import time
from unittest.mock import patch
from gear_training.content import atomic_json, digest_json, require
from gear_training.job import JobService
from gear_training.node import NodeService
from gear_training.preflight import preflight
from gear_training.recovery import process_identity, owned_alive
from gear_training.ledger import Ledger


def context(path):
    config = json.loads(Path(path).read_text()); node = NodeService(config)
    marker = json.loads((node.root / 'full-driver-diagnostic.json').read_text())
    require(marker['kind'] == 'gear-full-driver-diagnostic' and marker['validated'] is False and marker['node'] == node.identity,
            'diagnostic-identity-drift', 'use this prepared diagnostic node only')
    job_config = json.loads(Path(config['jobConfigPath']).read_text()); job_config.update(node=node.identity, nodeRoot=str(node.root))
    service = JobService(job_config); directory = service.directory(marker['handle'])
    request = json.loads((directory / 'request.json').read_text())
    require(digest_json(request) == marker['handle']['requestDigest'] and request['trainer']['runtimeLock']['validation'] == 'pending-gpu',
            'diagnostic-request-drift', 'recovery cannot change or certify its frozen request')
    return node, service, directory, request, marker['handle']


def resume(path):
    node, service, directory, request, handle = context(path)
    status = service.inspect(handle)
    require(status['execution'] in ('failed', 'interrupted', 'paused') and status['resourcesReleased'],
            'diagnostic-recovery-busy', 'old runtime must stop and release before resuming')
    key = json.loads((directory / 'diagnostic-control.json').read_text())['idempotencyKey']
    before = json.loads((directory / 'worker.json').read_text())
    original = preflight
    def checked(req, conf):
        result = original(req, conf)
        require(result['blockers'] and all(b == 'gpu-probes-pending' or b.startswith('missing-runtime-probe-evidence:') for b in result['blockers']),
                'diagnostic-runtime-check', 'only unfinished certification may be bypassed by this isolated diagnostic: ' + ','.join(result['blockers']))
        return {**result, 'blockers': []}
    with patch('gear_training.job.preflight', side_effect=checked):
        result = service.submit(request, key)
    require(result == handle, 'diagnostic-recovery-drift', 'resume must keep the original job identity')
    after = json.loads((directory / 'worker.json').read_text())
    require(after['incarnation'] != before['incarnation'], 'diagnostic-recovery-drift', 'resume must fence the previous incarnation')
    print(json.dumps({'handle': handle, 'previousIncarnation': before['incarnation'], 'incarnation': after['incarnation']}), flush=True)


def watch(path, boundary, output, timeout):
    import psutil
    node, service, directory, request, handle = context(path)
    report = {'boundary': boundary, 'handle': handle, 'node': node.identity, 'injected': False}
    output = Path(output); atomic_json(output, report)
    until = time.monotonic() + timeout
    process = None
    while time.monotonic() < until:
        # Resolve the driver before the short sealing window. Scanning every Ray
        # process after observing the boundary can itself let training start.
        if process is None or not owned_alive(process):
            candidates = []
            for item in json.loads((directory / 'owned-processes.json').read_text()) if (directory / 'owned-processes.json').exists() else []:
                if not owned_alive(item): continue
                try:
                    args = psutil.Process(item['pid']).cmdline()
                except psutil.NoSuchProcess:
                    continue
                if args[-2:] == ['-m', 'gear_training.driver']: candidates.append(item)
            process = candidates[0] if len(candidates) == 1 else None
        ledger = Ledger(directory / 'ledger.sqlite')
        try:
            commits = [dict(row) for row in ledger.db.execute('SELECT update_number,batch_digest,ref FROM commits ORDER BY update_number')]
            batch = directory / 'batch.json'; pending = directory / 'pending-update.json'
            reached = {'sealed-batch': batch.exists() and not pending.exists() and not commits and json.loads((directory / 'progress.json').read_text()).get('phase') == 'collecting',
                       'pending-update': pending.exists() and not commits,
                       'committed-update': len(commits) == 1 and not (directory / 'artifacts.body.json').exists()}[boundary]
            if reached and process is not None:
                require(process_identity(process['pid']) == process, 'diagnostic-process-drift', 'driver identity changed')
                os.kill(process['pid'], signal.SIGSTOP)
                try:
                    # Re-observe after stopping to ensure the intended boundary
                    # was not crossed between the first observation and SIGSTOP.
                    stopped = psutil.Process(process['pid'])
                    for _ in range(100):
                        if stopped.status() == psutil.STATUS_STOPPED: break
                        time.sleep(.001)
                    require(stopped.status() == psutil.STATUS_STOPPED, 'diagnostic-stop-unconfirmed', 'driver did not stop')
                    committed = ledger.db.execute('SELECT COUNT(*) FROM commits').fetchone()[0]
                    require(not (directory / 'artifacts.body.json').exists(), 'diagnostic-missed-boundary', 'candidate already finalized')
                    require((boundary == 'committed-update') == (committed == 1), 'diagnostic-missed-boundary', 'commit crossed before stop')
                    require(boundary != 'sealed-batch' or (not pending.exists() and json.loads((directory / 'progress.json').read_text()).get('phase') == 'collecting'), 'diagnostic-missed-boundary', 'save already completed')
                    usage_before = service.inspect(handle)['usage']['gpuSeconds']
                    report.update(process=process, beforeStatus=service.inspect(handle), commits=commits,
                        batch=json.loads(batch.read_text()) if batch.exists() else None,
                        pending=json.loads(pending.read_text()) if pending.exists() else None,
                        stoppedAt=time.time(), injected=True)
                    atomic_json(output, report)
                    time.sleep(3)
                    usage_after = service.inspect(handle)['usage']['gpuSeconds']
                    require(usage_after >= usage_before + 2.5, 'diagnostic-accounting-stopped', 'reserved GPU cost stopped while driver was unresponsive')
                    report.update(unresponsiveGpuSeconds=usage_after - usage_before, killedAt=time.time())
                    atomic_json(output, report)
                finally:
                    if owned_alive(process): os.kill(process['pid'], signal.SIGKILL)
                return
        finally: ledger.close()
        time.sleep(.01 if process is not None else .05)
    raise TimeoutError('durable fault boundary not reached within diagnostic budget')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('action', choices=['resume', 'watch'])
    parser.add_argument('--node-config', required=True); parser.add_argument('--boundary', choices=['sealed-batch', 'pending-update', 'committed-update'])
    parser.add_argument('--output'); parser.add_argument('--seconds', type=int, default=900)
    options = parser.parse_args()
    if options.action == 'resume': resume(options.node_config)
    else:
        require(options.boundary and options.output and 1 <= options.seconds <= 1800, 'invalid-diagnostic', 'bounded fault watch required')
        watch(options.node_config, options.boundary, options.output, options.seconds)


if __name__ == '__main__': main()
