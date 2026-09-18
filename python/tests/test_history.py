import copy
import unittest
from types import SimpleNamespace

from gear_training.content import ContractError
from gear_training.history import ExactChatRenderer, generation_inputs


class ExactHistoryTests(unittest.TestCase):
    def setUp(self):
        self.previous = {"messages": [{"role": "user", "content": "task"}], "tools": [{"name": "bash"}]}
        self.wire = {"role": "assistant", "content": None, "tool_calls": [{"id": "call-1"}]}
        self.body = {**self.previous, "messages": [*self.previous["messages"], self.wire,
                     {"role": "tool", "tool_call_id": "call-1", "content": "observed"}]}
        self.closed = [10, 20, 30, 99, 13]
        self.rendered = [*self.closed, 77, 10, 20]
        self.renderer = ExactChatRenderer(lambda body, generation: self.rendered if generation else self.closed,
                                          [99], lambda ids: "\n" if ids == [13] else "unexpected")

    def continuation(self, **changes):
        values = {"body": self.body, "previous": self.previous, "wire": self.wire,
                  "inputs": [10, 20], "outputs": [500, 600, 99], "rendered": self.rendered, **changes}
        return self.renderer.continue_prompt(**values)

    def test_preserves_raw_policy_tokens_and_template_separator(self):
        # Normalized wire token 30 must never replace native tokens 500, 600.
        self.assertEqual(self.continuation(), [10, 20, 500, 600, 99, 13, 77, 10, 20])

    def test_rejects_rewritten_history_schema_and_tool_identity(self):
        changes = [lambda b: b["messages"][0].update(content="changed"),
                   lambda b: b["messages"][1].update(content="rewritten assistant"),
                   lambda b: b.update(tools=[]),
                   lambda b: b["messages"][-1].update(tool_call_id="other"),
                   lambda b: b["messages"].append({"role": "user", "content": "branch"})]
        for mutate in changes:
            with self.subTest(mutate=mutate):
                body = copy.deepcopy(self.body)
                mutate(body)
                with self.assertRaises(ContractError):
                    self.continuation(body=body)

    def test_rejects_unknown_eos_unstable_template_and_nonwhitespace_tail(self):
        with self.assertRaises(ContractError):
            self.continuation(outputs=[500, 98])
        with self.assertRaises(ContractError):
            self.continuation(rendered=[11, *self.rendered[1:]])
        self.renderer.decode = lambda ids: "hidden template content"
        with self.assertRaises(ContractError):
            self.continuation()

    def test_multiple_tool_results_must_match_every_call_in_order(self):
        wire = {**self.wire, "tool_calls": [{"id": "call-1"}, {"id": "call-2"}]}
        results = [{"role": "tool", "tool_call_id": name, "content": "result"} for name in ("call-1", "call-2")]
        body = {**self.body, "messages": [*self.previous["messages"], wire, *results]}
        self.assertEqual(self.continuation(body=body, wire=wire)[:5], [10, 20, 500, 600, 99])
        for changed in ([*reversed(results)], results[:1]):
            with self.assertRaises(ContractError):
                self.continuation(body={**body, "messages": [*self.previous["messages"], wire, *changed]}, wire=wire)

    def test_original_request_retry_uses_saved_input_after_later_receipts(self):
        data = {"first": {"requestId": "request-0", "rawRequestRef": "request", "inputTokenIdsRef": "inputs"},
                "later": {"requestId": "request-1"}, "request": {"agent": self.previous}, "inputs": [123, 456]}
        store = SimpleNamespace(read_json=data.__getitem__)
        ledger = SimpleNamespace(generation_history=lambda episode: ["first", "later", None])
        renderer = lambda body: self.fail("retry must not rebuild or replace the original prompt")
        self.assertEqual(generation_inputs(store, ledger, {"id": "episode"}, self.previous, renderer, "request-0"), [123, 456])
        with self.assertRaises(ContractError):
            generation_inputs(store, ledger, {"id": "episode"}, {**self.previous, "tools": []}, renderer, "request-0")
        with self.assertRaises(ContractError):
            generation_inputs(store, ledger, {"id": "episode"}, self.previous, renderer, "request-2")


if __name__ == "__main__":
    unittest.main()
