"""ACE-style deterministic playbook delta, materialized as a new candidate.

The reflector/curator supplies PlaybookDelta to this recipe at configuration
time. A production recipe can obtain that delta through its own Meta module.
"""

import json
from dataclasses import asdict

from gear.ops import (
    Algorithm,
    Decision,
    EditPlan,
    FileContent,
    FileEdit,
    MaterializeCandidate,
    MaterializeInput,
    MergePlaybook,
    PlaybookDelta,
    PlaybookEntry,
    PlaybookInput,
    Terminal,
)


class PlaybookUpdate(Algorithm):
    def __init__(
        self,
        text="Verify the task requirements before answering.",
        merger=None,
        editor=None,
    ):
        self.text = text
        self.merger = merger if merger is not None else MergePlaybook()
        self.editor = editor if editor is not None else MaterializeCandidate()

    def step(self, view, state):
        if state.data.get("pending"):
            result = view.results.require(state.data["pending"])
            return Decision(
                state,
                reason="exact playbook update completed",
                terminal=Terminal("stop", outcome=result.value),
            )
        delta = PlaybookDelta(add=(PlaybookEntry.create(self.text),))
        entries = self.merger(PlaybookInput((), delta))
        content = (
            json.dumps(
                [asdict(entry) for entry in entries], sort_keys=True, ensure_ascii=False
            )
            + "\n"
        )
        call = self.editor(
            MaterializeInput(
                view.anchor,
                EditPlan(
                    (
                        FileEdit(
                            "create",
                            ".pi/skills/playbook/entries.json",
                            None,
                            FileContent(content),
                        ),
                    )
                ),
            ),
            key="playbook-delta",
        )
        return Decision(
            state.updated(pending=call.ref),
            (call,),
            "apply deterministic playbook delta",
        )
