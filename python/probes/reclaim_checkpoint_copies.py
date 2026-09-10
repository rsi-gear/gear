"""Reclaim explicitly listed checkpoint work copies after verifying retained CAS.

The caller supplies a local-backup proof and an idle, completed job. This removes
only listed ordinary work files, preserving CAS, metadata, and the container.
"""
import argparse
import hashlib
import json
from pathlib import Path


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ordinary(root, relative):
    path = Path(relative)
    assert not path.is_absolute() and path.parts and all(x not in ('.', '..') for x in path.parts)
    current = root
    assert not current.is_symlink()
    for part in path.parts:
        current = current / part
        assert not current.is_symlink(), 'checkpoint work path contains a symlink'
    assert current.is_file() and current.resolve().is_relative_to(root.resolve())
    return current


def reclaim(work, store, files, idle, record, minimum_size=1024**3):
    assert files and len({row['path'] for row in files}) == len(files)
    idle()
    verified = []
    checked_objects = set()
    for row in files:
        assert row['size'] >= minimum_size and len(row['sha256']) == 64
        assert set(row['sha256']) <= set('0123456789abcdef')
        source = ordinary(work, row['path'])
        target = ordinary(store, 'objects/' + row['sha256'][:2] + '/' + row['sha256'])
        assert source.stat().st_size == target.stat().st_size == row['size']
        if row['sha256'] not in checked_objects:
            assert sha(target) == row['sha256'], 'retained CAS bytes differ'
            checked_objects.add(row['sha256'])
        assert sha(source) == row['sha256'], 'work copy differs from its backup'
        stat = source.stat()
        verified.append((source, row, (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)))
    # Validate the entire requested set before removing the first work copy.
    record({'stage': 'all-copies-and-retained-objects-verified', 'files': len(verified)})
    removed = []
    for source, row, identity in verified:
        idle()
        assert ordinary(work, row['path']) == source
        stat = source.stat()
        assert (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns) == identity
        source.unlink()
        removed.append(row['path'])
        record({'stage': 'work-copy-removed', 'path': row['path'], 'bytes': row['size']})
    return {'removed': removed, 'logicalBytes': sum(row['size'] for _, row, _ in verified),
            'retainedObjectsVerified': len(checked_objects)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proof', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    proof = json.loads(args.proof.read_text())
    assert proof['localBackupVerified'] and proof['instanceId'] == 50316639
    assert proof['jobId'] == 'job_bf3068d3b2ad00250100aeae9c93f3e3'
    root = Path('/workspace/gear-full-job-32')
    job = root / 'jobs' / proof['jobId']
    def idle():
        state = json.loads((job / 'status.json').read_text())
        assert state['execution'] == 'completed' and state['resourcesReleased'] is True
        leases = json.loads((root / 'node-state/device-leases.json').read_text())
        assert all('releasedAt' in owner for owner in leases['owners'].values())
        identity = json.loads((root / 'node-state/identity.json').read_text())
        assert identity['generation'] == 'c910370b18b441eeaf35a9bde345f48b'
    events = []
    result = {'instanceId': proof['instanceId'], 'jobId': proof['jobId'], 'completed': False, 'events': events}
    assert not args.output.exists()
    def record(value):
        events.append(value)
        args.output.write_text(json.dumps(result, indent=2))
        print(json.dumps(value), flush=True)
    try:
        result.update(reclaim(job / 'trainer-state', root / 'content', proof['files'], idle, record))
        result['completed'] = True
    finally:
        args.output.write_text(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
