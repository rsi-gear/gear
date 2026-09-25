import json
from pathlib import Path
import unittest

from gear_algorithm.author import (AuthorError, CAPABILITIES_VERSION, WIRE_VERSION,
                                   WIRE_VERSION_V2, algorithm, input_digest, replay)
from gear_algorithm.author.dto import (assert_author_capabilities_v1, assert_evaluation_v1,
                                       assert_harness_agent_v1, assert_proposal_batch_v1,
                                       assert_task_selection_v1, decode_role_execution_result)
from gear_algorithm.errors import ValidationError

DIGEST_A = "a" * 64
TASK_VIEW = {"kind": "artifact", "digest": "b" * 64, "size": 10,
             "mediaType": "application/json", "schemaId": "task.view.v1"}
AGENT = {"schemaVersion": 1, "kind": "harness-agent",
         "bindingSetRef": {"kind": "binding-set", "digest": "c" * 64, "schemaId": "binding.set.v1"},
         "executionProfileDigest": "d" * 64}


def request(version=WIRE_VERSION_V2, history=None, config=None):
    input_value = {"initialAgent": AGENT, "data": {}, "config": config or {}}
    if version == WIRE_VERSION_V2:
        input_value["capabilities"] = {"version": CAPABILITIES_VERSION,
                                       "lockDigest": DIGEST_A,
                                       "roles": {"analyst": {"template": "read-only-analyst", "kind": "execution.role"}},
                                       "operationLimits": {}, "execution": {}}
    return {"version": version, "input": input_value, "history": history or []}


def seal(frontier, values=None):
    values = values or {}
    return [{"address": item["address"], "kind": item["kind"],
             "definitionVersion": item["definitionVersion"],
             "inputDigest": input_digest({key: value for key, value in item.items()
                                          if key not in ("address", "kind", "definitionVersion")}),
             "outcome": values.get(item["address"], {"kind": "result", "value": {"ok": True}})}
            for item in frontier]


class A1AuthorSliceTests(unittest.TestCase):
    def test_shared_typescript_python_dto_vectors(self):
        vectors = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/author-a1-dto-vectors.json").read_text())
        validators = {"harnessAgent": assert_harness_agent_v1, "capabilities": assert_author_capabilities_v1,
                      "taskSelection": assert_task_selection_v1, "proposalBatch": assert_proposal_batch_v1,
                      "evaluation": assert_evaluation_v1,
                      "roleExecution": lambda value: decode_role_execution_result(value, AGENT["bindingSetRef"]["digest"])}
        for row in vectors:
            with self.subTest(row=row["name"]):
                if row["valid"]:
                    validators[row["validator"]](row["value"])
                else:
                    with self.assertRaises(ValidationError):
                        validators[row["validator"]](row["value"])

    def test_declared_config_schema_and_v1_describe_compatibility(self):
        @algorithm
        async def original(ctx):
            return await ctx.operation("custom", {})
        self.assertEqual(original.describe(), {"apiVersion": WIRE_VERSION,
                                               "id": "original", "definitionVersion": "algorithm.v1"})
        schema = {"type": "object", "properties": {"rounds": {"type": "integer"}},
                  "required": ["rounds"], "additionalProperties": False}
        @algorithm(config_schema=schema)
        async def declared(ctx):
            return await ctx.operation("custom", {"rounds": ctx.config.rounds})
        schema["properties"]["rounds"]["type"] = "string"
        self.assertEqual(declared.describe()["configSchema"]["properties"]["rounds"]["type"], "integer")
        with self.assertRaises(ValidationError):
            replay(declared, request(config={"rounds": "one"}))
        first = replay(declared, request(config={"rounds": 2}))
        self.assertEqual(first["frontier"][0]["definitionVersion"], "algorithm.v2")

    def test_v2_integral_json_numbers_work_as_python_integers(self):
        schema = {"type": "object", "properties": {"rounds": {"type": "integer"},
                                                   "temperature": {"type": "number"}},
                  "required": ["rounds", "temperature"], "additionalProperties": False}
        @algorithm(config_schema=schema)
        async def numeric(ctx):
            return ctx.result(outputs={"indices": list(range(ctx.config.rounds)),
                                       "temperature": ctx.config.temperature})
        output = replay(numeric, request(config={"rounds": 2.0, "temperature": 0.4}))
        self.assertEqual(output["result"]["outputs"], {"indices": [0, 1], "temperature": 0.4})
        for bad in (True, float(2**53)):
            with self.assertRaises(ValidationError):
                replay(numeric, request(config={"rounds": bad, "temperature": 0.4}))

    def test_v2_role_and_task_sample_wire_and_snake_case(self):
        task_view = TASK_VIEW
        @algorithm
        async def sample(ctx):
            role = await ctx.role("analyst", {"goal": "review"})
            selected = await ctx.tasks.sample(task_view, count=2.0, seed=7.0)
            return ctx.result(outputs={"role": role.output, "selected": selected.task_view_ref})
        first = replay(sample, request())
        self.assertEqual(first["frontier"], [{"address": "r/s0", "definitionVersion": "algorithm.v2",
                                            "kind": "execution.role", "input": {"roleId": "analyst", "input": {"goal": "review"}},
                                            "bindingSetRef": AGENT["bindingSetRef"], "limits": {}}])
        role_value = {"requestedBindingSetDigest": AGENT["bindingSetRef"]["digest"], "actualBindings": {},
                      "structuredResult": {"name": "analyst"},
                      "structuredResultRef": {**task_view, "schemaId": "execution.structured-result.v1"},
                      "evidenceRef": task_view, "receiptRef": {**task_view, "schemaId": "execution.receipt.v1"}}
        second = replay(sample, request(history=seal(first["frontier"],
                                                     {"r/s0": {"kind": "result", "value": role_value}})))
        self.assertEqual(second["frontier"][0]["definitionVersion"], "algorithm.v2")
        self.assertEqual(second["frontier"][0]["kind"], "tasks.sample")
        self.assertEqual(second["frontier"][0]["limits"], {})
        self.assertEqual(second["frontier"][0]["input"],
                         {"sourceTaskViewRef": task_view, "count": 2, "seed": 7})
        selection = {"schemaVersion": 1, "taskViewRef": task_view,
                     "selectedTaskIds": ["task-1", "task-2"],
                     "cursor": {"viewDigest": task_view["digest"], "nextIndex": 0}}
        complete = replay(sample, request(history=seal(first["frontier"],
                                                     {"r/s0": {"kind": "result", "value": role_value}})
                                          + seal(second["frontier"],
                                                 {"r/s1": {"kind": "result", "value": selection}})))
        self.assertEqual(complete["result"]["outputs"]["selected"], task_view)
        with self.assertRaises(AuthorError):
            replay(sample, request(history=seal(first["frontier"],
                                                 {"r/s0": {"kind": "result", "value": {**role_value,
                                                                                        "requestedBindingSetDigest": DIGEST_A}}})))
        with self.assertRaises(AuthorError):
            replay(sample, request(history=seal(first["frontier"],
                                                 {"r/s0": {"kind": "result", "value": role_value}})
                                          + seal(second["frontier"],
                                                 {"r/s1": {"kind": "result", "value": {**selection,
                                                                                        "cursor": {"viewDigest": DIGEST_A,
                                                                                                   "nextIndex": 0}}}})))
        with self.assertRaises(AuthorError):
            replay(sample, request(history=seal(first["frontier"],
                                                 {"r/s0": {"kind": "result", "value": role_value}})
                                          + seal(second["frontier"],
                                                 {"r/s1": {"kind": "result", "value": {**selection,
                                                                                        "selectedTaskIds": ["task-1"]}}})))
        with self.assertRaisesRegex(AuthorError, "AUTHOR_CAPABILITIES"):
            replay(sample, {**request(), "input": {**request()["input"],
                        "capabilities": {**request()["input"]["capabilities"], "lockDigest": "invalid"}}})

    def test_v2_rejects_a0_fake_alias_even_if_caught(self):
        @algorithm
        async def alias(ctx):
            try:
                ctx.role("", {})
            except AuthorError:
                pass
            try:
                ctx.edit({})
            except AuthorError:
                pass
            return await ctx.operation("safe", {})
        with self.assertRaises(AuthorError):
            replay(alias, request())
        @algorithm
        async def same_role(ctx):
            return await ctx.role("analyst", {})
        v1 = replay(same_role, request(WIRE_VERSION))
        self.assertEqual(v1["frontier"][0]["kind"], "author.role")
        with self.assertRaisesRegex(AuthorError, "AUTHOR_INPUT_DRIFT"):
            replay(same_role, request(history=seal(v1["frontier"])))

    def test_collected_outcome_attrs_keep_json_dict_behavior(self):
        @algorithm
        async def collected(ctx):
            outcomes = await ctx.parallel([ctx.operation("a", {}), ctx.operation("b", {})])
            assert isinstance(outcomes[0], dict)
            assert outcomes[0].ok and outcomes[0]["value"].answer == 3
            assert not outcomes[1].ok and outcomes[1].error.code == "BUSINESS"
            for mutate in (lambda: setattr(outcomes[0], "ok", False),
                           lambda: outcomes[0].__ior__({"ok": False}),
                           lambda: setattr(outcomes[0].value, "answer", 9)):
                try:
                    mutate()
                except TypeError:
                    pass
                else:
                    raise AssertionError("collected Outcome was mutable")
            return ctx.result(outputs={"outcomes": outcomes})
        first = replay(collected, request())
        values = {first["frontier"][0]["address"]: {"kind": "result", "value": {"answer": 3}},
                  first["frontier"][1]["address"]: {"kind": "error", "code": "BUSINESS", "message": "failed"}}
        result = replay(collected, request(history=seal(first["frontier"], values)))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["result"]["outputs"]["outcomes"],
                         [{"ok": True, "value": {"answer": 3}},
                          {"ok": False, "error": {"kind": "error", "code": "BUSINESS", "message": "failed"}}])

    def test_v2_selected_agent_stays_complete_and_typed_dto_partition(self):
        @algorithm
        async def selected(ctx):
            return ctx.result(selected=ctx.initial_agent)
        self.assertEqual(replay(selected, request())["result"]["selected"], AGENT)
        task_selection = {"schemaVersion": 1, "taskViewRef": TASK_VIEW, "selectedTaskIds": ["task-1"],
                          "cursor": {"viewDigest": TASK_VIEW["digest"], "nextIndex": 0}}
        assert_task_selection_v1(task_selection)
        candidate = {**AGENT, "proposalIndex": 1}
        batch = {"schemaVersion": 1, "requestedCount": 2, "candidates": [candidate],
                 "failures": [{"index": 0, "stage": "validation", "code": "INVALID", "message": "bad",
                               "evidenceRefs": [TASK_VIEW]}]}
        assert_proposal_batch_v1(batch)
        with self.assertRaises(ValidationError):
            assert_proposal_batch_v1({**batch, "failures": [{**batch["failures"][0], "index": 1}]})
        complete = {"schemaVersion": 1, "subject": AGENT, "taskViewRef": TASK_VIEW,
                    "status": "complete", "comparable": True, "comparisonKey": DIGEST_A,
                    "metrics": {"passRate": .4}, "measurementRef": {**TASK_VIEW, "schemaId": "measurement.record.v1"},
                    "trials": [{"taskId": "task-1", "repeatIndex": 0, "status": "completed"}], "evidenceRefs": [TASK_VIEW]}
        assert_evaluation_v1(complete)
        assert_evaluation_v1({key: value for key, value in {**complete, "status": "incomplete",
                                                            "comparable": False}.items()
                              if key not in ("comparisonKey", "metrics", "measurementRef")})
        with self.assertRaises(ValidationError):
            assert_evaluation_v1({**complete, "status": "incomplete"})
        for invalid in ({**complete, "evidenceRefs": []},
                        {**complete, "trials": [{"taskId": "task-1", "repeatIndex": 0, "status": "failed"}]},
                        {**complete, "trials": complete["trials"] * 2}):
            with self.assertRaises(ValidationError):
                assert_evaluation_v1(invalid)

    def test_author_inputs_reject_attribute_and_nested_mutation(self):
        @algorithm
        async def frozen(ctx):
            for mutate in (lambda: setattr(ctx.config, "rounds", 99),
                           lambda: setattr(ctx.data.nested, "score", 99),
                           lambda: ctx.data.rows.__setitem__(0, 99)):
                try:
                    mutate()
                except (TypeError, AttributeError):
                    pass
                else:
                    raise AssertionError("author input was mutable")
            return ctx.result(outputs={"rounds": ctx.config.rounds, "score": ctx.data.nested.score})
        next_request = request(config={"rounds": 2})
        next_request["input"]["data"] = {"nested": {"score": 3}, "rows": [1]}
        self.assertEqual(replay(frozen, next_request)["result"]["outputs"], {"rounds": 2, "score": 3})


if __name__ == "__main__":
    unittest.main()
