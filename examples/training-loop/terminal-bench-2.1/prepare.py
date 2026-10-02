"""Seal local TB 2.1 tasks into an existing native GRPO deployment. CPU only."""
import argparse
import copy
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from gear_training.content import ContentStore, atomic_json, digest_json
from gear_training.export import seal_directory

HERE = Path(__file__).resolve().parent
PARTITIONS = ("train", "dev", "heldOut")


def check_inputs(base, tasks, splits, bindings):
    if base.get("kind") != "model-training" or base.get("trainer", {}).get("recipe") != "agent-grpo-v1":
        raise ValueError("base spec must be an existing native agent-grpo-v1 model-training spec")
    if base.get("stages") or "pipeline" in base["trainer"] or base.get("offlineTraining"):
        raise ValueError("remove legacy stages/pipeline and offlineTraining from the GRPO base spec")
    if set(splits) != set(PARTITIONS):
        raise ValueError("split must contain train, dev, heldOut")
    seen, families = set(), {}
    for partition in PARTITIONS:
        names = splits[partition]
        if not isinstance(names, list) or not names:
            raise ValueError(f"{partition} needs at least one task")
        for name in names:
            if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", name) or name in seen:
                raise ValueError("task names must be unique safe directory names across all splits")
            seen.add(name)
            directory = tasks / name
            if directory.is_symlink() or not (directory / "task.toml").is_file() or not (directory / "instruction.md").is_file():
                raise ValueError(f"missing Harbor task: {name}")
            if any(path.is_symlink() for path in directory.rglob("*")):
                raise ValueError(f"task contains a symlink: {name}")
            binding = bindings.get(name, {})
            family, environment = binding.get("family"), binding.get("environment", {})
            if not isinstance(family, str) or not family or families.get(family, partition) != partition:
                raise ValueError(f"missing family or cross-split family overlap: {name}")
            families[family] = partition
            for key in ("hitchEnvironmentIdentity", "taskDigest", "verifierIdentity"):
                if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(environment.get(key, ""))):
                    raise ValueError(f"{name}: {key} must come from trusted Hitch planning/canonical evidence")


def prepare(base, tasks, splits, bindings, store):
    """Keep model/runtime/hyperparameters; replace only data and script selection."""
    check_inputs(base, tasks, splits, bindings)
    spec = copy.deepcopy(base)
    spec["name"] = "Terminal-Bench 2.1 GRPO"
    spec.pop("scriptSource", None)
    spec.pop("stages", None)
    spec["datasets"] = {}
    with tempfile.TemporaryDirectory(prefix="gear-tb21-") as temporary:
        for partition in PARTITIONS:
            root = Path(temporary) / partition
            root.mkdir()
            rows = []
            for name in splits[partition]:
                destination = root / name
                shutil.copytree(tasks / name, destination, symlinks=True)
                rows.append({"id": name, "family": bindings[name]["family"],
                             "taskRef": seal_directory(store, destination, dataset=True),
                             "environmentRef": store.put_json(bindings[name]["environment"])})
            spec["datasets"][partition] = {"snapshotRef": seal_directory(store, root, dataset=True),
                                            "tasks": rows, "exactDataAuthorized": partition == "train"}
    source = store.put_file(HERE / "recipe/tb21.py")
    spec["trainer"]["script"] = {"entrypoint": "tb21:build_loop", "sourceRef": store.put_json({
        "schemaVersion": 1, "kind": "training-script-source", "files": [{"path": "tb21.py", "contentRef": source}]})}
    spec["trainer"].pop("scriptConfig", None)
    spec["evaluation"]["policy"]["requiredTaskIds"] = splits["dev"] + splits["heldOut"]
    return spec


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-spec", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True, help="existing controller config with an absolute storeRoot")
    parser.add_argument("--tasks-root", type=Path, required=True, help="TB 2.1 checkout's tasks directory")
    parser.add_argument("--revision", required=True, help="expected full Git commit of the dataset checkout")
    parser.add_argument("--bindings", type=Path, required=True)
    parser.add_argument("--split", type=Path, default=HERE / "split.json")
    parser.add_argument("--output", type=Path, required=True, help="new output directory")
    args = parser.parse_args()
    try:
        tasks = args.tasks_root.resolve()
        revision = subprocess.check_output(["git", "-C", str(tasks), "rev-parse", "HEAD"], text=True).strip()
        if not re.fullmatch(r"[0-9a-f]{40}", args.revision) or revision != args.revision:
            raise ValueError("dataset revision differs; pass its exact reviewed 40-character commit")
        if subprocess.check_output(["git", "-C", str(tasks), "status", "--porcelain", "--untracked-files=all", "--ignored", "--", "."], text=True).strip():
            raise ValueError("dataset tasks have uncommitted changes")
        config = json.loads(args.config.read_text())
        store_root = Path(config["storeRoot"])
        if not store_root.is_absolute():
            raise ValueError("controller storeRoot must be absolute")
        if args.output.exists():
            raise ValueError("output directory already exists; choose a new one")
        base, splits, bindings = (json.loads(path.read_text()) for path in (args.base_spec, args.split, args.bindings))
        spec = prepare(base, tasks, splits, bindings, ContentStore(store_root))
        args.output.mkdir(parents=True)
        atomic_json(args.output / "spec.json", spec)
        atomic_json(args.output / "dataset-provenance.json", {"repository": "https://github.com/harbor-framework/terminal-bench-2-1",
            "revision": revision, "splits": splits, "datasets": spec["datasets"], "specDigest": digest_json(spec)})
        print(args.output.resolve() / "spec.json")
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
