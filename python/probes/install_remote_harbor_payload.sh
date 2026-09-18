#!/usr/bin/env bash
# CPU installation shared by the local Linux check and the real VM bootstrap.
set -euo pipefail
umask 077
inputs=${1:?prepared input directory}
worker_install=${2:?new absolute installation directory}
test ! -e "$worker_install"
cd -- "$inputs"
mkdir -- "$worker_install"
tar -xJf node-v26.7.0-linux-x64.tar.xz -C "$worker_install"
export PATH="$worker_install/node-v26.7.0-linux-x64/bin:$PATH"
test "$(node --version)" = v26.7.0
python3 - "$inputs" "$worker_install" <<'PY'
from pathlib import Path
import sys, zipfile
inputs, target = map(Path, sys.argv[1:])
files = list(inputs.glob('uv-0.11.26-*.whl'))
assert len(files) == 1
with zipfile.ZipFile(files[0]) as wheel:
    names = [name for name in wheel.namelist() if name.endswith('/scripts/uv')]
    assert len(names) == 1
    (target/'uv').write_bytes(wheel.read(names[0]))
(target/'uv').chmod(0o700)
PY
export UV_PYTHON_INSTALL_DIR="$worker_install/python"
# Python is installed into this owned directory; no system Python is changed.
"$worker_install/uv" python install 3.12.13
"$worker_install/uv" venv --python 3.12.13 "$worker_install/harbor"
"$worker_install/uv" pip install --python "$worker_install/harbor/bin/python" \
  --no-index --find-links "$inputs/wheels" harbor==0.21.0
"$worker_install/uv" pip check --python "$worker_install/harbor/bin/python"
git clone --no-checkout "$inputs/hitch-source.bundle" "$worker_install/hitch"
git -C "$worker_install/hitch" checkout --detach HEAD
tar -xzf "$inputs/hitch-payload.tar.gz" -C "$worker_install/hitch"
node "$worker_install/hitch/dist/bin/hitch.js" training runtime --json > "$worker_install/runtime.json"
python3 - "$inputs/expected-runtime.json" "$worker_install/runtime.json" <<'PY'
import json, sys
expected, observed = [json.load(open(p)) for p in sys.argv[1:]]
assert expected == observed, 'worker runtime differs from the prepared controller payload'
PY
