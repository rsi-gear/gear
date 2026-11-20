"""Explicit model and embedding fixtures, never evidence of real LLM improvement."""

import copy
import json

QA = (
    (
        "How should a customer be authenticated?",
        "Use an available identity lookup and verify the matched customer before accessing an order.",
    ),
    (
        "How should order ownership be checked?",
        "Read the order and check that it belongs to the authenticated customer before proceeding.",
    ),
    (
        "Which order status permits cancellation?",
        "Check the current status with the tool; cancel only a pending order under the policy.",
    ),
    (
        "How should a cancellation reason be handled?",
        "Ask for the reason and map it only to an allowed value supported by the customer's statement.",
    ),
    (
        "When is confirmation needed?",
        "Describe the specific proposed change and obtain explicit confirmation before the write.",
    ),
    (
        "How can a wrong-order write be avoided?",
        "Compare the write's order identifier to the customer's confirmed target immediately before submitting it.",
    ),
    (
        "When should cancellation be reported as complete?",
        "Report success only after inspecting the tool result that confirms the intended change.",
    ),
    (
        "What should happen after a tool error?",
        "Read the error, inspect the current state when needed, and resolve the cause without claiming the operation succeeded.",
    ),
)


class EmbeddingFixture:
    identity = {"kind": "explicit-embedding-fixture", "dimensions": 2}

    def __init__(self):
        self.calls = []

    def encode(self, text):
        self.calls.append(text)
        return {"vector": [1.0, 0.0], "tokens": len(text.split())}


class SelfDirectionCalls:
    identity = "explicit-selfdirection-fixture-v1"

    def __init__(self, steps, *, mode="success", max_calls=100):
        self.steps, self.mode = copy.deepcopy(steps), mode
        self.max_calls = max_calls
        self.receipts, self.submissions = {}, []
        self.interrupt_key = self.unknown_key = None

    async def call(self, key, prompt, harness, **settings):
        request = [prompt, harness, settings]
        if key in self.receipts:
            prior, receipt = self.receipts[key]
            if prior != request:
                raise ValueError("Self-Direction fixture request changed")
            return receipt
        if len(self.submissions) >= self.max_calls:
            raise RuntimeError("fixture logical-call quota exhausted")
        self.submissions.append(key)
        if key == self.unknown_key:
            receipt = {"status": "unknown", "fixture": True}
        else:
            data = json.loads(prompt)
            if key.endswith("/generate"):
                rows = list(QA)
                if self.mode == "too_few":
                    rows = rows[:-1]
                elif self.mode == "duplicate":
                    rows[-1] = tuple("  " + value + "  " for value in rows[0])
                response = {
                    "practices": [
                        {
                            "instruction": "Synthetic procedural practice " + str(i),
                            "family": data["plan"]["target"]["families"][0],
                            "data": {
                                "question": q,
                                "answer": a,
                                "rationale": "Explicit synthetic fixture rationale.",
                            },
                            "reference": "synthetic-procedure",
                            "verifier": "semantic-review",
                        }
                        for i, (q, a) in enumerate(rows)
                    ]
                }
            elif key.endswith("/validate"):
                response = {
                    "reviews": [
                        {
                            "draft_id": row["draft_id"],
                            "semantic_correctness": True,
                            "target_fidelity": True,
                            "novelty": True,
                            "reason": "Explicit semantic fixture, not execution evidence.",
                        }
                        for row in data["drafts"]
                    ]
                }
                if self.mode in ("semantic_reject", "semantic_unknown"):
                    response["reviews"][-1]["semantic_correctness"] = (
                        False if self.mode == "semantic_reject" else None
                    )
                if self.mode == "missing_review":
                    response["reviews"][-1] = response["reviews"][0]
            elif key.endswith("/action"):
                index = sum(row["role"] == "assistant" for row in data["conversation"])
                step = self.steps[min(index, len(self.steps) - 1)]
                if self.mode == "both_failed" or self.mode == "retry_failed" and "/retry/" in key:
                    step = {"kind": "finish", "text": "I stopped before finishing."}
                elif self.mode == "retry_incomplete" and "/retry/" in key:
                    step = self.steps[1]
                action = step.get("action", {"name": "", "arguments": {}})
                response = {
                    "kind": step["kind"],
                    "name": action["name"],
                    "arguments_json": json.dumps(action["arguments"]),
                    "text": step.get("text", ""),
                }
                response = {"action": response}
            elif key.endswith("/user"):
                response = {"message": "Yes, cancel #G100 with the refund to my original card."}
            elif key.endswith("/policy-audit"):
                response = {
                    "policy_compliant": data["trace"]["steps"][-1]["text"]
                    != "I stopped before finishing.",
                    "reason": "Explicit semantic fixture.",
                }
            else:
                raise AssertionError(key)
            receipt = {
                "status": "completed",
                "response": json.dumps(response),
                "fixture": True,
                "usage": {"total": {"total_tokens": 1}},
            }
        self.receipts[key] = request, receipt
        if key == self.interrupt_key:
            self.interrupt_key = None
            raise OSError("lost completed Self-Direction response")
        return receipt
