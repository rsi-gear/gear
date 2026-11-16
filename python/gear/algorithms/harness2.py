"""Blind continual learning through versioned target instructions and a finite task stream."""

from dataclasses import replace
from typing import Any, cast

from gear.core import (
    ArtifactInput,
    ArtifactRef,
    Call,
    CompleteTask,
    CompleteTaskInput,
    FileContent,
    Meta,
    MetaInput,
    ReadArtifact,
    StateTree,
    TargetFiles,
    decode_artifact_pages,
)
from gear.core._json import json_value
from gear.core.artifacts import relative_path
from gear.evaluation import ExecutionInput, Rollout, SamplePlan, TaskSamples
from gear.memory import CommitLibrary, CommitLibraryInput, PublishLibrary, PublishLibraryInput
from gear.search import Algorithm, Decision, SearchView, Terminal


class Harness2(Algorithm):
    """Learn from target outputs without score feedback.

    Requires a blind AccessPolicy with an explicit task_order. Each task receives
    the configured number of rounds before CompleteTask advances the stream.
    """

    def __init__(
        self,
        prompt_path: str = "AGENTS.md",
        rollout: Any = None,
        reflect: Any = None,
        reader: Any = None,
        commit: Any = None,
        publish: Any = None,
        complete: Any = None,
    ) -> None:
        self.prompt_path = relative_path(prompt_path)
        self.rollout = rollout if rollout is not None else Rollout()
        self.reflect = (
            reflect
            if reflect is not None
            else Meta(
                "Improve reusable working instructions from the target's output and trajectory, "
                "without ground-truth or score feedback. Return a complete replacement for "
                "current_prompt. Preserve the base prompt's tool access and output contracts. "
                "Keep useful learned instructions; do not embed task IDs or task-specific answers.",
                {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
            )
        )
        self.reader = reader if reader is not None else ReadArtifact(max_bytes=1024 * 1024)
        self.commit = commit if commit is not None else CommitLibrary()
        self.publish = publish if publish is not None else PublishLibrary()
        self.complete = complete if complete is not None else CompleteTask()

    @staticmethod
    def _call(state: StateTree, phase: str, call: Call[Any], **values: Any) -> Decision:
        return Decision(state.updated(phase=phase, pending=call.ref, **values), (call,), phase)

    def _rollout(self, view: SearchView, state: StateTree) -> Decision:
        data = cast(dict[str, Any], state.data)
        stream = cast(dict[str, Any], view.stream)
        library = ArtifactRef(**data["library"]) if data.get("library") else None
        task = stream["current_task"]
        return self._call(
            state,
            "rollout",
            self.rollout(
                ExecutionInput(
                    view.anchor,
                    SamplePlan((TaskSamples(task, (0,)),), mode="fresh", plan_id=None),
                    assets=(library,) if library else (),
                ),
                key=f"{task}/round-{data['round']}/rollout",
            ),
        )

    def step(self, view: SearchView, state: StateTree) -> Decision:
        if view.objective is not None or not isinstance(view.stream, dict):
            raise ValueError("Harness2 requires blind exposure and an explicit finite task order")
        stream = cast(dict[str, Any], view.stream)
        data = cast(dict[str, Any], state.data)
        phase = data.get("phase", "start")
        value: dict[str, Any] = {}
        if phase != "start":
            receipt = view.results.require(data["pending"])
            if receipt.status != "succeeded":
                return Decision(
                    state,
                    reason=f"{phase} failed",
                    terminal=Terminal(
                        "stop",
                        outcome=json_value(
                            {"status": "failed", "phase": phase, "error": receipt.error}
                        ),
                    ),
                )
            if not isinstance(receipt.value, dict):
                raise ValueError("learning calls must return object results")
            value = receipt.value
        if stream["complete"]:
            return Decision(
                state,
                reason="finite learning stream complete",
                terminal=Terminal(
                    "stop",
                    outcome=json_value(
                        {
                            "library": data.get("library"),
                            "outputs": stream["completed"],
                            "iterations": data.get("iterations", 0),
                            "rounds_per_task": view.budget["rounds"],
                        }
                    ),
                ),
            )
        task = stream["current_task"]
        if task not in {item.id for item in view.tasks}:
            raise ValueError("current stream task is not admitted")
        if phase == "start":
            return self._call(
                state,
                "read",
                self.reader(ArtifactInput(view.anchor, self.prompt_path), key="initial-prompt/0"),
                pages=[],
                round=0,
                iterations=0,
            )
        if phase == "read":
            pages = [*data["pages"], value]
            if not value["complete"]:
                return self._call(
                    state,
                    phase,
                    self.reader(
                        ArtifactInput(view.anchor, self.prompt_path, value["cursor"]),
                        key=f"initial-prompt/{len(pages)}",
                    ),
                    pages=pages,
                )
            text = decode_artifact_pages(tuple(pages), max_bytes=1024 * 1024).decode("utf-8")
            return self._rollout(
                view, state.updated(base_prompt=text, current_prompt=text, pages=[])
            )
        if phase == "complete":
            return self._rollout(view, state.updated(round=0))
        key = f"{task}/round-{data['round']}"
        library = ArtifactRef(**data["library"]) if data.get("library") else None
        if phase == "rollout":
            output = value["records"][0]
            return self._call(
                state,
                "reflect",
                self.reflect(
                    MetaInput(
                        view.anchor,
                        (task,),
                        (ArtifactRef(**output["output"]), ArtifactRef(**output["trajectory"])),
                        json_value(
                            {
                                "prompt_path": self.prompt_path,
                                "base_prompt": data["base_prompt"],
                                "current_prompt": data["current_prompt"],
                            }
                        ),
                    ),
                    key=key + "/reflect",
                ),
                selected=output,
            )
        if phase == "reflect":
            text = value["text"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError("learned prompt must contain nonempty text")
            return self._call(
                state,
                "commit",
                self.commit(
                    CommitLibraryInput(
                        library, {}, TargetFiles({self.prompt_path: FileContent(text)}).to_dict()
                    ),
                    key=key + "/commit",
                ),
                current_prompt=text,
            )
        if phase == "commit":
            library = ArtifactRef(**value["snapshot"])
            return self._call(
                state,
                "publish",
                self.publish(
                    PublishLibraryInput("learned-skills", library, data.get("head")),
                    key=key + "/publish",
                ),
                library=library,
            )
        if phase == "publish":
            changes = {"iterations": data["iterations"] + 1, "publication_status": value["status"]}
            if value["status"] == "published":
                changes["head"] = value["revision"]
            state = state.updated(**changes)
            record = {
                "kind": "learning_iteration",
                "task_id": task,
                "round": data["round"] + 1,
                "sample_id": data["selected"]["sample_id"],
                "library": data["library"],
            }
            if data["round"] + 1 < cast(int, view.budget["rounds"]):
                return replace(
                    self._rollout(view, state.updated(round=data["round"] + 1)), records=(record,)
                )
            selected = data["selected"]
            decision = self._call(
                state,
                "complete",
                self.complete(
                    CompleteTaskInput(
                        task,
                        selected["sample_id"],
                        ArtifactRef(**selected["output"]),
                        stream["revision"],
                        (library,) if library else (),
                    ),
                    key=f"{task}/complete",
                ),
            )
            return replace(decision, records=(record,))
        raise ValueError("unknown learning phase")
