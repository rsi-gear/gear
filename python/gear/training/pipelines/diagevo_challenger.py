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
from gear.training.recipes import diagevo_answers, diagevo_data, diagevo_inference
from gear.training.recipes.diagevo_answers import DiagEvoMathClassifier
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_data import DiagEvoChallengerDatasetBuilder
from gear.training.recipes.diagevo_inference import FrozenHFSolver
from gear.training.recipes.diagevo_round import _freeze
from gear.training.storage.content import require


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


def build_loop(config, runtime):
    parameters = config["parameters"]
    require(
        set(parameters) == {"objective", "solver", "prompts"},
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
        online_rl.SlimeModelUpdater(runtime),
    )
