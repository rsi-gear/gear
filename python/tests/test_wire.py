import json
import unittest
from dataclasses import dataclass, field

from gear_training.wire import complete_tool_reply


@dataclass(frozen=True)
class Parsed:
    text: str = ""
    tool_uses: list = field(default_factory=list)


class CompleteToolReplyTests(unittest.TestCase):
    def test_all_parsed_calls_survive_an_adapter_that_returns_only_the_first(self):
        count = 0

        def upstream(parsed, finish):
            nonlocal count
            count += 1
            calls = [{"id": f"call-{count}-{i}", "function": {"name": t["name"], "arguments": json.dumps(t["input"])}}
                     for i, t in enumerate(parsed.tool_uses)]
            return {"content": None, "tool_calls": calls[:1]}, {}, "tool_calls"

        parsed = Parsed(tool_uses=[{"name": "bash", "input": {"command": "cat first"}},
                                  {"name": "bash", "input": {"command": "cat second"}}])
        reply, finish = complete_tool_reply(parsed, "stop", upstream)
        self.assertEqual(finish, "tool_calls")
        self.assertEqual([json.loads(c["function"]["arguments"])["command"] for c in reply["tool_calls"]], ["cat first", "cat second"])
        self.assertEqual(len({c["id"] for c in reply["tool_calls"]}), 2)
        self.assertEqual(len(parsed.tool_uses), 2)

    def test_text_only_reply_retains_upstream_terminal_semantics(self):
        for finish in ("stop", "length"):
            with self.subTest(finish=finish):
                reply, actual = complete_tool_reply(Parsed(text="answer"), finish,
                    lambda p, f: ({"content": p.text}, {}, f))
                self.assertEqual((reply, actual), ({"content": "answer"}, finish))


if __name__ == "__main__":
    unittest.main()
