"""Project every parsed call for Hitch's fixed sequential tool executor."""
from dataclasses import replace


def complete_tool_reply(parsed, native_finish, build_reply):
    # The pinned Slime adapter truncates parallel wire calls for other clients.
    # Hitch's fixed tool harness retains and executes every call sequentially.
    # Reuse Slime's single-call formatting instead of duplicating its codec.
    first = replace(parsed, tool_uses=parsed.tool_uses[:1])
    wire, _, finish = build_reply(first, native_finish)
    for tool_use in parsed.tool_uses[1:]:
        next_wire, _, _ = build_reply(replace(parsed, tool_uses=[tool_use]), native_finish)
        wire["tool_calls"].extend(next_wire["tool_calls"])
    return wire, finish
