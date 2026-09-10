"""Verify a native Vast instance copy in place; never download payload files."""
import argparse
import json
from pathlib import Path
import subprocess

from gear_training.content import ContentStore, atomic_json, digest_bytes, digest_file, require


def verify(workspace, inventory, expected):
    require(inventory.get("stopped") is True and inventory["instanceId"] == expected["sourceInstanceId"],
            "migration-source-active", "inventory must describe the stopped source instance")
    files = 0; total = 0
    for entry in inventory["entries"]:
        name = entry["path"]
        require(isinstance(name, str) and not name.startswith("/") and ".." not in Path(name).parts,
                "migration-path-invalid", "source inventory escapes its workspace")
        path = workspace / name
        require(path.exists(), "migration-file-missing", "copied path is missing: " + name)
        if path.is_dir(): continue
        require(path.is_file() and not path.is_symlink() and path.stat().st_size == entry["bytes"],
                "migration-file-drift", "copied file size/type differs: " + name)
        files += 1; total += entry["bytes"]
    for entry in expected["files"]:
        path = workspace / entry["path"]
        require(path.stat().st_size == entry["size"] and digest_file(path) == entry["sha256"],
                "migration-content-drift", "important source file failed SHA-256: " + entry["path"])
    for entry in expected["git"]:
        path = workspace / entry["path"]
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True, timeout=10).strip()
        diff = subprocess.check_output(["git", "diff", "HEAD", "--binary"], cwd=path, timeout=15)
        require(head == entry["commit"] and digest_bytes(diff) == entry["patchDigest"],
                "migration-source-code-drift", "pinned source or working patch differs")
    store = ContentStore(workspace / expected["storePath"])
    count = 0; cas_bytes = 0
    # Every content-addressed payload, including optimizer shards, is verified
    # by its original filename. Directory/file inventories alone are not proof.
    for path in (store.root / "objects").rglob("*"):
        if not path.is_file(): continue
        relative = path.relative_to(store.root / "objects")
        require(len(relative.parts) == 2 and relative.parts[0] == path.name[:2],
                "migration-cas-layout", "copied CAS path has an invalid digest layout")
        digest = "sha256:" + path.name
        require(digest_file(path) == digest, "migration-cas-drift", "copied CAS failed its original digest")
        count += 1; cas_bytes += path.stat().st_size
    require(count > 0, "migration-cas-missing", "source CAS contains no objects")
    pending = json.loads((workspace / expected["pendingPath"]).read_text())
    manifest = store.read_json(pending["trainerStateRef"])
    require(manifest["format"] == "trainer-files" and manifest["files"], "migration-checkpoint-invalid", "native trainer checkpoint is missing")
    for item in manifest["files"]:
        path = store.path(item["contentRef"]["digest"])
        require(path.stat().st_size == item["size"] and item["sha256"] == item["contentRef"]["digest"],
                "migration-checkpoint-drift", "checkpoint manifest and payload differ")
    return {"kind": "verified-instance-copy", "sourceInstanceId": expected["sourceInstanceId"],
            "files": files, "bytes": total, "casObjects": count, "casBytes": cas_bytes,
            "trainerStateRef": pending["trainerStateRef"], "passed": True}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True); parser.add_argument("--expected", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True); options = parser.parse_args()
    result = verify(options.workspace.resolve(), json.loads(options.inventory.read_text()), json.loads(options.expected.read_text()))
    atomic_json(options.output, result); print(json.dumps(result))


if __name__ == "__main__": main()
