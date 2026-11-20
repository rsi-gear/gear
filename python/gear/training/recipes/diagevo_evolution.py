"""DiagEvo accepted-memory handoff and next-round task scheduling.

Controller run records are trusted inputs from the configured controller, never
model output. Native CAS joins below verify which committed model produced the
questions or memory; they do not turn pseudo-labels into mathematical truth.
"""

from __future__ import annotations

import copy
import tempfile
from dataclasses import asdict, replace
from pathlib import Path

from gear.core._json import json_value
from gear.core.random import DeterministicRandom
from gear.training.recipes import diagevo_completion, diagevo_tasks
from gear.training.recipes.diagevo import FailureAttribution
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_data import DiagEvoChallengerDatasetBuilder, _committed_batches
from gear.training.recipes.diagevo_generation import DiagEvoGenerationBuilder, DiagEvoQuestionPrompt
from gear.training.recipes.diagevo_memory import SkillNode, _nodes
from gear.training.recipes.diagevo_solver import _cause, native_component, read_native_curriculum
from gear.training.storage.content import digest_file, digest_json, require
from gear.training.storage.loop_journal import _MISSING, _digest, _read
from gear.training.storage.state import lock


def accepted_native_result(store, run):
    """Resolve a controller-accepted candidate to its exact native final commit."""
    require(
        run.get("execution") == "completed"
        and run.get("phase") == "accepted"
        and run.get("decision", {}).get("outcome") == "accepted"
        and run.get("resourcesReleased") is True
        and run.get("evaluationTasksCompleted") is True,
        "diagevo-model-not-accepted",
        "next-round inputs require a completed accepted controller job",
    )
    request = run["request"]
    model, artifacts = store.read_json(run["candidateRef"]), store.read_json(run["artifactsRef"])
    body = {key: value for key, value in model.items() if key != "id"}
    require(
        model["id"] == digest_json(body)
        and artifacts["model"] == model
        and model.get("trainingRunId") == run["id"] == request["trainingRunId"]
        and model.get("parentModelVersionId") == request["parentModel"]["id"]
        and artifacts["handle"] == run["handle"]
        and artifacts["handle"]["requestDigest"] == digest_json(request)
        and model["trainerCheckpointRef"] == artifacts["checkpointRef"],
        "diagevo-model-provenance",
        "accepted model or native artifacts differ from the controller job",
    )
    provenance = store.read_json(model["provenanceRef"])
    require(
        provenance.get("schemaVersion") == 1
        and provenance.get("requestDigest") == digest_json(request)
        and provenance.get("recipeDigest") == request["recipeDigest"]
        and provenance.get("updateCommitRefs") == artifacts["updateCommitRefs"],
        "diagevo-model-provenance",
        "model provenance must bind the complete original request and commits",
    )
    batches = _committed_batches(store, request, provenance["updateCommitRefs"])
    final_checkpoint, native_checkpoint = (
        batches[-1][1],
        store.read_json(model["trainerCheckpointRef"]),
    )
    result = store.read_json(provenance["trainingLoopRef"])
    checkpoint = result["checkpoint"]
    require(
        result.get("schemaVersion") == 1
        and result.get("kind") == "native-training-loop-result"
        and result.get("requestDigest") == digest_json(request)
        and result.get("source") == request["trainer"]["script"]
        and result.get("roundsCompleted") == request["trainer"]["updatesPerCandidate"]
        and checkpoint["checkpointRef"] == model["trainerCheckpointRef"]
        and checkpoint["commitRef"] == provenance["updateCommitRefs"][-1]
        and checkpoint["hfSnapshotRef"]
        == model["hfSnapshotRef"]
        == native_checkpoint["hfExportRef"]
        and checkpoint["committedUpdate"] == native_checkpoint["committedUpdate"]
        and final_checkpoint == native_checkpoint,
        "diagevo-model-provenance",
        "stage output must end at the accepted candidate's native checkpoint",
    )
    return {
        "model": model,
        "modelRef": run["candidateRef"],
        "provenance": provenance,
        "checkpoint": checkpoint,
        "request": request,
    }


def accepted_solver_memory(store, run):
    """Check memory frequencies against consumed failures before scheduling practice."""
    accepted = accepted_native_result(store, run)
    request = accepted["request"]
    parameters = request["trainer"]["scriptConfig"]
    if "constructionRef" in parameters:
        construction = store.read_json(parameters["constructionRef"])
        curriculum_ref, challenger_ref = (
            construction["curriculumRef"],
            construction["challengerRequestRef"],
        )
    else:
        curriculum_ref, challenger_ref = (
            parameters["curriculumRef"],
            parameters["challengerRequestRef"],
        )
    builder, pool, _ = read_native_curriculum(
        store, curriculum_ref, challenger_ref, request=request
    )
    commits = accepted["provenance"]["updateCommitRefs"]
    evidence = builder.round_evidence(commits, curriculum_ref=curriculum_ref)
    ref = accepted["checkpoint"]["memoryRef"]
    artifact = store.read_json(ref)
    require(
        artifact.get("kind") == "diagevo-committed-memory"
        and artifact.get("schemaVersion") == 1
        and artifact["checkpointRef"] == accepted["model"]["trainerCheckpointRef"]
        and artifact["input"]["commitRefs"] == commits
        and artifact["input"]["curriculumRef"] == curriculum_ref,
        "diagevo-memory-provenance",
        "memory must come from this solver's entire committed job",
    )
    output = artifact["memory"]
    memory = tuple(_cause(row) for row in output["memory"])
    nodes = tuple(SkillNode(**row) for row in output["nodes"])
    _nodes(nodes, memory)
    attributions = tuple(
        FailureAttribution(**{**row, "evidence_refs": tuple(row["evidence_refs"])})
        for row in output["attributions"]
    )
    expected = builder.policy.update(
        tuple(_cause(row) for row in pool["input"]["memory"]),
        votes=evidence.votes,
        generation=evidence.generation,
        groups=evidence.groups,
        attributions=attributions,
    )
    actual = {cause.cause_id: cause for cause in memory}
    failures = {
        sample.sample_id
        for group in evidence.groups
        for sample, reward in zip(group.samples, group.rewards, strict=True)
        if reward < 0
    }
    unattributed = output["unattributed_sample_ids"]
    require(
        set(actual) == {cause.cause_id for cause in expected}
        # Consolidation may change only a cause's parent node, not its history.
        and all(
            replace(cause, node_id=actual[cause.cause_id].node_id) == actual[cause.cause_id]
            for cause in expected
        )
        and len(set(unattributed)) == len(unattributed)
        and set(unattributed) == failures - {row.sample_id for row in attributions},
        "diagevo-memory-frequency",
        "published memory differs from consumed failures and state transitions",
    )
    keys, turns = set(), set()
    for row in artifact["callReceipts"]:
        receipt = store.read_json(row["receiptRef"])
        require(
            row["kind"] in ("diagnosis", "embedding")
            and row["key"] not in keys
            and receipt["request"]["key"] == row["key"]
            and receipt["request"]["backend"] == artifact["input"][row["kind"]],
            "diagevo-memory-receipt",
            "memory requires its original distinct backend receipts",
        )
        keys.add(row["key"])
        if row["kind"] == "diagnosis":
            native_id = (receipt["threadId"], receipt["turnId"])
            require(native_id not in turns, "diagevo-memory-receipt", "diagnostic turn was reused")
            turns.add(native_id)
    require(
        artifact["usage"]["diagnosticTurns"] == len(turns),
        "diagevo-memory-receipt",
        "memory call count differs from its native receipts",
    )
    return {
        **accepted,
        "memoryRef": ref,
        "memory": memory,
        "nodes": nodes,
        "frequency": sum(cause.frequency for cause in memory),
        "policy": builder.policy,
    }


def accepted_challenger_construction(store, run):
    """Validate the entire fresh pool, including terminal empty-pool outcomes."""
    accepted = accepted_native_result(store, run)
    request, checkpoint = accepted["request"], accepted["checkpoint"]
    parameters = request["trainer"]["scriptConfig"]
    generation = DiagEvoGenerationBuilder(
        DiagEvoChallengerDatasetBuilder(
            store, request, objective=native_component(parameters["objective"])
        ),
        prompt=native_component(parameters["freshGeneration"]["prompt"]),
    )
    origin, _ = generation.read(checkpoint["generationRef"])
    ref = checkpoint["constructionRef"]
    construction = store.read_json(ref)
    require(
        construction.get("schemaVersion") == 1
        and construction.get("kind") == "diagevo-curriculum-construction"
        and store.read_json(construction["challengerRequestRef"]) == request
        and construction["generationRef"] == checkpoint["generationRef"]
        and origin["input"]["commitRefs"] == accepted["provenance"]["updateCommitRefs"]
        and construction["solverBackend"]["modelRef"] == parameters["solver"]["model_ref"],
        "diagevo-construction-provenance",
        "construction must follow this accepted challenger and its frozen solver",
    )
    if origin["questions"]:
        _, pool, _ = read_native_curriculum(
            store, construction["curriculumRef"], construction["challengerRequestRef"]
        )
        retained = [row["question_id"] for row in pool["votes"] if row["retained"]]
        backend = construction["solverBackend"]
        require(
            pool["input"]["generationRef"] == checkpoint["generationRef"]
            and pool["solverIdentity"][:2]
            == ["frozen-hf/" + backend["modelRef"]["digest"], "local-hf/" + _digest(backend)]
            and construction["retainedQuestionIds"] == retained
            and construction["status"] == ("ready" if retained else "no-retained-questions"),
            "diagevo-construction-provenance",
            "construction status and retained questions must match the complete pool",
        )
    else:
        require(
            construction["status"] == "no-valid-questions"
            and construction["curriculumRef"] is None
            and construction["retainedQuestionIds"] == [],
            "diagevo-construction-provenance",
            "an entirely invalid fresh pool cannot publish a solver curriculum",
        )
    return {**accepted, "constructionRef": ref, "construction": construction}


def prepare_challenger_job(
    store,
    root,
    *,
    challenger_spec,
    solver_model_ref,
    prompt,
    round_index,
    seed,
    max_seconds,
    hitch_command,
    task_options,
    previous_solver=None,
    first_solver=None,
):
    """Schedule the next challenger from accepted memory, then seal actual text tasks.

    Round zero is free exploration. Later rounds retain the first committed
    frequency reference. A zero reference followed by active causes stops before
    admission instead of silently resetting the baseline or changing the rule.
    """
    diagevo_tasks._options(task_options)
    require(
        type(round_index) is int
        and round_index >= 0
        and type(seed) is int
        and 0 <= seed < 2**53
        and type(max_seconds) is int
        and 0 < max_seconds <= 3600,
        "diagevo-round-options",
        "round, seed and local inference limit must be explicit and bounded",
    )
    spec = copy.deepcopy(challenger_spec)
    parameters = spec["trainer"].get("scriptConfig", {})
    require(
        spec.get("schemaVersion") == 2
        and spec.get("kind") == "model-training"
        and spec["fixedHarness"].get("adapter") == "model-call"
        and not any(
            key in spec for key in ("iteration", "stages", "offlineTraining", "scriptSource")
        )
        and spec["trainer"].get("recipe") == "agent-grpo-v1"
        and spec["trainer"].get("script")
        and set(parameters) == {"objective", "solver"}
        and spec["rollout"]["zeroVarianceGroup"] == "keep"
        and spec["datasets"]["train"]["exactDataAuthorized"] is True,
        "diagevo-challenger-template",
        "use a frozen single-job challenger template with objective and solver options",
    )
    objective, prompt = native_component(parameters["objective"]), native_component(prompt)
    require(
        isinstance(objective, DiagEvoChallengerReward)
        and isinstance(prompt, DiagEvoQuestionPrompt)
        and objective.group_size == spec["rollout"]["groupSize"],
        "diagevo-challenger-template",
        "challenger objective, group size and question prompt must agree",
    )
    objective.policy._parameters()
    memory, nodes, first_frequency, memory_ref, first_ref = (), (), 0, None, None
    if round_index == 0:
        require(
            previous_solver is None and first_solver is None,
            "diagevo-round-memory",
            "round zero starts with empty memory",
        )
    else:
        require(
            previous_solver is not None and first_solver is not None,
            "diagevo-round-memory",
            "later rounds require the previous and first accepted solver records",
        )
        previous = accepted_solver_memory(store, previous_solver)
        first = (
            previous
            if previous_solver == first_solver
            else accepted_solver_memory(store, first_solver)
        )
        require(
            previous["modelRef"] == solver_model_ref
            and previous["policy"].describe().to_dict() == objective.policy.describe().to_dict()
            and first["policy"].describe().to_dict() == objective.policy.describe().to_dict(),
            "diagevo-round-memory",
            "schedule must use the selected solver and unchanged curriculum policy",
        )
        memory, nodes, first_frequency = previous["memory"], previous["nodes"], first["frequency"]
        memory_ref, first_ref = previous["memoryRef"], first["memoryRef"]
        require(
            first_frequency > 0 or previous["frequency"] == 0,
            "diagevo-zero-frequency-reference",
            "active memory with zero first-round frequency stops before the next challenger",
        )
    source = spec["datasets"]["train"]
    sources = sorted(source["tasks"], key=lambda row: row["id"])
    require(
        sources and len({row["id"] for row in sources}) == len(sources),
        "diagevo-task-source",
        "challenger needs distinct authorized source tasks",
    )
    count = spec["trainer"]["rolloutBatchSize"] * (spec["trainer"]["updatesPerCandidate"] + 1)
    identity = {
        "roundIndex": round_index,
        "seed": seed,
        "memoryRef": memory_ref,
        "firstMemoryRef": first_ref,
        "firstRoundFrequency": first_frequency,
        "solverModelRef": solver_model_ref,
        "templateRef": store.put_json(spec),
        "prompt": prompt.describe().to_dict(),
        "taskCount": count,
        "zeroReferencePolicy": "stop-before-next-challenger",
    }
    rng = DeterministicRandom(_digest(identity))
    directives = objective.policy.schedule(
        memory, first_round_frequency=first_frequency, count=count, rng=rng
    )
    prefix = "diagevo-" + _digest(identity)[7:23] + "-"
    task_ids = [prefix + str(index).zfill(len(str(count))) for index in range(count)]
    generation = {
        key: json_value(asdict(row)) for key, row in zip(task_ids, directives, strict=True)
    }
    prompts = {
        key: prompt.messages(row, memory=memory, nodes=nodes)
        for key, row in zip(task_ids, directives, strict=True)
    }
    options = {
        "prompt": prompt.describe().to_dict(),
        "memory": json_value(memory),
        "nodes": json_value(nodes),
        "directives": generation,
        "seed": int(_digest(identity)[7:20], 16),
        "maxSeconds": max_seconds,
    }
    schedule_ref = store.put_json(
        {
            "schemaVersion": 1,
            "kind": "diagevo-generation-schedule",
            **identity,
            "prompts": prompts,
            "freshGeneration": options,
        }
    )
    rows = [
        {"id": key, "source": sources[index % len(sources)], "messages": prompts[key]}
        for index, key in enumerate(task_ids)
    ]
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with lock(root / "prepare.lock", blocking=False):
        diagevo_tasks._freeze(
            root / "input.json",
            {
                "scheduleRef": schedule_ref,
                "options": task_options,
                "hitchCommand": hitch_command,
                "sourceDigest": digest_file(__file__),
                "taskSourceDigest": digest_file(diagevo_tasks.__file__),
                "verifierDigest": digest_file(diagevo_completion.__file__),
            },
        )
        prior = _read(root / "result.json")
        if prior is not _MISSING:
            store.read_json(prior["resultRef"])
            return prior["resultRef"]
        with tempfile.TemporaryDirectory(prefix="author-", dir=root) as directory:
            train, package_ref, package_digest = diagevo_tasks._compile_tasks(
                store,
                directory,
                rows=rows,
                source_ref=schedule_ref,
                spec=spec,
                hitch_command=hitch_command,
                task_options=task_options,
            )
            spec["datasets"]["train"] = train
            spec["trainer"]["scriptConfig"] = {
                **parameters,
                "solver": {
                    **parameters["solver"],
                    "model_ref": store.read_json(solver_model_ref)["hfSnapshotRef"],
                },
                "prompts": prompts,
                "freshGeneration": options,
            }
            result_ref = store.put_json(
                {
                    "schemaVersion": 1,
                    "kind": "diagevo-challenger-job",
                    "scheduleRef": schedule_ref,
                    "templateRef": store.put_json(challenger_spec),
                    "specRef": store.put_json(spec),
                    "sourcePackageRef": package_ref,
                    "sourcePackageDigest": package_digest,
                    "sources": [{"id": row["id"], "source": row["source"]} for row in rows],
                    "metricMeaning": "transport completion only",
                }
            )
        diagevo_tasks._freeze(root / "result.json", {"resultRef": result_ref})
        return result_ref


def admit_challenger_job(store, prepared_ref, *, controller_config, gear_command):
    return diagevo_tasks._admit_job(
        store,
        prepared_ref,
        role="challenger",
        controller_config=controller_config,
        gear_command=gear_command,
    )
