"""Update memory from consumed solver batches and seal the actual backend receipts.

The outer caller authenticates job/ledger provenance and publishes the returned
CAS reference. This does not create a second execution protocol or start actors.
"""

import json
from pathlib import Path

from gear.core import clone
from gear.core._json import json_value
from gear.training.recipes.diagevo_memory import DiagEvoDiagnostician, SkillNode
from gear.training.recipes.diagevo_round import DiagEvoMemoryUpdater, _freeze
from gear.training.recipes.diagevo_solver import _cause
from gear.training.storage.content import digest_file, require
from gear.training.storage.loop_journal import _read


async def update_committed_memory(
    ctx, builder, *, commit_refs, curriculum_ref, diagnosis, embedding, diagnostician=None
):
    """Use a post-update context and concrete CodexDiagnosis/BGEEmbedding instances."""
    store = builder.store
    require(
        builder.generation_builder is not None and commit_refs,
        "diagevo-memory-origin",
        "committed memory requires the complete generated solver job",
    )
    pool, _, _, _, _ = builder._pool(curriculum_ref)
    origin, _ = builder.generation_builder.read(pool["input"]["generationRef"])
    evidence = builder.round_evidence(commit_refs, curriculum_ref=curriculum_ref)
    commit = store.read_json(commit_refs[-1])
    checkpoint = store.read_json(commit["checkpointRef"])
    require(
        ctx.checkpoint["checkpointRef"] == commit["checkpointRef"]
        and ctx.checkpoint["hfSnapshotRef"] == checkpoint["hfExportRef"]
        and ctx.checkpoint["committedUpdate"] == checkpoint["committedUpdate"],
        "diagevo-memory-checkpoint",
        "memory context must follow the final consumed update",
    )
    diagnostician = clone(diagnostician or DiagEvoDiagnostician())
    binding = {
        "sourceDigest": digest_file(Path(__file__)),
        "operationId": ctx.operation_id,
        "commitRefs": list(commit_refs),
        "curriculumRef": curriculum_ref,
        "diagnosis": diagnosis.identity,
        "embedding": embedding.identity,
        "diagnostician": diagnostician.describe().to_dict(),
    }
    _freeze(Path(ctx.workspace) / "diagevo-committed-memory.json", json_value(binding))
    updater = DiagEvoMemoryUpdater(
        diagnose=diagnosis.diagnose,
        embed=embedding.embed,
        recover_diagnosis=diagnosis.recover,
        recover_embedding=embedding.recover,
        diagnosis_identity=diagnosis.identity,
        embedding_identity=embedding.identity,
        policy=builder.policy,
        diagnostician=diagnostician,
        max_diagnoses=diagnosis.max_calls,
        max_embeddings=embedding.max_calls,
    )
    output = await updater.update(
        ctx,
        evidence,
        memory=tuple(_cause(row) for row in pool["input"]["memory"]),
        nodes=tuple(SkillNode(**row) for row in origin["input"]["nodes"]),
    )
    result = updater.verify(ctx.workspace, operation_id=ctx.operation_id)
    require(result == output, "diagevo-memory-result", "memory verification differs from output")
    receipts, native_ids = [], set()
    tokens = dict(
        inputTokens=0, outputTokens=0, cachedInputTokens=0, reasoningOutputTokens=0, totalTokens=0
    )
    unknown_usage, embedding_tokens, embedding_seconds = [], 0, 0.0
    root = Path(ctx.workspace) / "diagevo-memory"
    saved_result = _read(root / "result.json")
    for key in sorted(saved_result["calls"]):
        intent = _read(root / "calls" / key / "intent.json")
        saved = _read(root / "calls" / key / "result.json")
        kind = intent["kind"]
        backend = diagnosis if kind == "diagnosis" else embedding
        receipt = backend.receipt(key)
        expected = {
            "key": key,
            "backend": backend.identity,
            "input" if kind == "diagnosis" else "text": intent["input"],
        }
        require(
            receipt["request"] == expected,
            "diagevo-native-call-drift",
            "native receipt must bind the exact memory request",
        )
        value = (
            json_value(json.loads(receipt["response"]))
            if kind == "diagnosis"
            else receipt["vector"]
        )
        require(
            value == saved["output"],
            "diagevo-native-output-drift",
            "native output differs from memory input",
        )
        if kind == "diagnosis":
            identity = (receipt["threadId"], receipt["turnId"])
            require(
                identity not in native_ids,
                "diagevo-native-call-reuse",
                "diagnostic turns cannot be counted twice",
            )
            native_ids.add(identity)
            if receipt["usage"] is None:
                unknown_usage.append(key)
            else:
                actual = receipt["usage"]["total"]
                require(
                    all(type(actual.get(name)) is int and actual[name] >= 0 for name in tokens)
                    and actual["totalTokens"] == actual["inputTokens"] + actual["outputTokens"]
                    and actual["cachedInputTokens"] <= actual["inputTokens"]
                    and actual["reasoningOutputTokens"] <= actual["outputTokens"],
                    "diagevo-native-usage",
                    "native token usage is incomplete or inconsistent",
                )
                for name in tokens:
                    tokens[name] += actual[name]
        else:
            embedding_tokens += receipt["inputTokens"]
            embedding_seconds += receipt["seconds"]
        receipts.append({"key": key, "kind": kind, "receiptRef": store.put_json(receipt)})
    artifact = {
        "schemaVersion": 1,
        "kind": "diagevo-committed-memory",
        "input": binding,
        "checkpointRef": commit["checkpointRef"],
        "memory": output,
        "callReceipts": receipts,
        "usage": {
            "diagnosticTurns": len(native_ids),
            "knownNativeTokens": tokens,
            "unknownUsageKeys": unknown_usage,
            "tokenUsageComplete": not unknown_usage,
            "usd": None,
            "embeddingInputTokens": embedding_tokens,
            "embeddingSeconds": embedding_seconds,
        },
    }
    return store.put_json(artifact)
