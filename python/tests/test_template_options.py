import unittest
from types import SimpleNamespace
from unittest.mock import patch

from gear_training import SLIME_COMMIT
from gear_training.content import ContractError, digest_json
from gear_training.gateway import slime_protocol
from gear_training.preflight import generation_protocol_digest, generation_template_kwargs


class TemplateOptionsTests(unittest.TestCase):
    def test_mode_is_locked_and_default_keeps_existing_protocol(self):
        config = {"toolParser": "qwen3_coder", "reasoningParser": "qwen3"}
        old = {"schemaVersion": 1, "api": "chat-completions", "capture": "exact-policy-tokens-v1",
               "adapter": "slime-openai-" + SLIME_COMMIT, "native": "sglang.generate.input_ids.output_token_logprobs.v1",
               "history": "native-token-prefix-tool-results-v1", "wireTools": "all-sequential-v1", **config}
        self.assertEqual(generation_protocol_digest(config), digest_json(old))
        self.assertEqual(generation_protocol_digest(config), generation_protocol_digest({**config, "chatTemplateKwargs": {}}))
        modes = [generation_protocol_digest({**config, "chatTemplateKwargs": {"enable_thinking": flag}}) for flag in (True, False)]
        self.assertEqual(len(set([generation_protocol_digest(config), *modes])), 3)

    def test_rejects_unlocked_or_invalid_template_parameters(self):
        for options in ([], None, True, {"enable_thinking": 1}, {"enable_thinking": "true"}, {"temperature": 0.1}):
            with self.subTest(options=options), self.assertRaises(ContractError):
                generation_protocol_digest({"chatTemplateKwargs": options})
        options = {"enable_thinking": True}
        returned = generation_template_kwargs({"chatTemplateKwargs": options})
        returned["enable_thinking"] = False
        self.assertTrue(options["enable_thinking"])

    def protocol(self, options=None):
        calls = []
        def apply(messages, **kwargs):
            calls.append(kwargs)
            ids = []
            for message in messages:
                ids += {"user": [10], "assistant": [20, 99, 13], "tool": [77]}[message["role"]]
            if kwargs["add_generation_prompt"]: ids += [1 if kwargs.get("enable_thinking") else 0]
            return ids
        tokenizer = SimpleNamespace(apply_chat_template=apply, eos_token_id=99, decode=lambda ids, **_: "\n" if ids == [13] else "native reasoning")
        modules = {name: SimpleNamespace() for name in ("slime", "slime.agent", "slime.agent.adapters")}
        modules.update({"slime.agent.adapters.openai": SimpleNamespace(_translate_messages=lambda m: m, _tools_to_chat_tools=lambda t: t, _build_reply_parts=None, _render_response=None),
                        "slime.agent.adapters.common": SimpleNamespace(_render_token_ids=lambda m, t, **kw: t.apply_chat_template(m, tokenize=True, **kw)),
                        "slime.agent.parsing": SimpleNamespace(parse_model_output=None)})
        with patch.dict("sys.modules", modules):
            renderer, _ = slime_protocol(tokenizer, chat_template_kwargs=options)
        return renderer, calls

    def test_configured_mode_preserves_raw_reasoning_and_tool_history(self):
        options = {"enable_thinking": True}
        renderer, calls = self.protocol(options)
        options["enable_thinking"] = False
        previous = {"messages": [{"role": "user", "content": "task"}], "tools": []}
        wire = {"role": "assistant", "content": None, "tool_calls": [{"id": "call-1"}]}
        body = {**previous, "messages": [*previous["messages"], wire, {"role": "tool", "tool_call_id": "call-1", "content": "observed"}],
                "chat_template_kwargs": {"enable_thinking": False}}
        inputs, outputs = renderer(previous), [500, 501, 99]
        continuation = renderer.continue_prompt(body, previous, wire, inputs, outputs, renderer(body))
        self.assertEqual(continuation, [10, 1, 500, 501, 99, 13, 77, 1])
        self.assertTrue(all(call["enable_thinking"] is True for call in calls))

    def test_unconfigured_mode_delegates_without_extra_template_arguments(self):
        renderer, calls = self.protocol()
        self.assertEqual(renderer({"messages": [{"role": "user", "content": "task"}]}), [10, 0])
        self.assertNotIn("enable_thinking", calls[0])


if __name__ == "__main__": unittest.main()
