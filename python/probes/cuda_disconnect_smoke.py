"""Real CUDA reservation survives a disconnected diagnostic SSH client.

Uses an 8 MiB tensor and a 45-second worker deadline, never a model reload.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
from gear_training.content import atomic_json, require
from gear_training.device_lease import NodeDeviceLedger
from gear_training.node import NodeService
from gear_training.preflight import gpu_processes
from gear_training.recovery import owned_alive, process_identity


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['hold', 'worker', 'inspect', 'cleanup'])
    p.add_argument('--node-config', required=True); p.add_argument('--gpu', required=True)
    o = p.parse_args()
    node = NodeService(json.loads(Path(o.node_config).read_text()))
    directory = node.root / 'diagnostics' / 'ssh-cuda-accounting'
    devices = NodeDeviceLedger(node.root, node.identity)
    if o.action == 'hold':
        directory.mkdir(parents=True, exist_ok=False)
        marker = {'owner': 'diagnostic/ssh-accounting/' + uuid.uuid4().hex, 'node': node.identity, 'gpu': o.gpu}
        atomic_json(directory / 'marker.json', marker)
        devices.acquire(marker['owner'], [o.gpu])
        with (directory / 'worker.log').open('w') as log:
            worker = subprocess.Popen([sys.executable, __file__, 'worker', '--node-config', o.node_config, '--gpu', o.gpu],
                                      stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        identity = process_identity(worker.pid)
        require(identity, 'diagnostic-worker-missing', 'CUDA accounting worker did not start')
        devices.track(marker['owner'], [identity], launching=True)
        atomic_json(directory / 'worker.json', identity)
        until = time.monotonic() + 20
        while not (directory / 'ready.json').exists():
            require(worker.poll() is None and time.monotonic() < until, 'diagnostic-worker-unready', 'CUDA worker did not become ready')
            time.sleep(.1)
    marker = json.loads((directory / 'marker.json').read_text())
    require(marker['node'] == node.identity and marker['gpu'] == o.gpu,
            'diagnostic-identity-drift', 'use the original node and physical GPU')
    if o.action == 'worker':
        os.environ['CUDA_VISIBLE_DEVICES'] = o.gpu
        import torch
        allocation = torch.ones(2 * 1024 * 1024, dtype=torch.float32, device='cuda')
        torch.cuda.synchronize()
        atomic_json(directory / 'ready.json', {'allocatedBytes': allocation.numel() * allocation.element_size()})
        until = time.monotonic() + 45
        while not (directory / 'stop.json').exists() and time.monotonic() < until: time.sleep(.1)
        devices.fence(marker['owner'])
        return
    if o.action == 'cleanup':
        atomic_json(directory / 'stop.json', {'requestedAt': time.time()})
        devices.fence(marker['owner'])
        until = time.monotonic() + 20
        while not devices.release(marker['owner']):
            require(time.monotonic() < until, 'diagnostic-release-unconfirmed', 'CUDA worker must physically release')
            time.sleep(.2)
        print(json.dumps({'resourcesReleased': True, 'entry': devices.inspect(marker['owner']), 'physical': gpu_processes([o.gpu])}), flush=True)
        return
    entry = devices.inspect(marker['owner']); physical = gpu_processes([o.gpu])
    alive = [i for i in entry['processes'] if owned_alive(i)]
    require(not entry['closing'] and 'releasedAt' not in entry and physical
            and all(row['pid'] in {i['pid'] for i in alive} for row in physical),
            'diagnostic-device-inactive', 'actual owned CUDA process must remain live')
    print(json.dumps({'node': node.identity, 'owner': marker['owner'], 'gpu': o.gpu,
                      'acquiredAt': entry['acquiredAt'], 'gpuSeconds': entry['gpuSeconds'],
                      'physical': physical, 'alive': alive, 'resourcesReleased': False,
                      'allocatedBytes': json.loads((directory / 'ready.json').read_text())['allocatedBytes']}), flush=True)
    if o.action == 'hold': time.sleep(45)


if __name__ == '__main__': main()
