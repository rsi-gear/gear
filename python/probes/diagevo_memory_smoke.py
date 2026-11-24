"""Real Codex + BGE memory backend smoke test over explicit CPU capture fixtures.

Run from the repository with python and python/tests on PYTHONPATH. The solver
responses, actor states and commits below are synthetic test material. Only
diagnosis turns and embedding inference execute real models; no training or
accuracy improvement is claimed. The original call keys survive reruns.
"""

import argparse
import asyncio
import json
import shutil
from pathlib import Path
from unittest.mock import patch

import test_diagevo_generation
from gear.training.contracts import TrainingConfig, TrainingContext
from gear.training.recipes import diagevo_backends
from gear.training.recipes.diagevo_answers import DiagEvoMathClassifier
from gear.training.recipes.diagevo_backends import BGEEmbedding, CodexDiagnosis, seal_bge_model
from gear.training.recipes.diagevo_committed_memory import update_committed_memory
from gear.training.recipes.diagevo_solver import DiagEvoSolverDatasetBuilder
from gear.training.storage.content import atomic_json, digest_file

EXAMPLES = (
    (
        "For real x, solve sqrt(x+1) = x-1.",
        r"Require x >= 1. Squaring gives x(x-3)=0. Only x=3 satisfies the original equation. \boxed{3}",
        r"Squaring gives x(x-3)=0. Therefore both roots solve the original equation. \boxed{\{0,3\}}",
    ),
    (
        "A fair die is rolled. Given that the result is even, what is the probability it exceeds 3?",
        r"The conditional sample space is {2,4,6}; favorable outcomes are {4,6}. \boxed{\frac{2}{3}}",
        r"The outcomes exceeding 3 are {4,5,6}, three out of six equally likely outcomes. \boxed{\frac{1}{2}}",
    ),
)


def fixture_job():
    fixture = test_diagevo_generation.FreshGenerationTests()
    fixture.setUp()
    fixture.fresh = fixture.group(
        2, responses=tuple("<question>" + row[0] + "</question>" for row in EXAMPLES)
    )
    fixture.ref = fixture.seal()
    _, _, questions, _, _ = fixture.solver_pool()
    native, store = fixture.native, fixture.store
    builder = DiagEvoSolverDatasetBuilder(
        store, native.request, policy=native.policy, generation_builder=fixture.builder
    )
    classifier = DiagEvoMathClassifier(store)
    by_id = dict(zip(questions, EXAMPLES, strict=True))
    construction = {
        key: tuple(
            native.capture(f"smoke/construction/{key}/{i}", key, text, slot=i)
            for i, text in enumerate([row[1]] * 9 + [row[2]] * 3)
        )
        for key, row in by_id.items()
    }
    pool = builder.seal_curriculum(
        questions,
        construction,
        generation={key: fixture.directives["generate"] for key in questions},
        memory=fixture.memory,
        construction_policy_id="solver-v1",
        answer_classes_ref=classifier.construction(questions, construction),
        generation_ref=fixture.ref,
    )
    commits, before = [], fixture.fixed
    for step, (key, row) in enumerate(by_id.items()):
        raws = tuple(
            native.capture(f"smoke/optimization/{step}/{i}", key, text, slot=i, step=step)
            for i, text in enumerate((row[2], row[1]))
        )
        lease = {
            **fixture.fixture.lease,
            "trainingRunId": native.request["trainingRunId"],
            "batchId": f"batch-{step}",
            "policyVersion": f"solver-step-{step}",
            "runtimeInstanceId": "solver-runtime",
            "synchronizedWeightsRef": before,
        }
        batch = builder.build(
            (raws,),
            lease=lease,
            curriculum_ref=pool,
            answer_classes_ref=classifier.optimization(pool, (raws,)),
        )
        commit, before = native.commit(batch, step + 1, commits[-1] if commits else None)
        commits.append(commit)
    return fixture, builder, pool, commits, before


async def run(args):
    root = Path(args.workspace).resolve()
    root.mkdir(parents=True, exist_ok=True)
    fixture, builder, pool, commits, exported = fixture_job()
    store = fixture.store
    try:
        model_ref = seal_bge_model(
            store,
            args.embedding_model,
            model_id="BAAI/bge-small-en-v1.5",
            revision="5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
        )
        diagnosis = CodexDiagnosis(root / "diagnosis", model=args.model, max_calls=args.max_calls)
        embedding = BGEEmbedding(store, root / "embedding", model_ref=model_ref, max_calls=16)
        ctx = TrainingContext(
            round_index=0,
            checkpoint={
                "checkpointRef": store.read_json(commits[-1])["checkpointRef"],
                "hfSnapshotRef": exported,
                "committedUpdate": 2,
            },
            history=[],
            operation_id="diagevo-native-backend-smoke-v1",
            workspace=root / "memory",
            run_workspace=root,
            config=TrainingConfig(
                root,
                1,
                parameters={
                    "kind": "cpu-capture-fixture-real-memory-backends",
                    "injectedReceiptGap": True,
                },
            ),
        )
        diagevo_backends._freeze(
            root / "source.json",
            {
                "probe": digest_file(__file__),
                "backend": digest_file(diagevo_backends.__file__),
                "solverInputs": "explicit CPU capture and commit fixtures; no actor training",
            },
        )
        original = diagevo_backends._finish

        class InjectedGap(RuntimeError):
            pass

        def interrupt_once(directory, request, receipt):
            fault = root / "injected-gap.json"
            if receipt.get("kind") == CodexDiagnosis.stage_id and not fault.exists():
                atomic_json(
                    fault,
                    {
                        "key": request["key"],
                        "threadId": receipt["threadId"],
                        "turnId": receipt["turnId"],
                    },
                )
                raise InjectedGap("completed native diagnosis before receipt publication")
            return original(directory, request, receipt)

        try:
            with patch.object(diagevo_backends, "_finish", interrupt_once):
                async with diagnosis:
                    ref = await update_committed_memory(
                        ctx,
                        builder,
                        commit_refs=commits,
                        curriculum_ref=pool,
                        diagnosis=diagnosis,
                        embedding=embedding,
                    )
        except InjectedGap:
            print("Recovering the original completed diagnostic turn.", flush=True)
            async with diagnosis:
                ref = await update_committed_memory(
                    ctx,
                    builder,
                    commit_refs=commits,
                    curriculum_ref=pool,
                    diagnosis=diagnosis,
                    embedding=embedding,
                )
        # A completed replay must need no connected diagnostic client or model reload.
        diagnosis.client = None
        replay = await update_committed_memory(
            ctx,
            builder,
            commit_refs=commits,
            curriculum_ref=pool,
            diagnosis=diagnosis,
            embedding=embedding,
        )
        assert replay == ref
        artifact = store.read_json(ref)
        atomic_json(root / "result.json", {"artifactRef": ref, "artifact": artifact})
        print(
            json.dumps(
                {
                    "artifactRef": ref,
                    "usage": artifact["usage"],
                    "causes": len(artifact["memory"]["memory"]),
                    "nodes": len(artifact["memory"]["nodes"]),
                    "replayEqual": replay == ref,
                }
            ),
            flush=True,
        )
    finally:
        shutil.copytree(store.root, root / "content", dirs_exist_ok=True)
        fixture.doCleanups()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--embedding-model", required=True)
    parser.add_argument("--model", default="gpt-6-astra")
    parser.add_argument("--max-calls", type=int, default=16)
    asyncio.run(run(parser.parse_args()))
