"""Author retained DiagEvo tasks and admit one solver job through the controller.

The caller authenticates the preceding challenger request/result and supplies a
frozen solver job template with its own budgets and private evaluation splits.
This is a recipe function, not a curriculum adapter or a multi-round scheduler.
"""

from __future__ import annotations

import copy
import json
import re
import subprocess
import tempfile
from pathlib import Path

from gear.training.recipes import diagevo_completion
from gear.training.recipes.agent_grpo import sampling_params
from gear.training.recipes.diagevo_solver import read_native_curriculum
from gear.training.runtime.preflight import generation_template_kwargs
from gear.training.storage.content import digest_file, digest_json, require
from gear.training.storage.loop_journal import _MISSING, _digest, _read, _write
from gear.training.storage.snapshots import seal_directory
from gear.training.storage.state import lock

_CAPABILITIES = [
    "model-call@1",
    "native-image-input",
    "no-tools",
    "artifact-export",
    "separate-verifier",
]
_RESPONSE = "/hitch-evidence/final-response.json"


def _command(command, args):
    require(
        isinstance(command, list)
        and command
        and all(isinstance(value, str) and value for value in command),
        "diagevo-command",
        "expected a nonempty command argv",
    )
    result = subprocess.run(command + args, check=True, capture_output=True, text=True, timeout=120)
    return json.loads(result.stdout)


def _freeze(path, value):
    prior = _read(path)
    require(prior is _MISSING or prior == value, "diagevo-task-drift", "task handoff input changed")
    if prior is _MISSING:
        _write(path, value)


def _options(options):
    require(
        isinstance(options, dict)
        and set(options)
        == {
            "sourceLicense",
            "environmentImage",
            "verifierImage",
            "agentTimeoutSeconds",
            "setupTimeoutSeconds",
            "verifierTimeoutSeconds",
            "maxResponseBytes",
        },
        "diagevo-task-options",
        "task authoring requires explicit images, license and limits",
    )
    require(
        isinstance(options["sourceLicense"], str)
        and options["sourceLicense"].strip()
        and all(
            isinstance(options[key], str)
            and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[0-9a-f]{64}", options[key])
            for key in ("environmentImage", "verifierImage")
        )
        and all(
            type(options[key]) is int and 0 < options[key] <= maximum
            for key, maximum in (
                ("agentTimeoutSeconds", 3600),
                ("setupTimeoutSeconds", 3600),
                ("verifierTimeoutSeconds", 300),
                ("maxResponseBytes", 16 * 1024 * 1024),
            )
        ),
        "diagevo-task-options",
        "use pinned OCI images, an explicit license and bounded limits",
    )


def _package(root, rows, source_ref, options):
    """Use Hitch's public compiler to derive actual task and package identities."""
    root.mkdir()
    (root / "profiles").mkdir()
    ids = [row["id"] for row in rows]
    manifest = (
        'schema_version = "1"\nprotocol = "hitch-benchmark@1"\n'
        f'id = "diagevo-{source_ref["digest"][7:23]}"\nrelease = "1"\n'
        'task_root = "tasks"\n'
        f"task_ids = {json.dumps(ids)}\n"
        'default_profile = "profiles/default.json"\nprimary_metric = "completion"\n'
        'runtime_components = []\n[task_format]\nname = "harbor"\nschema_version = "1.4"\n'
        '[source]\nkind = "local"\npath = "."\n'
        f"license = {json.dumps(options['sourceLicense'], ensure_ascii=False)}\n"
        '[metrics.completion]\ntype = "binary"\ndirection = "maximize"\n'
        'range = [0, 1]\nreducer = "task_macro_mean"\n'
        # Hitch package publication makes no training authorization claim.
        # Gear separately authorizes exact capture from the admitted train source.
        '[publication]\ntrack = "custom"\ntraining_eligible = false\n'
    )
    (root / "benchmark.toml").write_text(manifest)
    _write(
        root / "profiles/default.json",
        {
            "schema_version": "1",
            "id": "diagevo-text",
            "track": "custom",
            "input_mode": "instruction",
            "tool_policy": {
                "id": "diagevo-no-tools",
                "allowed": _CAPABILITIES,
                "network": "open",
                "enforcement": "required",
            },
            "budget": {
                "agent_timeout": {"source": "task"},
                "setup_timeout_ms": options["setupTimeoutSeconds"] * 1000,
                "collection_timeout_ms": 60000,
                "cleanup_grace_ms": 30000,
            },
            "sampling": {"attempts_per_task": 1, "seed": 0},
            "grading": {
                "on_agent_budget_exhausted": "grade_final_state",
                "on_missing_submission": "error",
                "infrastructure_retries": 0,
            },
        },
    )
    _write(
        root / "source-manifest.json",
        {
            "synthetic": True,
            "sourceRef": source_ref,
            "metricMeaning": "transport completion only",
            "tasks": [{"task_id": row["id"], "source": row["source"]} for row in rows],
        },
    )
    verifier = (
        Path(diagevo_completion.__file__).read_text() + '\nif __name__ == "__main__":\n    main()\n'
    )
    for row in rows:
        task = root / "tasks" / row["id"]
        (task / "environment").mkdir(parents=True)
        (task / "tests").mkdir()
        (task / "instruction.md").write_text(row["messages"][-1]["content"])
        _write(
            task / "environment/input.json",
            {
                "schema_version": "1",
                "messages": [
                    {
                        "role": message["role"],
                        "content": [{"type": "input_text", "text": message["content"]}],
                    }
                    for message in row["messages"]
                ],
            },
        )
        _write(
            task / "task.hitch.json",
            {
                "schema_version": "1",
                # Each generated question is a new source item. Several can
                # inherit one training source; that relation is in the manifest.
                "source_task_id": row["id"],
                "driver": {
                    "kind": "model-call",
                    "protocol_version": "1",
                    "config": {"input": f"tasks/{row['id']}/environment/input.json"},
                },
                "requirements": _CAPABILITIES,
                "lifecycle": {},
                "submission": {
                    "kind": "artifacts",
                    "paths": [_RESPONSE],
                    "max_bytes": options["maxResponseBytes"],
                    "final_response": _RESPONSE,
                },
                "grading": {
                    "kind": "command",
                    "entrypoint": ["bash", "/tests/test.sh"],
                    "metric_map": {"completion": "completion"},
                },
            },
        )
        (task / "task.toml").write_text(
            'schema_version = "1.4"\n' + f"artifacts = [{json.dumps(_RESPONSE)}]\n"
            f"[agent]\ntimeout_sec = {options['agentTimeoutSeconds']}\n"
            '[environment]\ncpus = 1\nmemory_mb = 1024\nworkdir = "/app"\n'
            f"[verifier]\ntimeout_sec = {options['verifierTimeoutSeconds']}\n"
            'environment_mode = "separate"\n[verifier.environment]\ncpus = 1\nmemory_mb = 512\n'
        )
        (task / "environment/Dockerfile").write_text(
            f'FROM {options["environmentImage"]}\nWORKDIR /app\nCMD ["sleep", "infinity"]\n'
        )
        (task / "tests/Dockerfile").write_text(
            f"FROM {options['verifierImage']}\nCOPY verify.py test.sh /tests/\n"
            'CMD ["sleep", "infinity"]\n'
        )
        (task / "tests/verify.py").write_text(verifier)
        (task / "tests/test.sh").write_text(
            "#!/bin/bash\nset -euo pipefail\n"
            f"python /tests/verify.py {_RESPONSE} {options['maxResponseBytes']}\n"
        )


def _compile_tasks(store, directory, *, rows, source_ref, spec, hitch_command, task_options):
    """The two native roles use the same text task and private-split checks."""
    private = [task for key in ("dev", "heldOut") for task in spec["datasets"][key]["tasks"]]
    private_instructions, private_files = set(), set()
    for task in private:
        manifest = store.read_json(task["taskRef"])
        require(
            manifest.get("format") == "harbor-dataset" and isinstance(manifest.get("files"), list),
            "diagevo-private-snapshot",
            "private exclusions require actual sealed Harbor tasks",
        )
        private_files.add(digest_json(sorted(file["sha256"] for file in manifest["files"])))
        private_instructions.update(
            file["sha256"] for file in manifest["files"] if file["path"].endswith("instruction.md")
        )
    ids = [row["id"] for row in rows]
    require(ids and len(set(ids)) == len(ids), "diagevo-task-id", "text task IDs must be unique")
    for row in rows:
        require(
            re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", row["id"]),
            "diagevo-task-id",
            "capture or schedule ID must be a single Harbor task name",
        )
        require(
            not any(
                row["id"] == task["id"] or row["source"]["family"] == task["family"]
                for task in private
            ),
            "diagevo-task-leakage",
            "generated task ID or source family collides with evaluation",
        )
        messages = row["messages"]
        require(
            messages
            and all(message["role"] == "system" for message in messages[:-1])
            and messages[-1]["role"] == "user"
            and all(isinstance(message["content"], str) for message in messages),
            "diagevo-task-input",
            "native model-call requires system instructions then one user input",
        )
    package, output = Path(directory) / "package", Path(directory) / "tasks"
    _package(package, rows, source_ref, task_options)
    compilation = _command(
        hitch_command, ["benchmark", "compile", "--package", str(package), "--out", str(output)]
    )
    require(
        compilation.get("tasks") == ids,
        "diagevo-task-compile",
        "compiler must retain exactly the requested task order",
    )
    tasks = []
    for row in rows:
        task_ref = seal_directory(store, output / row["id"], dataset=True)
        manifest = store.read_json(task_ref)
        require(
            task_ref["digest"] not in {task["taskRef"]["digest"] for task in private}
            and digest_json(sorted(file["sha256"] for file in manifest["files"]))
            not in private_files
            and not any(
                file["path"].endswith("instruction.md") and file["sha256"] in private_instructions
                for file in manifest["files"]
            ),
            "diagevo-task-leakage",
            "generated content collided with a private evaluation task",
        )
        environment = store.put_json(
            {
                "schemaVersion": 1,
                "kind": "generated-task-environment",
                "binding": "canonical-after-sealed-dispatch",
                "taskSnapshotDigest": task_ref["digest"],
                "sourceEnvironmentRef": row["source"]["environmentRef"],
            }
        )
        tasks.append(
            {
                "id": row["id"],
                "family": row["source"]["family"],
                "taskRef": task_ref,
                "environmentRef": environment,
            }
        )
    return (
        {
            "snapshotRef": seal_directory(store, output, dataset=True),
            "tasks": tasks,
            "exactDataAuthorized": True,
        },
        seal_directory(store, package),
        compilation["source_package_digest"],
    )


def prepare_solver_job(
    store, root, *, construction_ref, challenger_request, solver_spec, hitch_command, task_options
):
    """Seal real tasks and a new spec while preserving all fixed evaluation/budget fields.

    Only a ready construction is accepted. The caller handles empty pools without
    admitting a job, resampling more questions, or weakening the difficulty rule.
    Replaying the same root cannot change inputs or create another preparation.
    """
    _options(task_options)
    construction = store.read_json(construction_ref)
    require(
        construction.get("kind") == "diagevo-curriculum-construction"
        and construction.get("schemaVersion") == 1
        and construction.get("status") == "ready",
        "diagevo-task-not-ready",
        "only a ready retained curriculum can create solver tasks",
    )
    require(
        store.read_json(construction["challengerRequestRef"]) == challenger_request
        and challenger_request["trainDataset"]["exactDataAuthorized"] is True,
        "diagevo-task-source",
        "task handoff requires the authenticated authorized challenger request",
    )
    builder, pool, _ = read_native_curriculum(
        store, construction["curriculumRef"], construction["challengerRequestRef"]
    )
    retained = [vote["question_id"] for vote in pool["votes"] if vote["retained"]]
    backend = construction["solverBackend"]
    require(
        retained
        and construction["retainedQuestionIds"] == retained
        and construction["generationRef"] == pool["input"]["generationRef"]
        and pool["solverIdentity"][:2]
        == ["frozen-hf/" + backend["modelRef"]["digest"], "local-hf/" + _digest(backend)],
        "diagevo-solver-handoff",
        "handoff differs from the recomputed complete curriculum",
    )
    spec = copy.deepcopy(solver_spec)
    require(
        spec.get("schemaVersion") == 2
        and spec.get("kind") == "model-training"
        and spec["fixedHarness"].get("adapter") == "model-call"
        and not any(
            key in spec for key in ("iteration", "stages", "offlineTraining", "scriptSource")
        )
        and spec["trainer"].get("recipe") == "agent-grpo-v1"
        and spec["trainer"].get("script")
        and set(spec["trainer"].get("scriptConfig", {})) <= {"memoryUpdate"}
        and spec["rollout"]["zeroVarianceGroup"] == "keep"
        and spec["rollout"]["groupSize"] == builder.policy.optimization_group_size
        and spec["datasets"]["train"]["exactDataAuthorized"] is True,
        "diagevo-solver-template",
        "use a frozen single-job native solver template without another curriculum",
    )
    require(
        store.read_json(spec["initialModel"])["hfSnapshotRef"] == backend["modelRef"]
        and sampling_params(spec["rollout"]) == backend["sampling"]
        and spec["rollout"]["sampling"]["maxContextTokens"] == backend["maxContextTokens"]
        and generation_template_kwargs(store.read_json(spec["trainer"]["hyperparametersRef"]))
        == backend["chatTemplateKwargs"],
        "diagevo-solver-handoff",
        "solver template differs from the frozen construction model or sampling",
    )
    origin = store.read_json(construction["generationRef"])
    sources = {task["id"]: task for task in challenger_request["trainDataset"]["tasks"]}
    captures = {
        context["id"]: context
        for group in origin["input"]["groups"]
        for raw in group
        for context in [store.read_json(raw["context_ref"])]
    }
    rows = []
    for question_id in retained:
        source = sources[captures[question_id]["taskId"]]
        raw = pool["input"]["construction"][question_id][0]
        receipt = store.read_json(raw["receipt_refs"][0])
        messages = store.read_json(receipt["rawRequestRef"])["agent"]["messages"]
        rows.append({"id": question_id, "source": source, "messages": messages})
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with lock(root / "prepare.lock", blocking=False):
        _freeze(
            root / "input.json",
            {
                "constructionRef": construction_ref,
                "challengerRequestDigest": digest_json(challenger_request),
                "templateRef": store.put_json(spec),
                "options": task_options,
                "hitchCommand": hitch_command,
                "sourceDigest": digest_file(__file__),
                "verifierDigest": digest_file(diagevo_completion.__file__),
            },
        )
        prior = _read(root / "result.json")
        if prior is not _MISSING:
            store.read_json(prior["resultRef"])
            return prior["resultRef"]
        with tempfile.TemporaryDirectory(prefix="author-", dir=root) as directory:
            train, package_ref, package_digest = _compile_tasks(
                store,
                directory,
                rows=rows,
                source_ref=construction_ref,
                spec=spec,
                hitch_command=hitch_command,
                task_options=task_options,
            )
            spec["datasets"]["train"] = train
            spec["trainer"]["scriptConfig"] = {
                **spec["trainer"].get("scriptConfig", {}),
                "constructionRef": construction_ref,
            }
            result_ref = store.put_json(
                {
                    "schemaVersion": 1,
                    "kind": "diagevo-solver-job",
                    "constructionRef": construction_ref,
                    "templateRef": store.put_json(solver_spec),
                    "specRef": store.put_json(spec),
                    "sourcePackageRef": package_ref,
                    "sourcePackageDigest": package_digest,
                    "sources": [{"id": row["id"], "source": row["source"]} for row in rows],
                    "metricMeaning": "transport completion only",
                    "labelSource": "majority_vote",
                }
            )
        _freeze(root / "result.json", {"resultRef": result_ref})
        return result_ref


def admit_solver_job(store, prepared_ref, *, controller_config, gear_command):
    """Create/admit once; retries retain controller pause, decisions and spent budgets."""
    return _admit_job(
        store,
        prepared_ref,
        role="solver",
        controller_config=controller_config,
        gear_command=gear_command,
    )


def _admit_job(store, prepared_ref, *, role, controller_config, gear_command):
    prepared = store.read_json(prepared_ref)
    require(
        role in ("solver", "challenger")
        and prepared.get("kind") == f"diagevo-{role}-job"
        and prepared.get("schemaVersion") == 1,
        "diagevo-prepared-job",
        "expected a sealed preparation for the selected role",
    )
    config_file = Path(controller_config).resolve()
    config = json.loads(config_file.read_text())
    require(
        config.get("schemaVersion") == 2 and Path(config["storeRoot"]).resolve() == store.root,
        "diagevo-controller-store",
        "task handoff must use the same controller CAS",
    )
    spec = store.read_json(prepared["specRef"])
    parameters = spec["trainer"]["scriptConfig"]
    if role == "solver":
        require(
            parameters["constructionRef"] == prepared["constructionRef"],
            "diagevo-solver-job",
            "prepared solver lost its construction binding",
        )
    else:
        schedule = store.read_json(prepared["scheduleRef"])
        require(
            parameters["freshGeneration"] == schedule["freshGeneration"]
            and parameters["prompts"] == schedule["prompts"]
            and parameters["solver"]["model_ref"]
            == store.read_json(schedule["solverModelRef"])["hfSnapshotRef"],
            "diagevo-challenger-job",
            "prepared challenger lost its memory schedule or frozen solver",
        )
    command = gear_command
    key = f"diagevo-{role}/" + prepared_ref["digest"][7:]
    options = ["--config", str(config_file), "--idempotency-key", key]
    with tempfile.TemporaryDirectory(prefix="gear-diagevo-admit-") as directory:
        spec_file = Path(directory) / "spec.json"
        _write(spec_file, spec)
        experiment = _command(command, ["training", "init", str(spec_file), *options])
    require(
        experiment["specDigest"] == digest_json(spec),
        "diagevo-controller-drift",
        "controller created a different training specification",
    )
    run = _command(command, ["training", "admit", experiment["id"], *options])
    require(
        run["request"]["experimentId"] == experiment["id"]
        and run["request"]["parentModelRef"] == spec["initialModel"]
        and run["request"]["referenceModelRef"] == spec["referenceModel"]
        and run["request"]["rollout"] == spec["rollout"]
        and run["request"]["fixedHarness"] == spec["fixedHarness"]
        and run["request"]["trainer"] == spec["trainer"]
        and run["request"]["trainDataset"] == spec["datasets"]["train"],
        "diagevo-controller-drift",
        "controller admitted a different training job",
    )
    return {"experimentId": experiment["id"], "runId": run["id"], "run": run}
