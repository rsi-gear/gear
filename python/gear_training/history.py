"""Preserve native policy tokens when the wire tool reply is normalized."""
from __future__ import annotations

from .content import canonical, require
from .samples import token_ids


def generation_inputs(store, ledger, context, body, renderer, request_id):
    history = ledger.generation_history(context["id"])
    receipts = [store.read_json(ref) for ref in history if ref is not None]
    # A replay uses its original prompt even after later calls completed. The
    # ledger still checks the request digest, ownership and pending state.
    for receipt in receipts:
        if receipt["requestId"] == request_id:
            original = store.read_json(receipt["rawRequestRef"])["agent"]
            require(canonical(original) == canonical(body), "request-retry-conflict", "idempotency key was reused for another request")
            return token_ids(store.read_json(receipt["inputTokenIdsRef"]))
    require(len(receipts) == len(history), "request-inflight", "previous generation has pending or invalid evidence")
    rendered = token_ids(renderer(body))
    if not receipts or not hasattr(renderer, "continue_prompt"):
        return rendered
    previous = receipts[-1]
    require(previous["finishReason"] == "tool-call", "nonlinear-token-history", "only a completed tool turn can continue this episode")
    request = store.read_json(previous["rawRequestRef"])["agent"]
    wire = store.read_json(previous["rawResponseRef"])["wire"]["choices"][0]["message"]
    inputs = token_ids(store.read_json(previous["inputTokenIdsRef"]))
    outputs = token_ids(store.read_json(previous["outputTokenIdsRef"]))
    return renderer.continue_prompt(body, request, wire, inputs, outputs, rendered)


class ExactChatRenderer:
    def __init__(self, render, eos_token_ids, decode):
        self.render = render
        self.eos_token_ids = set(eos_token_ids)
        self.decode = decode

    def __call__(self, body):
        return self.render(body, True)

    def continue_prompt(self, body, previous, wire, inputs, outputs, rendered):
        prefix_messages = [*previous["messages"], wire]
        messages = body["messages"]
        require(canonical(body.get("tools")) == canonical(previous.get("tools")),
                "nonlinear-token-history", "tool schema changed during an episode")
        require(len(messages) > len(prefix_messages) and canonical(messages[:len(prefix_messages)]) == canonical(prefix_messages),
                "nonlinear-token-history", "client rewrote or omitted the previous wire history")
        observations = messages[len(prefix_messages):]
        calls = wire.get("tool_calls") or []
        require(calls and len(observations) == len(calls)
                and all(m.get("role") == "tool" and m.get("tool_call_id") == c["id"] for m, c in zip(observations, calls)),
                "nonlinear-token-history", "continuation must contain exactly the issued tool results in order")
        require(outputs and outputs[-1] in self.eos_token_ids, "unsupported-turn-boundary", "native tool output must retain its explicit EOS token")
        closed = token_ids(self.render({**body, "messages": prefix_messages}, False))
        require(rendered[:len(closed)] == closed, "unsupported-turn-boundary", "chat template does not have a stable completed-turn prefix")
        boundaries = [i for i, token in enumerate(closed) if token == outputs[-1]]
        require(boundaries, "unsupported-turn-boundary", "chat template omitted the native turn delimiter")
        end = boundaries[-1] + 1
        require(not self.decode(closed[end:]).strip(), "unsupported-turn-boundary", "chat template has non-whitespace after the completed turn")
        # Only append template separators and new tool observations. The original
        # input and ALL generated tokens remain unchanged, including text a tool
        # parser normalized or omitted from its structured wire reply.
        return [*inputs, *outputs, *rendered[end:]]
