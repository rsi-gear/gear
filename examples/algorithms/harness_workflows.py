"""Harness workflow examples built only from the public durable author API."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict
from statistics import mean
from typing import ClassVar, cast

from gear.algorithms import ResearchRecord, Role, WorkflowAlgorithm
from gear.canonical import JSON


def _tasks(ctx, name):
    tasks = getattr(ctx.data, name)
    if not tasks:
        raise ValueError("workflow requires nonempty " + name)
    return tasks


async def _measure(ctx, candidate, tasks, key, repetitions=1):
    measured = await ctx.measure(
        candidate, tasks=tasks, group=key, key=key, repetitions=repetitions
    )
    return measured, [asdict(row) for row in measured.observations]


def _score(measured):
    if not measured.ok:
        raise ValueError("selection requires complete scored observations")
    return mean(float(row.evidence.score) for row in measured.observations)


def _record(ctx, key, tasks, candidates, data):
    ctx.record(
        ResearchRecord(
            "ranking",
            "global",
            tuple(task.id for task in tasks),
            tuple(candidate.id for candidate in candidates),
            cast(JSON, data),
        ),
        key=key,
    )


class AHE(WorkflowAlgorithm):
    roles: ClassVar[dict[str, Role]] = {
        "debugger": Role(
            "Analyze failures and successful habits in the supplied trajectories.",
            {"type": "string"},
        ),
        "evolve": Role(
            "Edit the allowed files using the evidence and previous change outcomes. "
            "Return failure_evidence, root_cause, targeted_fix, and changes. Each change has path, "
            "predicted_fix_tasks and risk_tasks. Declare every changed file.",
            {"type": "object"},
            edits=True,
        ),
    }

    def __init__(self, max_steps=3, dataset="train", use_debugger=True):
        self.configuration = {
            "max_steps": max_steps,
            "dataset": dataset,
            "use_debugger": use_debugger,
        }
        self.max_steps, self.dataset, self.use_debugger = (
            max_steps,
            dataset,
            use_debugger,
        )

    async def run(self, ctx):
        tasks = _tasks(ctx, self.dataset)
        current = ctx.inputs.anchor
        measured, rows = await _measure(ctx, current, tasks, "baseline")
        previous, declined = {}, []
        for step in range(self.max_steps):
            reports = []
            if self.use_debugger:
                for i, row in enumerate(rows):
                    answer = await ctx.roles.call(
                        "debugger",
                        candidate=current,
                        tasks=tasks,
                        inputs=cast(JSON, row),
                        key=f"{step}/debug/{i}",
                    )
                    if answer.ok:
                        reports.append(answer.data)
            draft = await ctx.workspaces.open(base=current, key=f"{step}/open")
            edit = await ctx.roles.call(
                "evolve",
                workspace=draft,
                tasks=tasks,
                key=f"{step}/edit",
                inputs=cast(
                    JSON,
                    {
                        "rows": rows,
                        "reports": reports,
                        "previous": previous,
                        "declined": declined[-4:],
                    },
                ),
            )
            if not edit.ok:
                declined.append({"step": step, "reason": edit.data})
                await ctx.workspaces.discard(draft, key=f"{step}/discard")
                continue
            draft = edit.revision
            diff = await ctx.artifacts.diff(current, draft, key=f"{step}/diff")
            manifest = edit.data
            changes = manifest.get("changes", []) if isinstance(manifest, dict) else []
            paths = [row.get("path") for row in changes if isinstance(row, dict)]
            actual = [row["path"] for row in diff["files"]]
            if (
                not actual
                or not all(isinstance(path, str) for path in paths)
                or sorted(paths) != sorted(actual)
                or not all(manifest.get(k) for k in ("root_cause", "targeted_fix"))
            ):
                declined.append(
                    {
                        "step": step,
                        "reason": "manifest differs from actual changed paths",
                    }
                )
                await ctx.workspaces.discard(draft, key=f"{step}/discard")
                continue
            before_files = (await ctx.artifacts.list(current, key=f"{step}/list"))[
                "resources"
            ]
            old_paths = [
                path
                for path in actual
                if any(row["path"] == path for row in before_files)
            ]
            rollback = (
                await ctx.artifacts.read(
                    current, paths=old_paths, key=f"{step}/rollback"
                )
                if old_paths
                else {}
            )
            child = await ctx.workspaces.seal(draft, key=f"{step}/seal")
            after, after_rows = await _measure(ctx, child, tasks, f"{step}/measure")
            old = {
                row.evidence.task_id: row.evidence.score
                for row in measured.observations
            }
            new = {
                row.evidence.task_id: row.evidence.score for row in after.observations
            }
            previous = {
                "manifest": manifest,
                "rollback_sources": rollback,
                "task_delta": {
                    task: None
                    if old[task] is None or new[task] is None
                    else new[task] - old[task]
                    for task in old
                },
            }
            _record(
                ctx,
                f"{step}/decision",
                tasks,
                [current, child],
                {"accepted": True, **previous},
            )
            current, measured, rows = child, after, after_rows
        return ctx.result(
            selected=current,
            data=cast(JSON, {"previous": previous, "declined": declined}),
            reason="AHE edits complete",
        )


class MetaHarness(WorkflowAlgorithm):
    roles: ClassVar[dict[str, Role]] = {
        "meta": Role(
            "Inspect the read-only history sources and observations. Edit this seed checkout "
            "into a new general design. Return its account.",
            {"type": "string"},
            edits=True,
        )
    }

    def __init__(self, max_steps=20, require_trajectories=True):
        self.max_steps = max_steps
        self.require_trajectories = require_trajectories
        self.configuration = {
            "max_steps": max_steps,
            "require_trajectories": require_trajectories,
        }

    async def run(self, ctx):
        tasks = _tasks(ctx, "dev")
        seed = best = ctx.inputs.anchor
        baseline, rows = await _measure(ctx, seed, tasks, "baseline")
        best_score = _score(baseline)

        async def entry(candidate, measured, rows, key):
            traces = []
            for i, trial in enumerate(measured.observations):
                if not any(
                    isinstance(artifact, dict) and artifact.get("status") == "available"
                    for artifact in trial.artifacts
                ):
                    if self.require_trajectories:
                        raise ValueError(
                            "Meta-Harness requires complete readable trajectories"
                        )
                    traces.append({"trial_id": trial.id, "status": "unavailable"})
                    continue
                pages = []
                query = {"limit": 50}
                while True:
                    page = await ctx.evidence.trajectory(
                        trial, key=f"{key}/{i}/{len(pages)}", query=query
                    )
                    pages.append(page.data)
                    if page.data["eof"]:
                        break
                    query = {"limit": 50, "cursor": page.data["next_cursor"]}
                    if len(json.dumps(pages).encode()) > 1024 * 1024:
                        raise ValueError(
                            "Meta-Harness trajectory exceeds explicit material budget"
                        )
                traces.append(
                    {
                        "trial_id": trial.id,
                        "status": "complete-canonical-session",
                        "pages": pages,
                    }
                )
            return {
                "candidate_id": candidate.id,
                "score": _score(measured),
                "observations": rows,
                "trajectories": traces,
            }

        versions = [seed]
        history = [await entry(seed, baseline, rows, "baseline-traces")]
        for step in range(self.max_steps):
            material = await ctx.artifacts.material(
                cast(JSON, history), key=f"{step}/history"
            )
            edit = await ctx.roles.call(
                "meta",
                candidate=seed,
                tasks=tasks,
                key=f"{step}/edit",
                references={f"version{i}": value for i, value in enumerate(versions)},
                materials={"history": material},
            )
            if not edit.ok:
                continue
            candidate = edit.candidate
            measured, rows = await _measure(ctx, candidate, tasks, f"{step}/measure")
            value = _score(measured)
            versions.append(candidate)
            item = await entry(candidate, measured, rows, f"{step}/traces")
            item["account"] = edit.data
            history.append(item)
            if value > best_score:
                best, best_score = candidate, value
        return ctx.result(
            selected=best,
            data=cast(JSON, {"history": history}),
            reason="Meta-Harness history search complete",
        )


class EvoHarness(WorkflowAlgorithm):
    package_dependencies = ("PyYAML",)
    roles: ClassVar[dict[str, Role]] = {
        "reflect": Role(
            "Extract lesson, trigger, evidence and scope_hint from this failed initial attempt. "
            "Return skip=true if it supplies no reusable lesson.",
            {"type": "object"},
        ),
        "curator": Role(
            "Edit only managed native SKILL.md files at the requested level. Use YAML frontmatter "
            "with name,description, and gear={algorithm:evo_harness,level:topic|general,source_task_ids:[...]}. "
            "Cite the supplied batch's source task IDs and keep other skills intact.",
            {"type": "string"},
            edits=True,
        ),
    }

    def __init__(
        self,
        batch_size=2,
        general_min_tasks=2,
        max_topic_skills=32,
        max_general_skills=16,
        max_skill_chars=4096,
    ):
        self.configuration = {
            "batch_size": batch_size,
            "general_min_tasks": general_min_tasks,
            "max_topic_skills": max_topic_skills,
            "max_general_skills": max_general_skills,
            "max_skill_chars": max_skill_chars,
        }
        self.batch_size, self.general_min_tasks = batch_size, general_min_tasks
        self.max_topic_skills, self.max_general_skills, self.max_skill_chars = (
            max_topic_skills,
            max_general_skills,
            max_skill_chars,
        )

    async def _library(self, ctx, version, key):
        import yaml

        listing = await ctx.artifacts.list(version, key=key + "/list")
        root = listing["harness"].get("skillRoot")
        if not root:
            raise ValueError("Harness does not declare a skill root")
        paths = [
            row["path"]
            for row in listing["resources"]
            if row["path"].startswith(root + "/") and row["path"].endswith("/SKILL.md")
        ]
        files = (
            await ctx.artifacts.read(version, paths=paths, key=key + "/read")
            if paths
            else {}
        )
        library = {}
        for path, text in files.items():
            if not text.startswith("---\n"):
                continue
            sections = text.split("---", 2)
            try:
                metadata = yaml.safe_load(sections[1])
            except yaml.YAMLError as error:
                raise ValueError("invalid skill frontmatter") from error
            provenance = metadata.get("gear", {}) if isinstance(metadata, dict) else {}
            if provenance.get("algorithm") != "evo_harness":
                continue
            level = provenance.get("level")
            sources = provenance.get("source_task_ids", [])
            if (
                level not in ("topic", "general")
                or not isinstance(sources, list)
                or not sources
                or not all(isinstance(s, str) for s in sources)
                or len(set(sources)) != len(sources)
            ):
                raise ValueError("invalid managed skill provenance")
            if (
                not metadata.get("name")
                or not metadata.get("description")
                or not sections[2].strip()
                or len(sections[2]) > self.max_skill_chars
            ):
                raise ValueError("invalid managed skill content")
            library[path] = {"level": level, "source_task_ids": sources}
        if (
            sum(value["level"] == "topic" for value in library.values())
            > self.max_topic_skills
            or sum(value["level"] == "general" for value in library.values())
            > self.max_general_skills
        ):
            raise ValueError("managed skill count exceeded")
        return root, set(files), library

    async def run(self, ctx):
        tasks = _tasks(ctx, "train")
        current = ctx.inputs.anchor
        initial_scores = []
        declined = []
        for start in range(0, len(tasks), self.batch_size):
            step = start // self.batch_size
            batch = tasks[start : start + self.batch_size]
            measured, rows = await _measure(ctx, current, batch, f"{step}/initial")
            initial_scores.extend(
                row.evidence.score
                for row in measured.observations
                if row.evidence.score is not None
            )
            memories = []
            for i, row in enumerate(rows):
                if (
                    row["execution_status"] == "finished"
                    and row["evidence"]["score"] is not None
                    and row["evidence"]["score"] >= 1
                ):
                    continue
                reflection = await ctx.roles.call(
                    "reflect",
                    candidate=current,
                    tasks=batch,
                    inputs=cast(JSON, row),
                    key=f"{step}/reflect/{i}",
                )
                memory = reflection.data
                if (
                    reflection.ok
                    and isinstance(memory, dict)
                    and not memory.get("skip")
                ) and all(
                    memory.get(field)
                    for field in ("lesson", "trigger", "evidence", "scope_hint")
                ):
                    memories.append({"task_id": row["task_id"], **memory})
            if not memories:
                continue
            for level in ("topic", "general"):
                key = f"{step}/{level}"
                root, before_files, before = await self._library(
                    ctx, current, key + "/before"
                )
                draft = await ctx.workspaces.open(base=current, key=key + "/open")
                edit = await ctx.roles.call(
                    "curator",
                    workspace=draft,
                    tasks=batch,
                    write_paths=[root],
                    inputs=cast(
                        JSON, {"level": level, "memories": memories, "library": before}
                    ),
                    key=key + "/edit",
                )
                if not edit.ok:
                    await ctx.workspaces.discard(draft, key=key + "/discard")
                    continue
                draft = edit.revision
                try:
                    _, _, after = await self._library(ctx, draft, key + "/after")
                    diff = await ctx.artifacts.diff(current, draft, key=key + "/diff")
                    sources = {memory["task_id"] for memory in memories}
                    for change in diff["files"]:
                        path = change["path"]
                        old, new = before.get(path), after.get(path)
                        if (path in before_files and not old) or (
                            change["after"] is not None and not new
                        ):
                            raise ValueError("unmanaged skill changed")
                        if (old and old["level"] != level) or (
                            new and new["level"] != level
                        ):
                            raise ValueError("curator changed another level")
                        if new and (
                            not set(new["source_task_ids"]) <= sources
                            or (
                                level == "general"
                                and len(new["source_task_ids"]) < self.general_min_tasks
                            )
                        ):
                            raise ValueError("skill lacks current batch evidence")
                    current = await ctx.workspaces.seal(draft, key=key + "/seal")
                except ValueError as error:
                    declined.append(
                        {"step": step, "level": level, "reason": str(error)}
                    )
                    await ctx.workspaces.discard(draft, key=key + "/discard")
        return ctx.result(
            selected=current,
            data=cast(
                JSON, {"online_score": mean(initial_scores), "declined": declined}
            ),
            reason="EvoHarness stream complete",
        )


class ModularRSI(WorkflowAlgorithm):
    roles: ClassVar[dict[str, Role]] = {
        "analyst": Role(
            "Compare the supplied successful and failed attempts for this module. Return findings.",
            {"type": "object"},
        ),
        "editor": Role(
            "Implement the supplied findings within the allowed module paths. For integration, inspect "
            "the read-only branch directories and combine compatible changes.",
            {"type": "string"},
            edits=True,
        ),
        "reviewer": Role(
            "Review every patch in the supplied complete actual diff. Return accept and reason.",
            {"type": "object"},
        ),
    }

    def __init__(self, modules: Mapping[str, list[str]], iterations=1, num_rollouts=2):
        self.modules = dict(modules)
        self.iterations = iterations
        self.num_rollouts = num_rollouts
        self.configuration = {
            "modules": self.modules,
            "iterations": iterations,
            "num_rollouts": num_rollouts,
        }

    async def _branch(self, ctx, base, name, paths, tasks, references):
        current = base
        history = []
        for step in range(self.iterations):
            key = f"{name}/{step}"
            _measured, rows = await _measure(
                ctx, current, tasks, key + "/contrast", self.num_rollouts
            )
            findings = await ctx.roles.call(
                "analyst",
                candidate=current,
                tasks=tasks,
                inputs=cast(JSON, {"module": name, "rows": rows, "history": history}),
                key=key + "/analyze",
            )
            if not findings.ok:
                continue
            draft = await ctx.workspaces.open(base=current, key=key + "/open")
            edit = await ctx.roles.call(
                "editor",
                workspace=draft,
                tasks=tasks,
                references=references,
                write_paths=paths,
                inputs=cast(JSON, {"module": name, "findings": findings.data}),
                key=key + "/edit",
            )
            if not edit.ok:
                await ctx.workspaces.discard(draft, key=key + "/discard")
                continue
            draft = edit.revision
            diff = await ctx.artifacts.diff(current, draft, key=key + "/diff")
            if diff["omitted_patches"]:
                await ctx.workspaces.discard(draft, key=key + "/discard")
                continue
            review = await ctx.roles.call(
                "reviewer",
                candidate=current,
                tasks=tasks,
                inputs=cast(JSON, diff),
                key=key + "/review",
            )
            if (
                not review.ok
                or not isinstance(review.data, dict)
                or review.data.get("accept") is not True
            ):
                await ctx.workspaces.discard(draft, key=key + "/discard")
                continue
            child = await ctx.workspaces.seal(draft, key=key + "/seal")
            gate, _ = await _measure(ctx, child, tasks, key + "/gate")
            finished = all(
                row.execution_status == "finished" for row in gate.observations
            )
            history.append(
                {"candidate_id": child.id, "finished": finished, "review": review.data}
            )
            if finished:
                current = child
        return current, history

    async def run(self, ctx):
        tasks = _tasks(ctx, "train")
        seed = ctx.inputs.anchor
        branches = {}
        histories = {}
        for name, paths in self.modules.items():
            branches[name], histories[name] = await self._branch(
                ctx, seed, name, paths, tasks, {}
            )
        current, integration = await self._branch(
            ctx,
            seed,
            "integration",
            list(
                dict.fromkeys(path for paths in self.modules.values() for path in paths)
            ),
            tasks,
            branches,
        )
        return ctx.result(
            selected=current,
            data=cast(
                JSON,
                {
                    "branches": {name: value.id for name, value in branches.items()},
                    "histories": histories,
                    "integration": integration,
                },
            ),
            reason="ModularRSI integration complete",
        )
