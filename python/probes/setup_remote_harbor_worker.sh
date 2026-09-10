#!/usr/bin/env bash
# Run as the dedicated VM's root user after uploading the prepared directory.
# No instance rental, GPU startup, worker registration, or task submission here.
set -euo pipefail
umask 077
inputs=$(cd -- "$(dirname -- "$0")" && pwd -P)
worker_install=${1:?Usage: setup_remote_harbor_worker.sh /absolute/new/install/directory}
case "$worker_install" in /*) ;; *) echo 'Install directory must be absolute' >&2; exit 2;; esac
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test ! -e "$worker_install"
command -v docker >/dev/null
command -v git >/dev/null
command -v python3 >/dev/null
docker info --format '{{.ID}}' >/dev/null
docker compose version >/dev/null
docker buildx version >/dev/null
cd -- "$inputs"
sha256sum --check worker-inputs.sha256 > input-verification.log
bash "$inputs/install_remote_harbor_payload.sh" "$inputs" "$worker_install"
export PATH="$worker_install/node-v26.7.0-linux-x64/bin:$PATH"
docker image load --input "$inputs/task-image.tar" > "$worker_install/image-load.log"
"$worker_install/harbor/bin/python" - "$inputs" "$worker_install" <<'PY'
from pathlib import Path
import hashlib, importlib.metadata, json, subprocess, sys
inputs, target = map(Path, sys.argv[1:])
def call(*args): return subprocess.check_output(args, text=True).strip()
image = json.loads((inputs/'expected-image.json').read_text())['id']
observed = json.loads(call('docker', 'image', 'inspect', image))[0]
assert observed['Id'] == image and observed['Architecture'] == 'amd64'
assert importlib.metadata.version('harbor') == '0.21.0'
boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
record = {'kind': 'actual-remote-harbor-installation-observation', 'validated': False,
 'dockerEngineId': call('docker', 'info', '--format', '{{.ID}}'),
 'dockerVersion': call('docker', 'version', '--format', '{{.Server.Version}}'),
 'dockerCompose': call('docker', 'compose', 'version', '--short'),
 'dockerBuildx': call('docker', 'buildx', 'version'), 'bootId': boot,
 'harborVersion': importlib.metadata.version('harbor'), 'pythonVersion': sys.version,
 'taskImageId': image, 'hitch': json.loads((target/'runtime.json').read_text())}
(target/'installation-observation.json').write_text(json.dumps(record, indent=2))
packages = sorted((d.metadata['Name'], d.version) for d in importlib.metadata.distributions())
(target/'installed-python-packages.json').write_text(json.dumps(packages, indent=2))
print(json.dumps({'stage': 'installed', 'validated': False, 'imageId': image}))
PY
