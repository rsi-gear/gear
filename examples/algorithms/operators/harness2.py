"""Minimal blind continual-learning data flow; not a paper-effectiveness claim."""

from gear.ops import (
    Algorithm,
    ArtifactRef,
    CommitLibrary,
    CommitLibraryInput,
    CompleteTask,
    CompleteTaskInput,
    Decision,
    ExecutionInput,
    FileContent,
    Meta,
    MetaInput,
    PublishLibrary,
    PublishLibraryInput,
    Rollout,
    SamplePlan,
    TargetFiles,
    TaskSamples,
    Terminal,
)


class BlindLearning(Algorithm):
    def __init__(
        self, rollout=None, reflect=None, commit=None, publish=None, complete=None
    ):
        self.rollout = rollout if rollout is not None else Rollout()
        self.reflect = (
            reflect
            if reflect is not None
            else Meta(
                "Suggest a reusable instruction from the target output, without ground-truth feedback.",
                {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
            )
        )
        self.commit = commit if commit is not None else CommitLibrary()
        self.publish = publish if publish is not None else PublishLibrary()
        self.complete = complete if complete is not None else CompleteTask()

    def step(self, view, state):
        assert view.objective is None and view.stream is not None
        phase = state.data.get("phase", 0)
        data = {}
        if phase:
            result = view.results.require(state.data["pending"])
            if result.status != "succeeded":
                return Decision(
                    state,
                    reason="effect failed",
                    terminal=Terminal("stop", outcome=result.error),
                )
            if phase == 5:
                phase = 0
        if view.stream["complete"]:
            return Decision(
                state,
                reason="finite task stream complete",
                terminal=Terminal(
                    "stop",
                    outcome={
                        "library": state.data["library"],
                        "outputs": view.stream["completed"],
                    },
                ),
            )
        task = view.stream["current_task"]
        assert task in {item.id for item in view.tasks}
        assert all(item.input is not None for item in view.tasks)
        library = (
            ArtifactRef(**state.data["library"]) if state.data.get("library") else None
        )
        if phase == 0:
            call = self.rollout(
                ExecutionInput(
                    view.anchor,
                    SamplePlan((TaskSamples(task, (0,)),)),
                    assets=(library,) if library else (),
                ),
                key=f"{task}/rollout",
            )
        elif phase == 1:
            output = result.value["records"][0]
            data["selected"] = output
            call = self.reflect(
                MetaInput(
                    view.anchor,
                    (task,),
                    (
                        ArtifactRef(**output["output"]),
                        ArtifactRef(**output["trajectory"]),
                    ),
                ),
                key=f"{task}/reflect",
            )
        elif phase == 2:
            call = self.commit(
                CommitLibraryInput(
                    library,
                    {},
                    TargetFiles(
                        {"AGENTS.md": FileContent(result.value["text"])}
                    ).to_dict(),
                ),
                key=f"{task}/commit",
            )
        elif phase == 3:
            library = ArtifactRef(**result.value["snapshot"])
            data["library"] = library
            call = self.publish(
                PublishLibraryInput("learned-skills", library, state.data.get("head")),
                key=f"{task}/publish",
            )
        else:
            data["publication_status"] = result.value["status"]
            if result.value["status"] == "published":
                data["head"] = result.value["revision"]
            selected = state.data["selected"]
            call = self.complete(
                CompleteTaskInput(
                    task,
                    selected["sample_id"],
                    ArtifactRef(**selected["output"]),
                    view.stream["revision"],
                    (library,),
                ),
                key=f"{task}/complete",
            )
        return Decision(
            state.updated(phase=phase + 1, pending=call.ref, **data),
            (call,),
            "advance blind learning",
        )
