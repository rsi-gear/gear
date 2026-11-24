"""Authored synthetic environment source used as an explicit LLM generation fixture."""

import json

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_user_details",
            "description": "Read a customer.",
            "parameters": {
                "type": "object",
                "properties": {"user_id": {"type": "string"}},
                "required": ["user_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_order_details",
            "description": "Read an order.",
            "parameters": {
                "type": "object",
                "properties": {"order_id": {"type": "string"}},
                "required": ["order_id"],
                "additionalProperties": False,
            },
        },
    },
]

SOURCE = '''"""Exercise cross-record comparison using the original retail tool shapes.
The seeded records require reading the customer's orders and comparing values.
Success requires evidence gathering and the correct final order, not memorization.
This fixture is deliberately small; it is not a real LLM-generated environment.
"""
import json
import random

TOOLS = json.loads(__TOOLS_JSON__)

class CapabilityGame:
    max_steps = 8

    def reset(self, seed):
        rng = random.Random(seed)
        self.user_id = "customer_" + str(seed)
        self.ids = ["#S" + str(seed) + "A", "#S" + str(seed) + "B"]
        values = rng.sample(range(10, 90), 2)
        self.orders = {
            key: {"order_id": key, "user_id": self.user_id, "status": "pending", "items": [{"name": "shirt", "price": price}]}
            for key, price in zip(self.ids, values)
        }
        self.answer = self.ids[values.index(max(values))]
        self.reads = set()
        self.saw_user = False
        self.done = False
        self.steps = 0
        self.reward = 0.0
        self._conversation = [{"role": "user", "content": "My user ID is " + self.user_id + ". Which of my pending orders contains the more expensive shirt? Give its order ID."}]

    def get_system_prompt(self):
        return "The customer's identity has already been verified for this synthetic episode. Answer using the provided retail records. Read the customer's orders and compare their items; do not invent information."

    def get_tool_schemas(self):
        return TOOLS

    def get_messages(self):
        return list(self._conversation)

    def step(self, action):
        action = json.loads(action)
        name, arguments = action["name"], action["arguments"]
        self.steps += 1
        if name == "respond_to_user":
            message = arguments["message"]
            self._conversation.append({"role": "assistant", "content": message})
            self.done = True
            self.reward = (0.2 if self.saw_user else 0.0) + 0.2 * len(self.reads)
            if self.saw_user and self.reads == set(self.ids) and self.answer == message.strip():
                self.reward = 1.0
            return
        if name == "get_user_details":
            if arguments["user_id"] == self.user_id:
                self.saw_user = True
                response = {"user_id": self.user_id, "orders": self.ids}
            else:
                response = {"error": "unknown user"}
        elif name == "get_order_details":
            key = arguments["order_id"]
            if self.saw_user and key in self.orders:
                self.reads.add(key)
                response = self.orders[key]
            else:
                response = {"error": "authenticate and use an owned order"}
        else:
            raise ValueError("unknown tool")
        call_id = "call-" + str(self.steps)
        self._conversation.extend([
            {"role": "assistant", "content": None, "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]},
            {"role": "tool", "tool_call_id": call_id, "content": json.dumps(response)},
        ])

    def get_summary(self):
        return {"reward": self.reward, "steps": self.steps}

def reference_actions(seed):
    game = CapabilityGame()
    game.reset(seed)
    return [
        {"name": "get_user_details", "arguments": {"user_id": game.user_id}},
        *[{"name": "get_order_details", "arguments": {"order_id": key}} for key in game.ids],
        {"name": "respond_to_user", "arguments": {"message": game.answer}},
    ]
'''


def source(tools=None):
    selected = [
        tool
        for tool in tools or TOOLS
        if tool["function"]["name"] in {"get_user_details", "get_order_details"}
    ]
    return SOURCE.replace("__TOOLS_JSON__", repr(json.dumps(selected)))
