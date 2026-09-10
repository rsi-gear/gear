"""Read completed recovery/evaluation ownership and bounded runtime observations.

No GPU kernels are launched. Model and checkpoint payloads stay on the node.
The report is diagnostic evidence, not a runtime certificate.
"""
import argparse
import ast
import json
from pathlib import Path
import re

from gear_training.content import atomic_json, digest_file, require
from gear_training.preflight import gpu_processes
from gear_training.recovery import owned_alive
from single_gpu_recovery_smoke import context


def native_snapshots(directory, request):
    import io
    import math
    import pickle
    import torch
    from gear_training.content import ContentStore, digest_bytes
    config = json.loads((directory / 'config.json').read_text())
    store = ContentStore(config['storeRoot'])
    artifacts = json.loads((directory / 'artifacts.body.json').read_text())
    result = []
    for number, commit_ref in enumerate(artifacts['updateCommitRefs'], 1):
        commit = store.read_json(commit_ref)
        checkpoint = store.read_json(commit['checkpointRef'])
        manifest = store.read_json(checkpoint['actorStateRef'])
        require(checkpoint['actorStateRef'] == checkpoint['optimizerStateRef'] == checkpoint['schedulerAndRngRef'],
                'audit-native-state-drift', 'all trainer state must bind the same native snapshot')
        files = {entry['path']: entry for entry in manifest['files']}
        prefix = f'iter_{number - 1:07d}/'
        def small(name):
            entry = files[prefix + name]
            path = store.path(entry['contentRef']['digest'])
            require(0 < entry['size'] <= 2 * 1024 ** 2 and path.stat().st_size == entry['size']
                    and digest_file(path) == entry['sha256'], 'audit-native-metadata-drift', 'native metadata changed')
            return path.read_bytes()
        # These pickle objects were produced by this exact diagnostic job and
        # are read only from its immutable native checkpoint manifest.
        common = torch.load(io.BytesIO(small('common.pt')), map_location='cpu', weights_only=False)
        metadata = pickle.loads(small('.metadata'))
        require(common['iteration'] == number - 1 and common['opt_param_scheduler']['num_steps']
                == number * request['trainer']['globalBatchSize'],
                'audit-native-cursor-drift', 'scheduler and checkpoint iteration must continue across recovery')
        steps, rng, moments = [], [], []
        for key, value in metadata.state_dict_metadata.items():
            if key.endswith(('.exp_avg', '.exp_avg_sq')):
                require(str(value.properties.dtype) == 'torch.float32',
                        'audit-optimizer-precision', 'native Adam moments must retain FP32 precision')
                moments.append({'name': key, 'dtype': str(value.properties.dtype), 'elements': math.prod(value.size)})
        require(len(moments) == 2 and all(item['elements'] > 0 for item in moments),
                'audit-optimizer-missing', 'both Adam moments are required')
        for key, location in metadata.storage_data.items():
            if not (key.fqn.startswith('rng_state/') or 'optimizer/shard' in key.fqn): continue
            entry = files[prefix + location.relative_path]
            require(0 < location.length <= 2 * 1024 ** 2 and location.offset >= 0
                    and location.offset + location.length <= entry['size'],
                    'audit-native-range-invalid', 'small native state range must stay inside its retained shard')
            with store.path(entry['contentRef']['digest']).open('rb') as stream:
                stream.seek(location.offset); data = stream.read(location.length)
            require(len(data) == location.length, 'audit-native-range-invalid', 'native state range is truncated')
            value = torch.load(io.BytesIO(data), map_location='cpu', weights_only=False)
            if key.fqn.startswith('rng_state/'):
                while isinstance(value, list) and len(value) == 1: value = value[0]
                require(isinstance(value, dict) and all(name in value for name in
                        ('random_rng_state', 'np_rng_state', 'torch_rng_state', 'cuda_rng_state', 'rng_tracker_states'))
                        and value['rng_tracker_states'], 'audit-rng-missing', 'complete native RNG state is required')
                rng.append({'name': key.fqn, 'sha256': digest_bytes(data), 'size': len(data),
                            'fields': sorted(value), 'trackers': sorted(value['rng_tracker_states'])})
            else:
                for shard in value: steps.extend(group['step'] for group in shard['param_groups'])
        require(steps and all(step == number for step in steps) and rng,
                'audit-native-step-drift', 'optimizer steps must progress without a cold restart')
        result.append({'committedUpdate': number, 'commitRef': commit_ref, 'trainerStateRef': checkpoint['actorStateRef'],
                       'iteration': common['iteration'], 'scheduler': common['opt_param_scheduler'],
                       'optimizerSteps': steps, 'moments': moments, 'rng': rng})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-config', required=True)
    parser.add_argument('--inference-service', required=True)
    parser.add_argument('--output', type=Path, required=True)
    options = parser.parse_args()
    require(re.fullmatch(r'inference_[a-f0-9]{32}', options.inference_service),
            'audit-service-invalid', 'use the actual independent evaluation service')
    node, service, directory, request, handle = context(options.node_config)
    status = service.inspect(handle)
    require(status['execution'] == 'completed' and status['resourcesReleased']
            and status['committedUpdate'] == request['trainer']['updatesPerCandidate'],
            'audit-training-incomplete', 'all training updates must finish and release')
    devices = [item['gpuUuid'] for item in request['trainingDevices']]
    physical = gpu_processes(devices)
    require(not physical, 'audit-devices-occupied', 'physical GPU must be free after evaluation')
    ledger_path = node.root / 'device-leases.json'
    ledger = json.loads(ledger_path.read_text())
    train_prefix = 'training/' + handle['jobId'] + '/'
    training = [entry for entry in ledger['owners'].values() if entry['owner'].startswith(train_prefix)]
    evaluation = [entry for entry in ledger['owners'].values()
                  if entry['owner'] == 'inference/' + options.inference_service]
    require(len(training) >= 4 and len(evaluation) == 1, 'audit-owners-missing',
            'recovery incarnations and the actual evaluation owner must be retained')
    for entry in training + evaluation:
        require(entry['node'] == node.identity and entry['devices'] == sorted(devices)
                and entry['closing'] and entry.get('releasedAt', 0) >= entry['acquiredAt']
                and not any(owned_alive(p) for p in entry['processes']),
                'audit-release-unconfirmed', 'exact owner processes and devices must be released')
        elapsed = (entry['releasedAt'] - entry['acquiredAt']) * len(entry['devices'])
        require(abs(entry['gpuSeconds'] - elapsed) < .01,
                'audit-accounting-drift', 'ledger charge must cover the entire reservation')
    ordered = sorted(training + evaluation, key=lambda entry: entry['acquiredAt'])
    require(all(a['releasedAt'] <= b['acquiredAt'] for a, b in zip(ordered, ordered[1:]))
            and max(entry['releasedAt'] for entry in training) <= evaluation[0]['acquiredAt'],
            'audit-handoff-overlap', 'training must release before independent evaluation acquires')
    require(abs(sum(entry['gpuSeconds'] for entry in training) - status['usage']['gpuSeconds']) < .01,
            'audit-accounting-drift', 'training usage must include all recovered incarnations')
    logs = []
    for path in sorted(directory.glob('slime-*.log')):
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 2 * 1024 ** 2,
                'audit-log-invalid', 'runtime log must be an ordinary bounded file')
        memory, events = [], []
        for line in path.read_text(errors='replace').splitlines():
            line = re.sub(r'\x1b\[[0-9;]*m', '', line)
            match = re.search(r'Memory-Usage (.*?): (\{.*\})', line)
            if match:
                memory.append({'phase': match[1], 'values': ast.literal_eval(match[2])})
            if any(word in line for word in ('successfully loaded checkpoint', 'successfully saved checkpoint',
                    'Timer train', 'Timer save', 'Timer wake_up', 'Timer sleep', 'Load checkpoint from', 'iteration')):
                # Full argv/config lines are not needed for this observation.
                if len(line) <= 2048: events.append(line)
        logs.append({'name': path.name, 'sha256': digest_file(path), 'size': path.stat().st_size,
                     'memory': memory, 'events': events})
    result = {'kind': 'recovery-resource-observations', 'passed': True, 'node': node.identity,
              'handle': handle, 'status': status, 'physicalGpuProcesses': physical,
              'ledger': {'sha256': digest_file(ledger_path), 'size': ledger_path.stat().st_size},
              'trainingOwners': training, 'evaluationOwner': evaluation[0], 'logs': logs,
              'nativeSnapshots': native_snapshots(directory, request)}
    atomic_json(options.output, result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__': main()
