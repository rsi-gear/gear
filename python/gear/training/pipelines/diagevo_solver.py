"""One admitted DiagEvo solver job using the existing native four-stage driver.

The outer caller must finish challenger construction and admit retained tasks
before this job; it may use the preceding challenger's construction result.
This factory neither swaps actors nor claims to execute the full algorithm.
"""

import json
from dataclasses import replace
from pathlib import Path

from gear.training.data.trajectories import RawTrajectory
from gear.training.loop import TrainingLoop
from gear.training.pipelines import online_rl
from gear.training.recipes import (
    diagevo_answers,
    diagevo_backends,
    diagevo_committed_memory,
    diagevo_round,
    diagevo_solver,
)
from gear.training.recipes.agent_grpo import sampling_params
from gear.training.recipes.diagevo_answers import DiagEvoMathClassifier
from gear.training.recipes.diagevo_backends import BGEEmbedding, CodexDiagnosis
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_data import _native_groups
from gear.training.recipes.diagevo_memory import DiagEvoDiagnostician
from gear.training.recipes.diagevo_round import DiagEvoMemoryUpdater
from gear.training.recipes.diagevo_solver import (
    DiagEvoSolverDatasetBuilder,
    read_native_curriculum,
)
from gear.training.recipes.diagevo_solver import (
    native_component as _component,
)
from gear.training.runtime.preflight import generation_template_kwargs
from gear.training.storage.content import digest_file, require
from gear.training.storage.loop_journal import _digest, _read


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


class SolverModelUpdater:
    """Commit the native solver, then publish its receipt-bound memory update."""

    stage_id = "gear.diagevo.solver-update-and-memory:v1"
    source_dependencies = (
        *SolverDatasetStage.source_dependencies,
        Path(diagevo_backends.__file__),
        Path(diagevo_committed_memory.__file__),
        Path(diagevo_round.__file__),
        *DiagEvoMemoryUpdater.source_dependencies,
    )
    package_dependencies = (
        *SolverDatasetStage.package_dependencies,
        *CodexDiagnosis.package_dependencies,
        *BGEEmbedding.package_dependencies,
    )

    def __init__(self, runtime, *, builder, curriculum_ref, diagnosis, embedding, diagnostician):
        self.runtime, self.builder = runtime, builder
        self.curriculum_ref = curriculum_ref
        self.diagnosis, self.embedding, self.diagnostician = diagnosis, embedding, diagnostician

    def _commits(self, checkpoint):
        runtime = self.runtime
        commits = [
            json.loads(row["ref"])
            for row in runtime.ledger.db.execute("SELECT ref FROM commits ORDER BY update_number")
        ]
        require(
            commits == runtime.prior_commits and commits and commits[-1] == checkpoint["commitRef"],
            "diagevo-memory-commit-drift",
            "memory update requires every actual committed solver update",
        )
        return commits

    async def update(self, ctx, dataset):
        checkpoint = online_rl.SlimeModelUpdater(self.runtime).update(ctx, dataset)
        if ctx.round_index != ctx.config.rounds - 1:
            return checkpoint
        self.runtime.check_cancel()
        commits = self._commits(checkpoint)
        context = replace(ctx, checkpoint=checkpoint)

        async def update_memory():
            return await diagevo_committed_memory.update_committed_memory(
                context,
                self.builder,
                commit_refs=commits,
                curriculum_ref=self.curriculum_ref,
                diagnosis=self.diagnosis,
                embedding=self.embedding,
                diagnostician=self.diagnostician,
                check_cancel=self.runtime.check_cancel,
            )

        # A completed memory round is rebuilt solely from its saved decisions
        # and native receipts. No SDK connection is needed to finish publication.
        if (Path(ctx.workspace) / "diagevo-memory/result.json").exists():
            memory_ref = await update_memory()
        else:
            async with self.diagnosis:
                memory_ref = await update_memory()
        self.runtime.check_cancel()
        return {**checkpoint, "memoryRef": memory_ref}

    def verify_completed(self, progress):
        """The existing loop callback also checks fully replayed final stages."""
        runtime = self.runtime
        last = runtime.request["trainer"]["updatesPerCandidate"] - 1
        if progress != {"roundIndex": last, "stage": "model-updater", "state": "completed"}:
            return
        directory = runtime.job_dir / "four-stage-loop/rounds" / f"{last:06d}" / "model-updater"
        saved = _read(directory / "result.json")
        checkpoint, operation = saved["output"], saved["operationId"]
        binding = {
            "sourceDigest": digest_file(Path(diagevo_committed_memory.__file__)),
            "operationId": operation,
            "commitRefs": self._commits(checkpoint),
            "curriculumRef": self.curriculum_ref,
            "diagnosis": self.diagnosis.identity,
            "embedding": self.embedding.identity,
            "diagnostician": self.diagnostician.describe().to_dict(),
        }
        workspace = directory / "workspace"
        require(
            _read(workspace / "diagevo-committed-memory.json") == binding,
            "diagevo-memory-binding-drift",
            "completed memory belongs to another solver job",
        )
        ref = diagevo_committed_memory._seal_result(
            runtime.store,
            workspace,
            operation_id=operation,
            binding=binding,
            checkpoint_ref=checkpoint["checkpointRef"],
            diagnosis=self.diagnosis,
            embedding=self.embedding,
        )
        require(
            ref == checkpoint["memoryRef"],
            "diagevo-memory-result-drift",
            "published memory differs from its decisions and native receipts",
        )


def build_loop(config, runtime):
    """Reconstruct an admitted curriculum, including the native construction handoff."""
    require(
        runtime.request["fixedHarness"].get("adapter") == "model-call",
        "diagevo-text-harness-required",
        "native DiagEvo requires the fixed model-call text harness",
    )
    parameters = config["parameters"]
    require(
        set(parameters) - {"memoryUpdate"}
        in ({"curriculumRef", "challengerRequestRef"}, {"constructionRef"}),
        "diagevo-solver-config",
        "solver scriptConfig requires constructionRef or the explicit curriculum and challenger request",
    )
    options = parameters.get("memoryUpdate")
    if "memoryUpdate" in parameters:
        require(
            isinstance(options, dict)
            and set(options)
            in ({"diagnosis", "embedding"}, {"diagnosis", "embedding", "diagnostician"})
            and isinstance(options["diagnosis"], dict)
            and "model" in options["diagnosis"]
            and set(options["diagnosis"])
            <= {"model", "model_provider", "effort", "timeout_seconds", "max_calls"}
            and isinstance(options["embedding"], dict)
            and "model_ref" in options["embedding"]
            and set(options["embedding"]) <= {"model_ref", "max_tokens", "max_calls"},
            "diagevo-memory-config",
            "memoryUpdate requires explicit diagnosis and embedding parameters",
        )
    store = runtime.store
    construction = None
    if "constructionRef" in parameters:
        construction = store.read_json(parameters["constructionRef"])
        require(
            isinstance(construction, dict) and isinstance(construction.get("solverBackend"), dict),
            "diagevo-solver-handoff",
            "construction result must identify its frozen solver backend",
        )
        backend = construction["solverBackend"]
        require(
            construction.get("schemaVersion") == 1
            and construction.get("kind") == "diagevo-curriculum-construction"
            and construction.get("status") == "ready"
            and construction.get("curriculumRef") is not None
            and construction.get("challengerRequestRef") is not None
            and backend.get("modelRef") == runtime.request["parentModel"]["hfSnapshotRef"]
            and backend.get("sampling") == sampling_params(runtime.request["rollout"])
            and backend.get("maxContextTokens")
            == runtime.request["rollout"]["sampling"]["maxContextTokens"]
            and backend.get("chatTemplateKwargs") == generation_template_kwargs(runtime.config),
            "diagevo-solver-handoff",
            "solver needs a ready construction result and its exact original frozen model",
        )
        parameters = {key: construction[key] for key in ("curriculumRef", "challengerRequestRef")}
    curriculum_ref = parameters["curriculumRef"]
    builder, pool, classifier = read_native_curriculum(
        store, curriculum_ref, parameters["challengerRequestRef"], request=runtime.request
    )
    retained = {vote["question_id"] for vote in pool["votes"] if vote["retained"]}
    if construction is not None:
        require(
            construction.get("generationRef") == pool["input"]["generationRef"]
            and construction.get("retainedQuestionIds")
            == [vote["question_id"] for vote in pool["votes"] if vote["retained"]]
            and pool["solverIdentity"][:2]
            == [
                "frozen-hf/" + construction["solverBackend"]["modelRef"]["digest"],
                "local-hf/" + _digest(construction["solverBackend"]),
            ],
            "diagevo-solver-handoff",
            "handoff differs from the recomputed complete curriculum",
        )
    admitted = [task["id"] for task in runtime.request["trainDataset"]["tasks"]]
    require(
        retained and len(admitted) == len(retained) and set(admitted) == retained,
        "diagevo-solver-admission",
        "solver job must admit exactly the retained question pool",
    )
    updater, verify_completed = online_rl.SlimeModelUpdater(runtime), None
    if options is not None:
        diagnostician = (
            _component(options["diagnostician"])
            if "diagnostician" in options
            else DiagEvoDiagnostician()
        )
        require(
            isinstance(diagnostician, DiagEvoDiagnostician),
            "diagevo-memory-config",
            "memoryUpdate requires a DiagEvo diagnostician",
        )
        diagnostician._parameters()
        root = runtime.job_dir / "diagevo-memory-backends"
        updater = SolverModelUpdater(
            runtime,
            builder=builder,
            curriculum_ref=curriculum_ref,
            diagnosis=CodexDiagnosis(root / "diagnosis", **options["diagnosis"]),
            embedding=BGEEmbedding(store, root / "embedding", **options["embedding"]),
            diagnostician=diagnostician,
        )
        verify_completed = updater.verify_completed
    return TrainingLoop(
        online_rl.FrozenTaskSource(runtime),
        online_rl.HitchRolloutExecutor(runtime),
        SolverDatasetStage(
            runtime, curriculum_ref=curriculum_ref, builder=builder, classifier=classifier
        ),
        updater,
        on_progress=verify_completed,
    )
