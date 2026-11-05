"""Root-owned Linux supervisor. Candidate code never receives its authority.

A root-owned Python chroot at /opt/kaggle-runtime, libseccomp, and a fresh
container with reserved UID 65532 are required. Unsupported kernels fail before executing candidate code.
"""
import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

UID = 65532
MAX_FILE = 16 * 1024 * 1024
LIBC = ctypes.CDLL(None, use_errno=True)


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def regular(path, max_bytes=MAX_FILE):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > max_bytes:
        raise ValueError(f'expected bounded regular file: {path}')
    return path.read_bytes()


def processes():
    found = []
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            status = (path / 'status').read_text()
            for line in status.splitlines():
                if line.startswith('Uid:') and int(line.split()[1]) == UID:
                    # Zombies cannot execute or mutate outputs; parent init reaps them.
                    if '\nState:\tZ' not in '\n' + status:
                        found.append(int(path.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return found


def stop_children():
    deadline = time.monotonic() + 5
    while True:
        pending = processes()
        if not pending:
            return
        for pid in pending:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            raise RuntimeError('candidate processes did not terminate; outputs not sealed')
        time.sleep(.02)


def preflight(runtime=Path("/opt/kaggle-runtime")):
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64') or os.geteuid() != 0:
        raise RuntimeError('runner requires Linux x86_64/aarch64 and a root supervisor')
    runtime = Path(runtime)
    if not runtime.is_dir() or runtime.is_symlink():
        raise RuntimeError('root-owned /opt/kaggle-runtime Python chroot is required')
    for path in [runtime, *runtime.rglob('*')]:
        info = path.lstat()
        if not path.is_symlink() and (info.st_uid != 0 or info.st_mode & 0o022):
            raise RuntimeError(f'chroot runtime must be immutable to candidate: {path}')
    if (runtime / 'proc').exists() or (runtime / 'work').exists():
        raise RuntimeError('chroot must have neither /proc nor a previous /work')
    seccomp = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    if processes():
        raise RuntimeError('reserved candidate UID is already in use')
    return seccomp


def confine(runtime):
    """The worker cannot access the host root, inherited paths or credentials."""
    seccomp = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    os.chroot(runtime)
    os.chdir('/work/scratch')
    os.setgroups([])
    os.setgid(UID)
    os.setuid(UID)
    if LIBC.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), 'no_new_privs failed')
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    context = seccomp.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not context:
        raise RuntimeError('seccomp initialization failed')
    try:
        # Block all socket creation and cross-process/kernel authority; permit
        # ordinary CPU/numeric operations and subprocesses inside the chroot.
        for name in ['socket', 'socketpair', 'socketcall', 'connect', 'ptrace', 'process_vm_readv',
                     'process_vm_writev', 'mount', 'umount2', 'unshare', 'setns', 'chroot', 'bpf', 'keyctl']:
            number = seccomp.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and seccomp.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError(f'seccomp rule failed: {name}')
        if seccomp.seccomp_load(context) != 0:
            raise RuntimeError('seccomp enforcement failed')
    finally:
        seccomp.seccomp_release(context)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE, MAX_FILE))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))


def seal_json(path, data):
    temporary = path.with_suffix('.tmp')
    with temporary.open('x', encoding='utf8') as stream:
        json.dump(data, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o444)
    temporary.replace(path)


def log_tail(path, limit=4096):
    """Candidate output is data, never trusted supervisor diagnostics."""
    size = path.stat().st_size
    with path.open('rb') as stream:
        stream.seek(max(0, size - limit))
        tail = stream.read(limit).decode('utf8', errors='replace')
        # Replacement characters can expand invalid UTF-8. Bound the actual
        # serialized text bytes as well as bytes read from the log file.
        tail = tail.encode('utf8')[-limit:].decode('utf8', errors='ignore')
    return {'text': tail, 'truncated': size > limit}


def run(repository, artifact_file, data_dir=Path('/data'), output=Path('/output')):
    preflight()
    repository, data_dir, output = Path(repository).resolve(), Path(data_dir).resolve(), Path(output).resolve()
    task = json.loads(regular(data_dir / 'task.json'))
    if task.get('protocol') != 'kaggle-task@1' or task.get('mode') not in ('validation', 'finalization'):
        raise ValueError('invalid task protocol')
    if not isinstance(task.get('seed'), int) or not isinstance(task.get('timeout_sec'), (int, float)) or not 0 < task['timeout_sec'] <= 3600:
        raise ValueError('invalid task seed/timeout')
    if digest(canonical({k: v for k, v in task.items() if k != 'task_digest'})) != task.get('task_digest'):
        raise ValueError('task plan digest mismatch')
    artifact = json.loads(regular(artifact_file, 1024 * 1024))
    revision = artifact.get('resolved_revision', {}).get('revision', {})
    commit = revision.get('commit', '')
    if artifact.get('harness_id') != 'deepseek' or artifact.get('source_type') != 'git' or revision.get('type') != 'commit' or len(commit) not in (40, 64) or any(c not in '0123456789abcdef' for c in commit):
        raise ValueError('runner requires the Hitch-pinned exact Git artifact')
    # The fixed tool checks the complete manifest. Repeat the mutable-source
    # checks here before copying, so no unverified replacement enters Python.
    manifest = json.loads(regular(repository / 'harness/manifest.json'))
    source_entries = [a for a in manifest['artifacts'] if a['path'].startswith('workflows/titanic/')]
    if not source_entries:
        raise ValueError('empty pipeline source')
    input_hashes = {name: digest(regular(data_dir / filename)) for name, filename in [('train', 'train.csv'), ('predict', 'predict.csv')]}
    if task.get('input_digests') != input_hashes:
        raise ValueError('task input digest mismatch')
    output.mkdir(mode=0o755, parents=True, exist_ok=True)
    if output.stat().st_uid != 0 or output.stat().st_mode & 0o022:
        raise RuntimeError('output directory must be root-owned and not writable by candidate')
    marker = os.open(output / '.started', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(marker)
    runtime = Path('/opt/kaggle-runtime')
    workspace = runtime / 'work'
    workspace.mkdir(mode=0o755)
    logs = Path(tempfile.mkdtemp(prefix='gear-kaggle-logs-', dir='/run'))
    source, inputs, scratch = workspace / 'source', workspace / 'inputs', workspace / 'scratch'
    for path in (source, inputs, scratch):
        path.mkdir(mode=0o755)
    os.chown(scratch, UID, UID)
    command = []
    exit_code, timed_out = None, False
    try:
        for item in source_entries:
            relative = item['path'].removeprefix('workflows/titanic/')
            if not relative or '..' in Path(relative).parts or Path(relative).is_absolute():
                raise ValueError('unsafe pipeline path')
            content = regular(repository / 'harness' / item['path'])
            if digest(content) != item['digest'] or len(content) != item['bytes']:
                raise ValueError('pipeline source digest mismatch')
            destination = source / relative
            destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            destination.write_bytes(content)
            destination.chmod(0o444)
        for name in ('train.csv', 'predict.csv'):
            (inputs / name).write_bytes(regular(data_dir / name))
            (inputs / name).chmod(0o444)
        python = next((name for name in ('/usr/local/bin/python3', '/usr/bin/python3') if (runtime / name.lstrip('/')).is_file()), None)
        if python is None:
            raise RuntimeError('Python executable is absent from chroot runtime')
        command = [python, '-B', '/work/source/pipeline.py', '--train', '/work/inputs/train.csv',
                   '--predict', '/work/inputs/predict.csv', '--output', '/work/scratch/predictions.csv', '--seed', str(task['seed'])]
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/work/scratch', 'TMPDIR': '/work/scratch',
               'LANG': 'C.UTF-8', 'PYTHONHASHSEED': str(task['seed']), 'PYTHONDONTWRITEBYTECODE': '1',
               'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
        with (logs / 'stdout').open('wb') as stdout, (logs / 'stderr').open('wb') as stderr:
            child = subprocess.Popen(command, cwd=scratch, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                     close_fds=True, start_new_session=True, preexec_fn=lambda: confine(runtime))
            try:
                exit_code = child.wait(timeout=task['timeout_sec'])
            except subprocess.TimeoutExpired:
                timed_out = True
            finally:
                stop_children()
                child.wait(timeout=5)
            if timed_out:
                exit_code = 124
        prediction = scratch / 'predictions.csv'
        prediction_hash = None
        output_error = None
        if exit_code == 0 and (prediction.exists() or prediction.is_symlink()):
            try:
                content = regular(prediction)
            except (ValueError, OSError):
                output_error = 'invalid_prediction'
            else:
                target = output / 'predictions.csv'
                with target.open('xb') as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                target.chmod(0o444)
                prediction_hash = digest(content)
        receipt = {'protocol': 'kaggle-pipeline-receipt@1', 'status': 'completed' if prediction_hash else 'candidate_failed',
                   'candidate_commit': commit, 'pipeline_digest': digest(canonical(source_entries)),
                   'task_digest': task['task_digest'], 'input_digests': input_hashes, 'seed': task['seed'],
                   'exit_code': exit_code, 'timed_out': timed_out, 'runtime_identity': artifact['revision_identity'],
                   'argv': command}
        if prediction_hash:
            receipt['predictions_sha256'] = prediction_hash
        if output_error:
            receipt['error_code'] = output_error
        if receipt['status'] == 'candidate_failed':
            receipt['untrusted_diagnostics'] = {name: log_tail(logs / name) for name in ('stdout', 'stderr')}
        seal_json(output / 'receipt.json', receipt)
        return receipt
    finally:
        stop_children()
        shutil.rmtree(workspace)
        shutil.rmtree(logs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repository', required=True)
    parser.add_argument('--artifact', default='/opt/hitch-harness-artifact/artifact.json')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        receipt = run(args.repository, args.artifact)
        print(json.dumps(receipt, sort_keys=True))
    except BaseException:
        # A failed isolation/setup boundary is not a bad prediction. The
        # trusted scorer recognizes this before inspecting identity fields,
        # which may themselves be what failed validation. Never overwrite a
        # previously completed receipt when a duplicate call is rejected.
        output = Path('/output')
        try:
            output.mkdir(mode=0o755, parents=True, exist_ok=True)
            if os.geteuid() == 0 and output.stat().st_uid == 0 and not output.stat().st_mode & 0o022 and not (output / 'receipt.json').exists():
                seal_json(output / 'receipt.json', {'protocol': 'kaggle-pipeline-receipt@1',
                          'status': 'infrastructure_error', 'error_code': 'trusted_runner_failed'})
        except OSError:
            pass  # Lost output storage remains an infrastructure failure.
        raise


if __name__ == '__main__':
    main()
