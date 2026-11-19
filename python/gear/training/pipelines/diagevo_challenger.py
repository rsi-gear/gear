"""Native challenger updates with an independently frozen local HF solver.

The existing driver retains the trainable actor, policy leases and optimizer.
Only complete challenger captures enter the local solver; resulting answer
classes and quality rewards are sealed by the existing DiagEvo batch builder.
"""

from dataclasses import asdict
from pathlib import Path

from gear.training.data.trajectories import RawTrajectory
from gear.training.loop import TrainingLoop
from gear.training.pipelines import diagevo_solver as solver_pipeline
from gear.training.pipelines import online_rl
from gear.training.recipes import (
    diagevo_answers,
    diagevo_data,
    diagevo_generation,
    diagevo_inference,
)
from gear.training.recipes.diagevo_answers import DiagEvoMathClassifier
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_data import DiagEvoChallengerDatasetBuilder
from gear.training.recipes.diagevo_generation import DiagEvoGenerationBuilder, DiagEvoQuestionPrompt
from gear.training.recipes.diagevo_inference import FrozenHFSolver
from gear.training.recipes.diagevo_round import _freeze
from gear.training.runtime.preflight import generation_template_kwargs
from gear.training.storage.content import require
from gear.training.storage.loop_journal import _copy


class ChallengerDatasetStage:
    stage_id = "gear.diagevo.native-challenger-dataset:v1"
    source_dependencies = (
        Path(online_rl.__file__),
        Path(solver_pipeline.__file__),
        Path(diagevo_answers.__file__),
        Path(diagevo_data.__file__),
        Path(diagevo_inference.__file__),
        *DiagEvoChallengerDatasetBuilder.source_dependencies,
        *FrozenHFSolver.source_dependencies,
    )
    package_dependencies = (
        *DiagEvoMathClassifier.package_dependencies,
        *DiagEvoChallengerReward.package_dependencies,
        *FrozenHFSolver.package_dependencies,
    )

    def __init__(self, runtime, *, builder, solver, classifier, prompts):
        self.runtime, self.builder = runtime, builder
        self.solver, self.classifier = solver, classifier
        self.prompts = prompts

    async def build(self, ctx, trajectories):
        runtime = self.runtime
        rollout_id, lease = online_rl._raw_round(runtime, ctx, trajectories)
        groups = [[RawTrajectory(**raw) for raw in group] for group in trajectories["groups"]]
        # Admission, capture identities and full group sizes are checked before
        # loading or running the second model. Malformed completed questions
        # remain in their native groups with zero quality reward.
        questions = dict(self.builder.questions(groups, lease=lease))
        for group in groups:
            for raw in group:
                context = runtime.store.read_json(raw.context_ref)
                receipt = runtime.store.read_json(raw.receipt_refs[0])
                body = runtime.store.read_json(receipt["rawRequestRef"])["agent"]
                require(
                    body["messages"] == self.prompts[context["taskId"]],
                    "diagevo-challenger-prompt-drift",
                    "challenger capture differs from its frozen generation prompt",
                )
        _freeze(Path(ctx.workspace) / "frozen-solver.json", self.solver.identity)
        answers = await self.solver.sample(
            ctx.operation_id,
            questions,
            count=self.builder.objective.policy.construction_samples,
            check_cancel=runtime.check_cancel,
        )
        runtime.check_cancel()
        classes_ref = (
            self.classifier.construction(questions, answers)
            if questions
            else runtime.store.put_json(
                {
                    "schemaVersion": 1,
                    "kind": "diagevo-answer-classes",
                    "classifier": self.classifier.identity(),
                    "labels": [],
                }
            )
        )
        batch_ref = self.builder.build(
            groups,
            lease=lease,
            solver_policy_id=self.solver.policy_id,
            solver_trajectories=answers,
            answer_classes_ref=classes_ref,
        )
        _freeze(
            Path(ctx.workspace) / "solver-responses.json",
            {
                "backend": self.solver.identity,
                "answerClassesRef": classes_ref,
                "captures": {key: [asdict(raw) for raw in rows] for key, rows in answers.items()},
                "batchRef": batch_ref,
            },
        )
        return online_rl._publish_dataset(runtime, rollout_id, lease, batch_ref)


class ChallengerModelUpdater:
    """Commit native updates, then sample the final exported model independently."""

    stage_id = "gear.diagevo.challenger-update-and-generate:v1"
    source_dependencies = (
        *ChallengerDatasetStage.source_dependencies,
        Path(diagevo_generation.__file__),
        *DiagEvoGenerationBuilder.source_dependencies,
    )
    package_dependencies = ChallengerDatasetStage.package_dependencies

    def __init__(self, runtime, *, solver, generation=None, history=None, options=None):
        self.runtime, self.solver = runtime, solver
        self.generation, self.history, self.options = generation, history, options

    async def update(self, ctx, dataset):
        runtime = self.runtime
        checkpoint = online_rl.SlimeModelUpdater(runtime).update(ctx, dataset)
        if self.generation is None or ctx.round_index != ctx.config.rounds - 1:
            return checkpoint
        runtime.check_cancel()
        # Authenticate the commit references against this job's actual native
        # ledger before replaying their mathematical/capture provenance.
        import json

        commits = [
            json.loads(row["ref"])
            for row in runtime.ledger.db.execute("SELECT ref FROM commits ORDER BY update_number")
        ]
        require(
            commits == runtime.prior_commits and commits[-1] == checkpoint["commitRef"],
            "diagevo-generation-commit-drift",
            "fresh generation requires every actual committed challenger update",
        )
        history = {**_copy(self.history), "commitRefs": commits}
        messages, _, final, _, _, _ = self.generation._history(history)
        require(
            final["hfExportRef"] == checkpoint["hfSnapshotRef"]
            and final["committedUpdate"] == checkpoint["committedUpdate"],
            "diagevo-generation-commit-drift",
            "fresh generation must use the final committed checkpoint",
        )
        _freeze(
            Path(ctx.workspace) / "fresh-input.json",
            {
                "history": history,
                "checkpoint": checkpoint,
                "options": self.options,
            },
        )
        # No native actor is needed after the commit. This path can also finish
        # when the native commit reply was lost and the driver restarts without CUDA.
        self.solver.model = self.solver.tokenizer = None
        request = runtime.request
        count, size = request["trainer"]["rolloutBatchSize"], request["rollout"]["groupSize"]
        sampling = request["rollout"]["sampling"]
        backend = FrozenHFSolver(
            runtime.store,
            Path(ctx.workspace) / "fresh-challenger",
            model_ref=checkpoint["hfSnapshotRef"],
            instruction=self.generation.prompt.system,
            max_new_tokens=sampling["maxNewTokens"],
            max_context_tokens=sampling["maxContextTokens"],
            max_calls=count * size,
            seed=self.options["seed"],
            max_seconds=self.options["maxSeconds"],
            chat_template_kwargs=history["chatTemplateKwargs"],
        )
        tasks, groups, keys = request["trainDataset"]["tasks"], [], []
        start = checkpoint["committedUpdate"] * count
        for index in range(count):
            task_id = tasks[(start + index) % len(tasks)]["id"]
            key = ctx.operation_id + "/fresh-challenger/" + str(index)
            rows = await backend.sample(
                key,
                {task_id: messages[task_id][-1]["content"]},
                count=size,
                check_cancel=runtime.check_cancel,
            )
            keys.append(key)
            groups.append(rows[task_id])
        runtime.check_cancel()
        generation_ref = self.generation.seal_local(
            groups,
            backend=backend.identity,
            group_keys=keys,
            history=history,
        )
        usage = {
            "logicalGenerations": count * size,
            "inputTokens": 0,
            "outputTokens": 0,
            "generationSeconds": 0,
            "externalModelCalls": 0,
            "trainingUpdates": 0,
            "usd": None,
        }
        for group in groups:
            for raw in group:
                receipt = runtime.store.read_json(raw.receipt_refs[0])
                generation = runtime.store.read_json(receipt["rawResponseRef"])["native"]
                usage["inputTokens"] += len(generation["inputTokenIds"])
                usage["outputTokens"] += len(generation["outputTokenIds"])
                usage["generationSeconds"] += generation["seconds"]
        return {**checkpoint, "generationRef": generation_ref, "generationUsage": usage}


def build_loop(config, runtime):
    parameters = config["parameters"]
    require(
        set(parameters)
        in (
            {"objective", "solver", "prompts"},
            {"objective", "solver", "prompts", "freshGeneration"},
        ),
        "diagevo-challenger-config",
        "challenger scriptConfig requires the objective, frozen solver parameters and task prompts",
    )
    objective = solver_pipeline._component(parameters["objective"])
    require(
        isinstance(objective, DiagEvoChallengerReward),
        "diagevo-challenger-config",
        "challenger objective must be DiagEvoChallengerReward",
    )
    builder = DiagEvoChallengerDatasetBuilder(runtime.store, runtime.request, objective=objective)
    require(
        isinstance(parameters["prompts"], dict)
        and set(parameters["prompts"])
        == {task["id"] for task in runtime.request["trainDataset"]["tasks"]},
        "diagevo-challenger-config",
        "generation prompts must cover exactly the admitted tasks",
    )
    solver = FrozenHFSolver(
        runtime.store, runtime.job_dir / "diagevo-frozen-solver", **parameters["solver"]
    )
    generation, history, options = None, None, None
    if "freshGeneration" in parameters:
        options = parameters["freshGeneration"]
        require(
            isinstance(options, dict)
            and set(options) == {"prompt", "memory", "nodes", "directives", "seed", "maxSeconds"}
            and type(options["seed"]) is int
            and 0 <= options["seed"] < 2**53
            and type(options["maxSeconds"]) is int
            and 0 < options["maxSeconds"] <= 3600,
            "diagevo-challenger-config",
            "fresh generation requires a frozen memory plan and bounded inference",
        )
        prompt = solver_pipeline._component(options["prompt"])
        require(
            isinstance(prompt, DiagEvoQuestionPrompt),
            "diagevo-challenger-config",
            "fresh generation requires DiagEvoQuestionPrompt",
        )
        generation = DiagEvoGenerationBuilder(builder, prompt=prompt)
        history = {
            "memory": options["memory"],
            "nodes": options["nodes"],
            "generation": options["directives"],
            "solverPolicyId": solver.policy_id,
            "chatTemplateKwargs": generation_template_kwargs(runtime.config),
        }
        _freeze(runtime.job_dir / "diagevo-fresh-template.json", history["chatTemplateKwargs"])
        require(
            generation._plan(history)[0] == parameters["prompts"],
            "diagevo-generation-prompt-drift",
            "native prompts must match the frozen memory plan",
        )
    return TrainingLoop(
        online_rl.FrozenTaskSource(runtime),
        online_rl.HitchRolloutExecutor(runtime),
        ChallengerDatasetStage(
            runtime,
            builder=builder,
            solver=solver,
            classifier=DiagEvoMathClassifier(runtime.store),
            prompts=parameters["prompts"],
        ),
        ChallengerModelUpdater(
            runtime, solver=solver, generation=generation, history=history, options=options
        ),
    )
