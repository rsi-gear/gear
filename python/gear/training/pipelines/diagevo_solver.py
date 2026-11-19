"""One admitted DiagEvo solver job using the existing native four-stage driver.

The outer caller must finish the challenger job, collect fresh questions,
classify construction responses and admit retained tasks before this job.
This factory neither swaps actors nor claims to execute the full algorithm.
"""

from pathlib import Path

from gear.core.base import construct_module
from gear.training.data.trajectories import RawTrajectory
from gear.training.loop import TrainingLoop
from gear.training.pipelines import online_rl
from gear.training.recipes import diagevo_answers, diagevo_solver
from gear.training.recipes.diagevo import DiagEvoPolicy
from gear.training.recipes.diagevo_answers import DiagEvoMathClassifier
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_data import DiagEvoChallengerDatasetBuilder, _native_groups
from gear.training.recipes.diagevo_generation import DiagEvoGenerationBuilder, DiagEvoQuestionPrompt
from gear.training.recipes.diagevo_solver import DiagEvoSolverDatasetBuilder
from gear.training.storage.content import digest_json, require


class SolverDatasetStage:
    stage_id = "gear.diagevo.native-solver-dataset:v1"
    source_dependencies = (
        Path(online_rl.__file__),
        Path(diagevo_answers.__file__),
        Path(diagevo_solver.__file__),
        *DiagEvoSolverDatasetBuilder.source_dependencies,
    )
    package_dependencies = (
        *DiagEvoMathClassifier.package_dependencies,
        *DiagEvoChallengerReward.package_dependencies,
    )

    def __init__(self, runtime, *, curriculum_ref, builder, classifier):
        self.runtime = runtime
        self.curriculum_ref = curriculum_ref
        self.builder, self.classifier = builder, classifier

    async def build(self, ctx, trajectories):
        runtime = self.runtime
        rollout_id, lease = online_rl._raw_round(runtime, ctx, trajectories)
        groups = [[RawTrajectory(**value) for value in group] for group in trajectories["groups"]]
        # Validate admission and completeness before running the CPU comparator.
        # The builder independently repeats these checks when sealing rewards.
        _, _, _, _, seen = self.builder._pool(self.curriculum_ref)
        _native_groups(runtime.store, runtime.request, groups, lease, seen)
        classes_ref = self.classifier.optimization(self.curriculum_ref, groups)
        runtime.check_cancel()
        batch_ref = self.builder.build(
            groups,
            lease=lease,
            curriculum_ref=self.curriculum_ref,
            answer_classes_ref=classes_ref,
        )
        return online_rl._publish_dataset(runtime, rollout_id, lease, batch_ref)


def _component(spec):
    # Artifact entrypoints cannot import arbitrary code. Alternative components
    # can be composed directly in a caller's own frozen script recipe.
    allowed = {
        cls.__module__ + ":" + cls.__qualname__: cls
        for cls in (DiagEvoPolicy, DiagEvoChallengerReward, DiagEvoQuestionPrompt)
    }

    def resolve(name):
        require(name in allowed, "diagevo-component", "unsupported native DiagEvo component")
        return allowed[name]

    return construct_module(spec, resolve)


def build_loop(config, runtime):
    """Reconstruct frozen sources; scriptConfig holds the two required CAS refs."""
    parameters = config["parameters"]
    require(
        set(parameters) == {"curriculumRef", "challengerRequestRef"},
        "diagevo-solver-config",
        "solver scriptConfig requires curriculumRef and challengerRequestRef",
    )
    store = runtime.store
    curriculum_ref = parameters["curriculumRef"]
    pool = store.read_json(curriculum_ref)
    require(
        pool.get("kind") == "diagevo-solver-curriculum"
        and pool.get("schemaVersion") == 1
        and pool["input"].get("generationRef") is not None,
        "diagevo-generation-required",
        "native solver recipe requires a curriculum bound to fresh challenger generation",
    )
    origin = store.read_json(pool["input"]["generationRef"])
    request = store.read_json(parameters["challengerRequestRef"])
    require(
        digest_json(request) == origin["requestDigest"],
        "diagevo-challenger-request-drift",
        "fresh question provenance must use the sealed challenger request",
    )
    generation = DiagEvoGenerationBuilder(
        DiagEvoChallengerDatasetBuilder(store, request, objective=_component(origin["objective"])),
        prompt=_component(origin["prompt"]),
    )
    builder = DiagEvoSolverDatasetBuilder(
        store, runtime.request, policy=_component(pool["policy"]), generation_builder=generation
    )
    builder._pool(curriculum_ref)
    require(
        pool["classifier"].get("kind") == DiagEvoMathClassifier.stage_id
        and isinstance(pool["classifier"].get("parameters"), dict),
        "diagevo-classifier-drift",
        "native solver recipe requires a mathematical classifier configuration",
    )
    classifier = DiagEvoMathClassifier(store, **pool["classifier"]["parameters"])
    require(
        classifier.identity() == pool["classifier"],
        "diagevo-classifier-drift",
        "native solver recipe requires the frozen Math-Verify classifier",
    )
    retained = {vote["question_id"] for vote in pool["votes"] if vote["retained"]}
    admitted = [task["id"] for task in runtime.request["trainDataset"]["tasks"]]
    require(
        retained and len(admitted) == len(retained) and set(admitted) == retained,
        "diagevo-solver-admission",
        "solver job must admit exactly the retained question pool",
    )
    return TrainingLoop(
        online_rl.FrozenTaskSource(runtime),
        online_rl.HitchRolloutExecutor(runtime),
        SolverDatasetStage(
            runtime, curriculum_ref=curriculum_ref, builder=builder, classifier=classifier
        ),
        online_rl.SlimeModelUpdater(runtime),
    )
