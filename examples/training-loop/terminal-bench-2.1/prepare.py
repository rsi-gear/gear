"""Seal TB 2.1 tasks for GRPO/SFT; optionally validate and run the four-stage loop."""
import argparse
import copy
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from gear_training.cli import controller_command, main as training_main
from gear_training.content import ContentStore, atomic_json, digest_json
from gear_training.export import seal_directory

HERE = Path(__file__).resolve().parent
PARTITIONS = ("train", "dev", "heldOut")


def check_inputs(base, tasks, splits, bindings):
    recipe = base.get("trainer", {}).get("recipe")
    if base.get("kind") != "model-training" or recipe not in ("agent-grpo-v1", "offline-sft-v1"):
        raise ValueError("base spec must select native agent-grpo-v1 or offline-sft-v1")
    if base.get("stages") or "pipeline" in base["trainer"]:
        raise ValueError("remove legacy stages/pipeline from the base spec")
    if recipe == "agent-grpo-v1" and base.get("offlineTraining"):
        raise ValueError("remove offlineTraining from the GRPO base spec")
    if recipe == "offline-sft-v1" and not isinstance(base.get("offlineTraining"), dict):
        raise ValueError("SFT base spec requires offlineTraining settings")
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
    is_sft = spec["trainer"]["recipe"] == "offline-sft-v1"
    spec["name"] = "Terminal-Bench 2.1 " + ("SFT" if is_sft else "GRPO")
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
                # Harbor consumes a dataset root containing task directories.
                # Keep its basename stable for Hitch's local benchmark identity.
                single = Path(temporary) / "single-tasks" / name
                single.mkdir(parents=True)
                shutil.copytree(destination, single / name, symlinks=True)
                rows.append({"id": name, "family": bindings[name]["family"],
                             "taskRef": seal_directory(store, single, dataset=True),
                             "environmentRef": store.put_json(bindings[name]["environment"])})
            spec["datasets"][partition] = {"snapshotRef": seal_directory(store, root, dataset=True),
                                            "tasks": rows, "exactDataAuthorized": partition == "train"}
    module = "tb21_sft" if is_sft else "tb21"
    source = store.put_file(HERE / f"recipe/{module}.py")
    spec["trainer"]["script"] = {"entrypoint": f"{module}:build_loop", "sourceRef": store.put_json({
        "schemaVersion": 1, "kind": "training-script-source", "files": [{"path": f"{module}.py", "contentRef": source}]})}
    spec["evaluation"]["policy"]["requiredTaskIds"] = splits["dev"] + splits["heldOut"]
    return spec


def check_sft_input(spec, payload):
    """Check author-supplied provenance before invoking the existing sealer."""
    offline = spec["offlineTraining"]
    if not isinstance(payload, dict):
        raise ValueError("SFT input must be a JSON object")
    if payload.get("modelRef") != spec["initialModel"]:
        raise ValueError("SFT input modelRef must equal the base spec initialModel")
    if payload.get("maxSequenceTokens") != offline.get("maxSequenceTokens"):
        raise ValueError("SFT input maxSequenceTokens differs from offlineTraining")
    records = payload.get("records")
    if not isinstance(records, list) or not records:
        raise ValueError("SFT input requires nonempty records")
    sources = [{"taskId": t["id"], "family": t["family"], "taskDigest": t["taskRef"]["digest"]}
               for t in spec["datasets"]["train"]["tasks"]]
    if any(not isinstance(row, dict) or row.get("source") not in sources for row in records):
        raise ValueError("SFT records must identify the exact sealed TB train tasks")
    capacity = len(records) * offline["maxEpochs"]
    required = spec["trainer"]["updatesPerCandidate"] * spec["trainer"]["rolloutBatchSize"]
    if required > capacity:
        raise ValueError("SFT maxEpochs cannot supply all configured updates")


def run_spec(spec_path, config_path):
    """Never submit a spec that failed the production controller validation."""
    arguments = [str(spec_path.resolve()), "--config", str(config_path.resolve())]
    status = training_main(["validate", *arguments])
    return status if status else training_main(["run", *arguments])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-spec", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True, help="existing controller config with an absolute storeRoot")
    parser.add_argument("--tasks-root", type=Path, required=True, help="TB 2.1 checkout's tasks directory")
    parser.add_argument("--revision", required=True, help="expected full Git commit of the dataset checkout")
    parser.add_argument("--bindings", type=Path, required=True)
    parser.add_argument("--split", type=Path, default=HERE / "split.json")
    parser.add_argument("--output", type=Path, required=True, help="new output directory")
    parser.add_argument("--sft-input", type=Path, help="seal-sft authoring JSON; required exactly for offline-sft-v1")
    parser.add_argument("--run", action="store_true", help="validate and continuously run after sealing")
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
        is_sft = base.get("trainer", {}).get("recipe") == "offline-sft-v1"
        if is_sft != bool(args.sft_input):
            raise ValueError("--sft-input must be supplied exactly for offline-sft-v1")
        spec = prepare(base, tasks, splits, bindings, ContentStore(store_root))
        if is_sft:
            check_sft_input(spec, json.loads(args.sft_input.read_text()))
            # Use the public CLI so v2 can fetch sealed tokenizer bytes from the node.
            sealed = json.loads(subprocess.check_output(controller_command() + ["training", "seal-sft",
                str(args.sft_input.resolve()), "--config", str(args.config.resolve())], text=True))
            spec["offlineTraining"]["datasetRef"] = sealed["datasetRef"]
        args.output.mkdir(parents=True)
        atomic_json(args.output / "spec.json", spec)
        atomic_json(args.output / "dataset-provenance.json", {"repository": "https://github.com/harbor-framework/terminal-bench-2-1",
            "revision": revision, "splits": splits, "datasets": spec["datasets"], "specDigest": digest_json(spec)})
        spec_path = args.output.resolve() / "spec.json"
        print(spec_path, flush=True)
        return run_spec(spec_path, args.config) if args.run else 0
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    sys.exit(main())
