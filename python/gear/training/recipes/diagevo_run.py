"""Bounded alternating DiagEvo jobs using the existing training controller.

This caller owns a small local journal, not a second training scheduler. Native
submission, ordered pause/resume, evaluation and resource cleanup remain with
the controller. Only accepted models advance either lineage; no publication is
implicit. Auxiliary call ceilings remain reserved even after a successful job.
"""

from __future__ import annotations

import copy
import json
import math
import time
import uuid
from pathlib import Path

from gear.training.recipes import diagevo_evolution as evolution
from gear.training.recipes import diagevo_tasks as tasks
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_generation import DiagEvoQuestionPrompt
from gear.training.recipes.diagevo_solver import native_component
from gear.training.storage.content import ContractError, digest_file, digest_json, require
from gear.training.storage.loop_journal import _MISSING, _read, _write
from gear.training.storage.state import lock

_LIMITS = (
    "trainingGpuSeconds",
    "rolloutTokens",
    "localGenerations",
    "diagnosticTurns",
    "embeddings",
    "heldOutEvaluations",
)
_TERMINAL = {"completed", "stopped"}


def _validate(plan):
    require(
        isinstance(plan, dict)
        and set(plan)
        == {
            "schemaVersion",
            "kind",
            "challenger",
            "solver",
            "prompt",
            "taskOptions",
            "rounds",
            "seed",
            "freshGenerationMaxSeconds",
            "maxWallClockSeconds",
            "budgets",
        }
        and plan["schemaVersion"] == 1
        and plan["kind"] == "diagevo-evolution",
        "diagevo-plan",
        "expected an explicit DiagEvo evolution plan",
    )
    for key, minimum, maximum in (
        ("rounds", 1, 1000000),
        ("seed", 0, 2**53 - 1),
        ("freshGenerationMaxSeconds", 1, 3600),
        ("maxWallClockSeconds", 1, 366 * 86400),
    ):
        require(
            type(plan[key]) is int and minimum <= plan[key] <= maximum,
            "diagevo-plan",
            f"invalid {key}",
        )
    require(
        isinstance(plan["budgets"], dict) and set(plan["budgets"]) == set(_LIMITS),
        "diagevo-budget",
        "all cross-job budget ceilings must be explicit",
    )
    for key, value in plan["budgets"].items():
        require(
            type(value) in ((int, float) if key == "trainingGpuSeconds" else (int,))
            and math.isfinite(value)
            and 0 <= value < 2**53,
            "diagevo-budget",
            f"invalid {key} ceiling",
        )
    tasks._options(plan["taskOptions"])
    for role in ("challenger", "solver"):
        spec = plan[role]
        require(
            spec.get("schemaVersion") == 2
            and spec.get("kind") == "model-training"
            and spec["fixedHarness"].get("adapter") == "model-call"
            and not any(
                key in spec for key in ("iteration", "stages", "scriptSource", "offlineTraining")
            )
            and spec["trainer"].get("recipe") == "agent-grpo-v1"
            and spec["trainer"].get("script")
            and spec["trainer"].get("optimizerResetPolicy") == "initial-cold-start-only"
            and spec["rollout"]["zeroVarianceGroup"] == "keep"
            and spec["budgets"]["gpuSecondsScope"] == "training"
            and spec["datasets"]["train"]["exactDataAuthorized"] is True,
            "diagevo-plan",
            "use sealed single-job native text templates with optimizer continuation",
        )
        require(
            all(
                type(spec["trainer"][key]) is int and spec["trainer"][key] > 0
                for key in ("rolloutBatchSize", "updatesPerCandidate")
            )
            and type(spec["rollout"]["groupSize"]) is int
            and spec["rollout"]["groupSize"] > 1,
            "diagevo-plan",
            "native batch and update counts must be positive",
        )
    challenger, solver = plan["challenger"], plan["solver"]
    require(
        all(challenger["datasets"][key] == solver["datasets"][key] for key in ("dev", "heldOut")),
        "diagevo-evaluation-pool",
        "both roles must use the same fixed private evaluation task pool",
    )
    parameters = challenger["trainer"]["scriptConfig"]
    require(
        set(parameters) == {"objective", "solver"}
        and set(solver["trainer"]["scriptConfig"]) == {"memoryUpdate"},
        "diagevo-plan",
        "challenger needs objective/solver; solver needs memoryUpdate",
    )
    objective, prompt = native_component(parameters["objective"]), native_component(plan["prompt"])
    require(
        isinstance(objective, DiagEvoChallengerReward)
        and isinstance(prompt, DiagEvoQuestionPrompt)
        and objective.group_size == challenger["rollout"]["groupSize"]
        and objective.policy.optimization_group_size == solver["rollout"]["groupSize"],
        "diagevo-plan",
        "native group sizes must match the frozen curriculum components",
    )
    objective.policy._parameters()
    memory = solver["trainer"]["scriptConfig"]["memoryUpdate"]
    require(
        {"diagnosis", "embedding"} <= set(memory) <= {"diagnosis", "embedding", "diagnostician"},
        "diagevo-plan",
        "both memory backends are required for evolution",
    )
    for options in (parameters["solver"], memory["diagnosis"], memory["embedding"]):
        require(
            type(options.get("max_calls")) is int and 0 < options["max_calls"] <= 1000000,
            "diagevo-budget",
            "local solver, diagnosis and embedding max_calls must be explicit",
        )
    worst_case = (challenger["trainer"]["updatesPerCandidate"] + 1) * challenger["trainer"][
        "rolloutBatchSize"
    ]
    worst_case *= challenger["rollout"]["groupSize"] * objective.policy.construction_samples
    require(
        parameters["solver"]["max_calls"] >= worst_case,
        "diagevo-budget",
        "solver call ceiling must cover quality rewards and fresh-pool construction",
    )


def _totals(state, field):
    result = dict.fromkeys(_LIMITS, 0)
    for job in state["jobs"]:
        values = job.get(field, job["reservation"]) if field == "charged" else job[field]
        for key in result:
            result[key] += values[key]
    return result


def _snapshot(store, state):
    result = copy.deepcopy(state)
    usage = {"gpuSeconds": 0, "rolloutTokens": 0, "groupResamples": 0, "heldOutQueries": 0}
    for job in state["jobs"]:
        if "runRef" in job:
            run = store.read_json(job["runRef"])
            for key in ("gpuSeconds", "rolloutTokens", "groupResamples"):
                usage[key] += run["usage"][key]
            usage["heldOutQueries"] += run["heldOutQueries"]
    result["observedControllerUsage"] = usage
    result["budgetCommitted"] = _totals(state, "charged")
    result["budgetReserved"] = _totals(state, "reservation")
    return result


def _observe(store, job, run):
    require(
        run["id"] == job["runId"] and run["request"]["experimentId"] == job["experimentId"],
        "diagevo-controller-drift",
        "controller returned another job",
    )
    # Native control state and usage can advance; the actual training request cannot.
    if "runRef" in job:
        prior = store.read_json(job["runRef"])
        require(
            prior["request"] == run["request"],
            "diagevo-controller-drift",
            "admitted request changed",
        )
        require(
            all(
                run["usage"][key] >= prior["usage"][key]
                for key in ("gpuSeconds", "rolloutTokens", "groupResamples")
            )
            and run["heldOutQueries"] >= prior["heldOutQueries"],
            "diagevo-controller-drift",
            "cumulative controller usage moved backwards",
        )
    job["runRef"] = store.put_json(run)


def _settle(store, state, job, run):
    if "outcome" in job or not run.get("decision"):
        return
    require(
        run["execution"] == "completed"
        and run["resourcesReleased"] is True
        and run["evaluationTasksCompleted"] is True,
        "diagevo-job-not-released",
        "a completed decision must release its training/evaluation resources",
    )
    outcome = run["decision"]["outcome"]
    if outcome == "accepted":
        if job["role"] == "challenger":
            accepted = evolution.accepted_challenger_construction(store, run)
            job["outputRef"] = accepted["constructionRef"]
            if accepted["construction"]["status"] != "ready":
                state.update(status="stopped", reason=accepted["construction"]["status"])
        else:
            accepted = evolution.accepted_solver_memory(store, run)
            job["outputRef"] = accepted["memoryRef"]
            state["roundsCompleted"] += 1
        state["models"][job["role"]] = accepted["modelRef"]
    else:
        state.update(status="stopped", reason=f"{job['role']}-{outcome}")
    job["outcome"] = outcome
    # Native counters are final after resource release. Auxiliary ceilings stay
    # reserved: successful receipts do not certify the absence of aborted work.
    job["charged"] = {
        **job["reservation"],
        "trainingGpuSeconds": run["usage"]["gpuSeconds"],
        "rolloutTokens": run["usage"]["rolloutTokens"],
        "heldOutEvaluations": run["heldOutQueries"],
    }
    if state["roundsCompleted"] == state["rounds"]:
        state["status"] = "completed"


def _next_job(store, state, plan):
    index = len(state["jobs"])
    role = "challenger" if index % 2 == 0 else "solver"
    spec = copy.deepcopy(plan[role])
    spec["initialModel"] = state["models"][role]
    spec["name"] = f"{state['id']}/{index // 2}/{role}"
    used = _totals(state, "charged")
    remaining = {key: plan["budgets"][key] - used[key] for key in _LIMITS}
    reservation = dict.fromkeys(_LIMITS, 0)
    reservation.update(
        trainingGpuSeconds=min(spec["budgets"]["totalGpuSeconds"], remaining["trainingGpuSeconds"]),
        rolloutTokens=min(spec["budgets"]["maxRolloutTokens"], remaining["rolloutTokens"]),
        heldOutEvaluations=min(
            spec["evaluation"]["policy"]["maxHeldOutEvaluations"], remaining["heldOutEvaluations"]
        ),
    )
    if role == "challenger":
        reservation["localGenerations"] = spec["trainer"]["scriptConfig"]["solver"]["max_calls"]
        reservation["localGenerations"] += (
            spec["trainer"]["rolloutBatchSize"] * spec["rollout"]["groupSize"]
        )
    else:
        memory = spec["trainer"]["scriptConfig"]["memoryUpdate"]
        reservation["diagnosticTurns"] = memory["diagnosis"]["max_calls"]
        reservation["embeddings"] = memory["embedding"]["max_calls"]
    if any(
        reservation[key] <= 0
        for key in ("trainingGpuSeconds", "rolloutTokens", "heldOutEvaluations")
    ) or any(reservation[key] > remaining[key] for key in _LIMITS):
        state.update(status="stopped", reason="cross-round-budget-exhausted")
        return None
    spec["budgets"].update(
        totalGpuSeconds=reservation["trainingGpuSeconds"],
        maxRolloutTokens=reservation["rolloutTokens"],
    )
    spec["evaluation"]["policy"]["maxHeldOutEvaluations"] = reservation["heldOutEvaluations"]
    job = {
        "roundIndex": index // 2,
        "role": role,
        "specRef": store.put_json(spec),
        "reservation": reservation,
    }
    state["jobs"].append(job)
    return job


def _prepare(store, root, state, plan, job, hitch_command):
    spec = store.read_json(job["specRef"])
    directory = root / "jobs" / str(len(state["jobs"]) - 1).zfill(6)
    common = {"hitch_command": hitch_command, "task_options": plan["taskOptions"]}
    if job["role"] == "challenger":
        solvers = [row for row in state["jobs"] if row["role"] == "solver"]
        return evolution.prepare_challenger_job(
            store,
            directory,
            challenger_spec=spec,
            solver_model_ref=state["models"]["solver"],
            prompt=plan["prompt"],
            round_index=job["roundIndex"],
            seed=plan["seed"],
            max_seconds=plan["freshGenerationMaxSeconds"],
            previous_solver=store.read_json(solvers[-1]["runRef"]) if solvers else None,
            first_solver=store.read_json(solvers[0]["runRef"]) if solvers else None,
            **common,
        )
    previous = state["jobs"][-2]
    return tasks.prepare_solver_job(
        store,
        directory,
        construction_ref=previous["outputRef"],
        challenger_request=store.read_json(previous["runRef"])["request"],
        solver_spec=spec,
        **common,
    )


def evolve(store, root, *, plan, controller_config, gear_command, hitch_command, action="advance"):
    """Reconcile at most one native advance/resume, or durably pause the recipe.

    Reuse the same directory after uncertain replies. ``resume`` is explicit;
    ordinary ``advance`` never resumes a paused/failed native job. The wall-clock
    limit is checked between controller calls and resumes, not a remote watchdog.
    Concurrent callers must retry a busy local lock rather than create a new run.
    """
    require(action in ("advance", "status", "pause", "resume"), "diagevo-action", "unknown action")
    _validate(plan)
    root, config_file = Path(root).resolve(), Path(controller_config).resolve()
    config = json.loads(config_file.read_text())
    require(
        config.get("schemaVersion") == 2 and Path(config["storeRoot"]).resolve() == store.root,
        "diagevo-controller-store",
        "evolution must use the configured controller CAS",
    )
    identity = {
        "planRef": store.put_json(plan),
        "controllerConfig": str(config_file),
        "controllerDigest": digest_json(config),
        "gearCommand": gear_command,
        "hitchCommand": hitch_command,
        "sourceDigest": digest_file(__file__),
        "handoffDigest": digest_file(evolution.__file__),
        "taskDigest": digest_file(tasks.__file__),
    }
    root.mkdir(parents=True, exist_ok=True)
    with lock(root / "evolution.lock", blocking=False):
        tasks._freeze(root / "input.json", identity)
        state = _read(root / "state.json")
        if state is _MISSING:
            require(
                not (root / "jobs").exists(),
                "diagevo-state-missing",
                "cannot recreate a journal after task preparation",
            )
            started = time.time()
            state = {
                "schemaVersion": 1,
                "kind": "diagevo-evolution",
                "id": "diagevo_" + uuid.uuid4().hex,
                "planRef": identity["planRef"],
                "createdAt": started,
                "deadlineAt": started + plan["maxWallClockSeconds"],
                "control": "start",
                "status": "running",
                "rounds": plan["rounds"],
                "roundsCompleted": 0,
                "jobs": [],
                "models": {role: plan[role]["initialModel"] for role in ("challenger", "solver")},
            }
            _write(root / "state.json", state)
        require(
            state["planRef"] == identity["planRef"], "diagevo-state-drift", "journal plan changed"
        )

        def save():
            _write(root / "state.json", state)
            return _snapshot(store, state)

        def command(verb, job):
            result = tasks._command(
                gear_command,
                ["training", verb, job["experimentId"], job["runId"], "--config", str(config_file)],
            )
            _observe(store, job, result)
            save()
            return result

        if state["status"] in _TERMINAL:
            return _snapshot(store, state)
        job = state["jobs"][-1] if state["jobs"] and "outcome" not in state["jobs"][-1] else None
        if action == "pause":
            state.update(control="pause", status="pausing")
            if job:
                job.pop("resumeIntent", None)
            save()  # cancellation survives an unavailable controller status call
        run = command("status", job) if job and "runId" in job else None
        if run:
            _settle(store, state, job, run)
            if "outcome" in job:
                job, run = None, None
        if state["status"] in _TERMINAL or action == "status":
            return save()
        if time.time() >= state["deadlineAt"]:
            state.update(control="pause", status="pausing", reason="wall-clock-budget-exhausted")
            save()
        elif action == "resume":
            state.update(control="start", status="running")
            if run and run["execution"] != "running" and "resumeIntent" not in job:
                job["resumeIntent"] = {
                    "fromSequence": run.get("trainingControl", {}).get("sequence", 0)
                }
            save()
        if state["control"] == "pause":
            # A saved prepared ref may already have been admitted despite a lost
            # response. Reconcile that identity, then pause it before any advance.
            if job and "preparedRef" in job and "runId" not in job:
                admitted = tasks._admit_job(
                    store,
                    job["preparedRef"],
                    role=job["role"],
                    controller_config=config_file,
                    gear_command=gear_command,
                )
                job.update(experimentId=admitted["experimentId"], runId=admitted["runId"])
                _observe(store, job, admitted["run"])
                save()
            if job and "runId" in job:
                run = command("pause", job)
                released = (
                    run["resourcesReleased"]
                    and run["evaluationTasksCompleted"]
                    and run["execution"] in ("paused", "completed")
                )
            else:
                released = True
            state["status"] = (
                ("stopped" if state.get("reason") == "wall-clock-budget-exhausted" else "paused")
                if released
                else "pausing"
            )
            return save()
        state["status"] = "running"
        if job is None:
            job = _next_job(store, state, plan)
            save()  # reserve before compilation, admission or any model call
            if job is None:
                return _snapshot(store, state)
        if "preparedRef" not in job:
            try:
                job["preparedRef"] = _prepare(store, root, state, plan, job, hitch_command)
            except ContractError as error:
                if error.code == "diagevo-zero-frequency-reference":
                    state.update(status="stopped", reason=error.code)
                    return save()
                raise
            save()
        if "runId" not in job:
            admitted = tasks._admit_job(
                store,
                job["preparedRef"],
                role=job["role"],
                controller_config=config_file,
                gear_command=gear_command,
            )
            job.update(experimentId=admitted["experimentId"], runId=admitted["runId"])
            run = admitted["run"]
            _observe(store, job, run)
            save()
        # Recheck after potentially slow preparation/admission. A newly admitted
        # job has not started; pausing uses the same controller identity.
        if time.time() >= state["deadlineAt"]:
            state.update(control="pause", status="pausing", reason="wall-clock-budget-exhausted")
            save()
            run = command("pause", job)
            if (
                run["resourcesReleased"]
                and run["evaluationTasksCompleted"]
                and run["execution"] in ("paused", "completed")
            ):
                state["status"] = "stopped"
            return save()
        if "resumeIntent" in job:
            if (
                run.get("trainingControl", {}).get("sequence", 0)
                > job["resumeIntent"]["fromSequence"]
            ):
                del job["resumeIntent"]  # the previous ordered resume reached the controller
                save()
            else:
                run = command("resume", job)
                del job["resumeIntent"]
                _settle(store, state, job, run)
                if not run.get("decision"):
                    state["status"] = {
                        "paused": "paused",
                        "pausing": "pausing",
                        "running": "running",
                    }.get(run["execution"], "needs-attention")
                return save()
        if run.get("decision"):
            _settle(store, state, job, run)
        elif run["execution"] == "pausing":
            run = command("pause", job)
            state["status"] = "paused" if run["execution"] == "paused" else "pausing"
        elif run["execution"] != "running":
            state["status"] = "paused" if run["execution"] == "paused" else "needs-attention"
        else:
            run = command("advance", job)
            _settle(store, state, job, run)
            if not run.get("decision"):
                state["status"] = {
                    "paused": "paused",
                    "pausing": "pausing",
                    "running": "running",
                }.get(run["execution"], "needs-attention")
        return save()
