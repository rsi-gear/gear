"""Run Meta-Harness from a preconfigured Terminal-Bench 2 Gear project."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

import yaml

from gear import Project
from gear.algorithms import MetaHarness

REFERENCE_COMMIT = "8123ccabe2b19fa1123090b2e5f1bacc20963ce8"
REFERENCE_DATASET_COMMIT = "dde3cd95b80ff25af5abd99a80b6513a018ad3b4"
REFERENCE_DATASET_REVISION = (
    f"terminal-bench/terminal-bench-2-1@{REFERENCE_DATASET_COMMIT}"
)
REFERENCE_TASK_IDS = frozenset(
    """
    adaptive-rejection-sampler bn-fit-modify break-filter-js-from-html
    build-cython-ext build-pmars build-pov-ray caffe-cifar-10 cancel-async-tasks
    chess-best-move circuit-fibsqrt cobol-modernization code-from-image
    compile-compcert configure-git-webserver constraints-scheduling
    count-dataset-tokens crack-7z-hash custom-memory-heap-crash db-wal-recovery
    distribution-search
    dna-assembly dna-insert extract-elf extract-moves-from-video
    feal-differential-cryptanalysis feal-linear-cryptanalysis filter-js-from-html
    financial-document-processor fix-code-vulnerability
    fix-git fix-ocaml-gc gcode-to-text git-leak-recovery git-multibranch
    gpt2-codegolf headless-terminal hf-model-inference install-windows-3.11
    kv-store-grpc large-scale-text-editing largest-eigenval
    llm-inference-batching-scheduler log-summary-date-ranges mailman
    make-doom-for-mips make-mips-interpreter mcmc-sampling-stan
    merge-diff-arc-agi-task model-extraction-relu-logits
    modernize-scientific-stack mteb-leaderboard mteb-retrieve
    multi-source-data-merger nginx-request-logging
    openssl-selfsigned-cert overfull-hbox password-recovery path-tracing-reverse
    path-tracing polyglot-c-py
    polyglot-rust-c portfolio-optimization protein-assembly prove-plus-comm pypi-server
    pytorch-model-cli pytorch-model-recovery qemu-alpine-ssh qemu-startup
    query-optimize raman-fitting regex-chess regex-log reshard-c4-data
    rstan-to-pystan sam-cell-seg sanitize-git-repo schemelike-metacircular-eval
    sparql-university sqlite-db-truncate sqlite-with-gcov
    torch-pipeline-parallelism torch-tensor-parallelism
    train-fasttext tune-mjcf video-processing vulnerable-secret
    winning-avg-corewars write-compressor
    """.split()
)
REFERENCE_REPETITIONS = 2
REFERENCE_PROPOSER_MODEL = "claude-opus-4-6"
REFERENCE_TARGET_MODEL = "anthropic/claude-opus-4-6"


def seed_task_id_error(seed_task_ids: list[str]) -> str | None:
    planned = [task_id.rsplit("/", 1)[-1] for task_id in seed_task_ids]
    planned_set = set(planned)
    missing = sorted(REFERENCE_TASK_IDS - planned_set)
    unexpected = sorted(planned_set - REFERENCE_TASK_IDS)
    duplicates = sorted(task_id for task_id in planned_set if planned.count(task_id) > 1)
    if not missing and not unexpected and not duplicates:
        return None
    return (
        "seed split does not match the pinned Terminal-Bench 2.1 task set; "
        f"missing={missing}, unexpected={unexpected}, duplicates={duplicates}"
    )


def configured_models(project_root: Path) -> dict[str, dict[str, str]]:
    """Read model identifiers from the profiles selected in gear.yaml."""
    config = yaml.safe_load((project_root / "gear.yaml").read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("gear.yaml must contain a project mapping")
    profile_root = Path(
        os.environ.get("GEAR_PROFILE_ROOT", Path.home() / ".config" / "gear" / "profiles")
    )
    models: dict[str, dict[str, str]] = {}
    for role in ("meta", "target"):
        role_config = config.get(role)
        profile_name = role_config.get("profile") if isinstance(role_config, dict) else None
        if not isinstance(profile_name, str) or not profile_name:
            raise ValueError(f"gear.yaml must select a {role}.profile")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", profile_name):
            raise ValueError(f"{role}.profile is not a valid Gear profile name")
        profile = json.loads((profile_root / f"{profile_name}.json").read_text(encoding="utf-8"))
        if not isinstance(profile, dict):
            raise ValueError(f"{role} profile must contain a JSON object")
        profile_configuration = profile.get("configuration")
        model = profile.get("model")
        if model is None and isinstance(profile_configuration, dict):
            model = profile_configuration.get("model")
        if not isinstance(model, str) or not model.strip():
            raise ValueError(f"{role} profile does not declare a model identifier")
        models[role] = {"profile": profile_name, "model": model}
    return models


def configured_meta_sampling(project_root: Path) -> dict[str, str | int | float | bool]:
    """Capture the explicit Gear Meta sampling controls without profile secrets."""
    config = yaml.safe_load((project_root / "gear.yaml").read_text(encoding="utf-8"))
    sampling = config.get("metaSampling", {}) if isinstance(config, dict) else None
    if not isinstance(sampling, dict):
        raise ValueError("gear.yaml metaSampling must be a mapping")
    allowed = {"temperature", "reasoningEffort"}
    if set(sampling) - allowed:
        raise ValueError("gear.yaml metaSampling has unsupported fields")
    if "reasoningEffort" in sampling and (
        not isinstance(sampling["reasoningEffort"], str) or not sampling["reasoningEffort"].strip()
    ):
        raise ValueError("metaSampling.reasoningEffort must be a nonempty string")
    if "temperature" in sampling and (
        type(sampling["temperature"]) not in (int, float)
        or not 0 <= sampling["temperature"] <= 2
    ):
        raise ValueError("metaSampling.temperature must be between 0 and 2")
    return sampling


def is_reference_proposer_model(model: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "-", model.lower()).strip("-")
    pattern = rf"(?:^|-){re.escape(REFERENCE_PROPOSER_MODEL)}(?:-|$)"
    return re.search(pattern, normalized) is not None


def model_label_error(role: str, supplied: str, configured: dict[str, str]) -> str | None:
    profile_name = configured["profile"]
    expected = configured["model"]
    if supplied != expected:
        option = "--proposer-model" if role == "meta" else "--evaluation-model"
        return f"{option} must match {role}.profile {profile_name!r} ({expected!r})"
    if role == "meta" and not is_reference_proposer_model(expected):
        return (
            "Meta-Harness Terminal-Bench 2 reference requires Claude Opus 4.6; "
            f"meta.profile {profile_name!r} uses {expected!r}"
        )
    if role == "target" and expected != REFERENCE_TARGET_MODEL:
        return (
            "Meta-Harness Terminal-Bench 2 reference runs the task agent with "
            f"{REFERENCE_TARGET_MODEL}; target.profile {profile_name!r} uses {expected!r}"
        )
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project", type=Path, required=True, help="Gear project containing gear.yaml"
    )
    parser.add_argument("--rounds", type=int, default=10)
    parser.add_argument(
        "--dataset-revision",
        choices=[REFERENCE_DATASET_REVISION],
        default=REFERENCE_DATASET_REVISION,
        help="Pinned Terminal-Bench 2.1 source revision",
    )
    parser.add_argument(
        "--proposer-model",
        required=True,
        help="Exact Meta proposer model/profile identifier",
    )
    parser.add_argument(
        "--evaluation-model",
        required=True,
        help="Exact task-evaluation model/profile identifier",
    )
    parser.add_argument(
        "--plan-only",
        action="store_true",
        help="Print the dry-run plan without running",
    )
    parser.add_argument(
        "--output", type=Path, help="Write the plan and run report as JSON"
    )
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("--rounds must be positive")

    project = Project.open(args.project)
    try:
        configured = configured_models(project.root)
        meta_sampling = configured_meta_sampling(project.root)
    except (OSError, ValueError, yaml.YAMLError) as error:
        parser.error(f"unable to read configured model profiles: {error}")
    for role, supplied in (
        ("meta", args.proposer_model),
        ("target", args.evaluation_model),
    ):
        error = model_label_error(role, supplied, configured[role])
        if error:
            parser.error(error)
    algorithm = MetaHarness()
    plan = project.plan_refine(algorithm=algorithm, rounds=args.rounds)
    seed_tasks = plan["tasks"]["seed"]
    repetitions = plan["repetitions"]
    candidates = plan["limits"]["new_candidates"]
    evaluation_budget = plan["limits"]["physical_trial_attempts"]
    minimum_evaluations = (
        plan["baseline"]["new_physical_trials"]
        + args.rounds * len(seed_tasks) * repetitions
        + plan["final_gate"]["physical_trials_for_anchor_and_nominee"]
    )
    task_error = seed_task_id_error(seed_tasks)
    if task_error:
        parser.error(task_error)
    if plan["tasks"]["held_out_count"] < 1:
        parser.error(
            "configure at least one separate held-out task to retain Gear's independent gate"
        )
    if repetitions != REFERENCE_REPETITIONS:
        parser.error(
            f"planned repetitions are {repetitions}; the pinned reference uses "
            f"{REFERENCE_REPETITIONS}"
        )
    if candidates < args.rounds:
        parser.error(
            "budget.max_candidates must be at least --rounds for one candidate "
            "per reference iteration"
        )
    if evaluation_budget < minimum_evaluations:
        parser.error(
            f"budget.max_evaluations is {evaluation_budget}; at least "
            f"{minimum_evaluations} physical trials are needed for the configured "
            "run and final gate"
        )
    result: dict[str, Any] = {
        "reference": {
            "repository": "stanford-iris-lab/meta-harness",
            "commit": REFERENCE_COMMIT,
            "variant": "Terminal-Bench 2",
        },
        "algorithm": "meta-harness",
        "dataset": {
            "name": "Terminal-Bench 2.1",
            "revision": args.dataset_revision,
            "manifest_repository": "harbor-framework/terminal-bench-2-1",
            "manifest_commit": REFERENCE_DATASET_COMMIT,
            "gear_benchmark_digest": plan["benchmark_digest"],
        },
        "split": {
            "seed_task_ids": seed_tasks,
            "held_out_task_count": plan["tasks"]["held_out_count"],
        },
        "models": {
            "proposer": args.proposer_model,
            "evaluation": args.evaluation_model,
            "profiles": {
                "proposer": configured["meta"]["profile"],
                "evaluation": configured["target"]["profile"],
            },
        },
        "meta_sampling": meta_sampling,
        "requested_rounds": args.rounds,
        "candidate_budget": candidates,
        "generation_request_budget": {"maximum_meta_operations": 2 * args.rounds},
        "evaluation_budget": {
            "maximum_physical_trials": evaluation_budget,
            "minimum_for_configured_run_and_final_gate": minimum_evaluations,
        },
        "plan": plan,
        "status": "planned",
    }
    if not args.plan_only:
        run = project.refine(algorithm=algorithm, rounds=args.rounds)
        result.update(run_id=run.id, report=run.report.summary, status="completed")

    encoded = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if args.output:
        args.output.write_text(encoded, encoding="utf-8")
    else:
        print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
