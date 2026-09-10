"""Prepare a Linux Harbor worker while paid model nodes remain stopped.

This builds installation inputs only. It does not rent/start an instance, open
Hitch's remote capabilities, or certify Docker, SSH, or a GPU runtime.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, target, expected):
    if target.is_file() and digest(target) == expected:
        return
    partial = target.with_suffix(target.suffix + ".partial")
    with urllib.request.urlopen(url, timeout=60) as source, partial.open("wb") as dest:
        while block := source.read(1024 * 1024):
            dest.write(block)
    assert digest(partial) == expected, f"download digest mismatch: {target.name}"
    partial.replace(target)


def event(stage, **details):
    print(json.dumps({"stage": stage, **details}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hitch", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    hitch = args.hitch.resolve()
    expected_runtime = json.loads(run([
        str(args.node), str(hitch / "dist/bin/hitch.js"), "training", "runtime", "--json"
    ], cwd=hitch).stdout)
    assert expected_runtime["node_version"] == "v26.7.0"
    assert expected_runtime["source"]["kind"] == "git-checkout"
    image = json.loads(run(["docker", "image", "inspect", args.image]).stdout)[0]
    assert image["Os"] == "linux" and image["Architecture"] == "amd64"
    (root / "expected-runtime.json").write_text(json.dumps(expected_runtime, indent=2))
    (root / "expected-image.json").write_text(json.dumps({"id": image["Id"], "architecture": "amd64"}, indent=2))

    name = "node-v26.7.0-linux-x64.tar.xz"
    base = "https://nodejs.org/dist/v26.7.0/"
    checksums = urllib.request.urlopen(base + "SHASUMS256.txt", timeout=30).read()
    (root / "node-SHASUMS256.txt").write_bytes(checksums)
    sha = next(line.split()[0] for line in checksums.decode().splitlines() if line.split()[-1] == name)
    download(base + name, root / name, sha)
    uv_metadata = json.load(urllib.request.urlopen("https://pypi.org/pypi/uv/0.11.26/json", timeout=30))
    uv = next(file for file in uv_metadata["urls"] if file["filename"].endswith("manylinux_2_17_x86_64.manylinux2014_x86_64.whl"))
    download(uv["url"], root / uv["filename"], uv["digests"]["sha256"])
    (root / "bootstrap-downloads.json").write_text(json.dumps({
        "node": {"url": base + name, "sha256": sha},
        "uv": {"url": uv["url"], "sha256": uv["digests"]["sha256"]},
        "python": "3.12.13",
    }, indent=2))
    event("node-and-installer-downloaded")

    wheels = root / "wheels"
    wheels.mkdir(exist_ok=True)
    with (root / "wheel-download.log").open("w") as log:
        subprocess.run([
            sys.executable, "-m", "pip", "download", "--disable-pip-version-check",
            "--only-binary=:all:", "--python-version", "3.12", "--implementation", "cp",
            "--abi", "cp312", "--platform", "manylinux_2_28_x86_64",
            "--platform", "manylinux_2_17_x86_64", "--platform", "manylinux2014_x86_64",
            "--dest", str(wheels), "harbor==0.21.0",
        ], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=900)
    event("linux-harbor-wheels-downloaded", files=len(list(wheels.glob("*.whl"))))

    # A real Git bundle retains the source commit. Dirty working files below
    # remain dirty; no fabricated .git directory or commit assertion is used.
    bundle = root / "hitch-source.bundle"
    run(["git", "-C", str(hitch), "bundle", "create", str(bundle), "HEAD"], timeout=60)
    run(["git", "-C", str(hitch), "bundle", "verify", str(bundle)], timeout=30)
    directories = ["src", "bin", "dist/bin", "dist/src", "dist/scripts", "scripts",
                   "integrations", "docs/schemas", "node_modules/smol-toml"]
    files = [hitch / "package.json"]
    for directory in directories:
        files.extend(p for p in (hitch / directory).rglob("*") if p.is_file()
                     and "__pycache__" not in p.parts and not p.name.endswith(".pyc"))
    with tarfile.open(root / "hitch-payload.tar.gz", "w:gz") as archive:
        for file in sorted(set(files)):
            assert not file.is_symlink(), f"payload symlink is not supported: {file}"
            archive.add(file, arcname=str(file.relative_to(hitch)), recursive=False)
    event("hitch-bundled", runtime_id=expected_runtime["runtime_id"])

    image_archive = root / "task-image.tar"
    # Docker save is deliberately local; the GPU instance is never used to
    # download or rebuild this fixed task image.
    subprocess.run(["docker", "image", "save", "--output", str(image_archive), image["Id"]], check=True, timeout=180)
    event("task-image-saved", bytes=image_archive.stat().st_size)
    for name in ["setup_remote_harbor_worker.sh", "install_remote_harbor_payload.sh"]:
        bootstrap = Path(__file__).with_name(name)
        (root / name).write_bytes(bootstrap.read_bytes())
        (root / name).chmod(0o700)
    inputs = [root / name for name in [
        "expected-runtime.json", "expected-image.json", "node-SHASUMS256.txt",
        "node-v26.7.0-linux-x64.tar.xz", uv["filename"], "bootstrap-downloads.json",
        "hitch-source.bundle", "hitch-payload.tar.gz", "task-image.tar",
        "setup_remote_harbor_worker.sh", "install_remote_harbor_payload.sh",
    ]] + sorted(wheels.glob("*.whl"))
    manifest = {str(p.relative_to(root)): {"sha256": digest(p), "bytes": p.stat().st_size} for p in sorted(inputs)}
    (root / "worker-inputs.json").write_text(json.dumps({
        "kind": "remote-harbor-installation-inputs", "validated": False,
        "files": manifest, "expectedRuntime": expected_runtime, "taskImageId": image["Id"],
    }, indent=2))
    (root / "worker-inputs.sha256").write_text("".join(f"{row['sha256']}  {name}\n" for name, row in manifest.items()))
    event("prepared", files=len(manifest), bytes=sum(row["bytes"] for row in manifest.values()), gpu_started=False)


if __name__ == "__main__":
    main()
