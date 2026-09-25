import hashlib
import json
from pathlib import Path
import unittest

from gear_algorithm.author import (AuthorError, CAPABILITIES_VERSION, WIRE_VERSION,
                                   WIRE_VERSION_V2, OperationFailure, algorithm, input_digest, replay, workflow)
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
    return [{"address": item["address"], "operationId": hashlib.sha256(item["address"].encode()).hexdigest(),
             "kind": item["kind"],
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
        self.assertIs(second["frontier"][0]["startsBudgetClock"], False)
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
        with self.assertRaisesRegex(AuthorError, "AUTHOR_CAPABILITIES"):
            replay(sample, {**request(), "input": {**request()["input"],
                        "capabilities": {**request()["input"]["capabilities"],
                                         "operationLimits": {"tasks.sample": {"calls": 2}}}}})

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


    def test_tracked_business_error_keeps_kernel_id_and_public_operation_still_raises(self):
        @algorithm
        async def tracked(ctx):
            result = await ctx._tracked_operation(
                "execution.rollout", {"taskId": "task-0"},
                binding_set_ref=ctx.initial_agent.binding_set_ref, limits={})
            return ctx.result(selected=ctx.initial_agent, outputs={"tracked": result})
        first = replay(tracked, request())
        self.assertEqual(first["frontier"][0]["definitionVersion"],
                         "algorithm.v2/tracked-operation@v1")
        failed = {first["frontier"][0]["address"]:
                  {"kind": "error", "code": "TASK_FAILED", "message": "sealed business failure"}}
        history = seal(first["frontier"], failed)
        expected = {"status": "completed", "result": {"selected": AGENT,
                    "outputs": {"tracked": {"operationId": history[0]["operationId"],
                                            "outcome": failed[first["frontier"][0]["address"]]}}}}
        self.assertEqual(replay(tracked, request(history=history)), expected)
        self.assertEqual(replay(tracked, request(history=history)), expected)
        without_id = [{key: value for key, value in history[0].items() if key != "operationId"}]
        with self.assertRaisesRegex(AuthorError, "operation ID"):
            replay(tracked, request(history=without_id))
        duplicate = [{**history[0], "address": "r/s9"}, history[0]]
        with self.assertRaisesRegex(AuthorError, "operation ID"):
            replay(tracked, request(history=duplicate))
        with self.assertRaisesRegex(AuthorError, "v1 history cannot carry operation ID"):
            replay(tracked, request(WIRE_VERSION, history=history))

        @algorithm
        async def ordinary(ctx):
            try:
                await ctx.operation("execution.rollout", {"taskId": "task-0"},
                                    binding_set_ref=ctx.initial_agent.binding_set_ref, limits={})
            except OperationFailure as exc:
                return ctx.result(outputs={"caught": exc.outcome["code"]})
            return ctx.result(outputs={"caught": "none"})
        ordinary_first = replay(ordinary, request())
        ordinary_history = seal(ordinary_first["frontier"],
                                {ordinary_first["frontier"][0]["address"]: failed[first["frontier"][0]["address"]]})
        self.assertEqual(replay(ordinary, request(history=ordinary_history))["result"]["outputs"],
                         {"caught": "TASK_FAILED"})

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

    def test_frozen_dtos_cross_custom_workflow_kwargs_and_nested_parallel(self):
        selection = {"schemaVersion": 1, "taskViewRef": TASK_VIEW, "selectedTaskIds": ["task-1"],
                     "cursor": {"viewDigest": TASK_VIEW["digest"], "nextIndex": 0}}
        role_value = {"requestedBindingSetDigest": AGENT["bindingSetRef"]["digest"],
                      "actualBindings": {}, "structuredResult": {"name": "analyst"},
                      "structuredResultRef": {**TASK_VIEW, "schemaId": "execution.structured-result.v1"},
                      "evidenceRef": TASK_VIEW,
                      "receiptRef": {**TASK_VIEW, "schemaId": "execution.receipt.v1"}}

        @workflow
        async def child(ctx, agent, selected, *, payload, label):
            assert agent.binding_set_ref.digest == AGENT["bindingSetRef"]["digest"]
            assert selected.selected_task_ids[0] == "task-1"
            assert payload.role.output.name == "analyst"
            assert payload.rows[0].value.nested.score == 3
            try:
                payload["role"]["output"]["name"] = "changed"
            except TypeError:
                pass
            else:
                raise AssertionError("role input was mutable")
            try:
                payload["rows"][0]["value"]["nested"]["score"] = 99
            except TypeError:
                pass
            else:
                raise AssertionError("nested outcome input was mutable")
            settled = await ctx.parallel([
                ctx.operation("probe.one", {"label": label, "task": selected.selected_task_ids[0]}),
                ctx.operation("probe.two", {"label": label, "score": payload.rows[0].value.nested.score}),
            ])
            return {"label": label, "value": settled[0].value}

        @algorithm
        async def parent(ctx):
            role = await ctx.role("analyst", {"goal": "inspect"})
            selected = await ctx.tasks.sample(TASK_VIEW, count=1, seed=7)
            prepared = await ctx.parallel([ctx.operation("prepare", {})])
            payload = {"role": role, "rows": [prepared[0]]}
            branches = await ctx.parallel([
                child(ctx.initial_agent, selected, payload=payload, label="left"),
                child(ctx.initial_agent, selected, payload=payload, label="right"),
            ])
            return ctx.result(selected=ctx.initial_agent, outputs={"branches": branches})

        history = []
        for _wave in range(8):
            reply = replay(parent, request(history=history))
            if reply["status"] == "completed":
                self.assertEqual([item["value"]["label"] for item in reply["result"]["outputs"]["branches"]],
                                 ["left", "right"])
                self.assertEqual(replay(parent, request(history=history)), reply)
                break
            values = {}
            for item in reply["frontier"]:
                result = (role_value if item["kind"] == "execution.role" else
                          selection if item["kind"] == "tasks.sample" else
                          {"nested": {"score": 3}} if item["kind"] == "prepare" else
                          {"at": item["address"]})
                values[item["address"]] = {"kind": "result", "value": result}
            history.extend(seal(reply["frontier"], values))
        else:
            self.fail("nested custom workflow did not complete")

    def test_branch_context_properties_cannot_be_rebound_and_local_archive_remains_mutable(self):
        @workflow
        async def branch(ctx, name):
            for change in (lambda: setattr(ctx, "config", {"rounds": 99}),
                           lambda: setattr(ctx, "initial_agent", {"changed": True}),
                           lambda: setattr(ctx, "capabilities", {}),
                           lambda: setattr(ctx, "data", {}),
                           lambda: setattr(ctx.tasks, "_context", None)):
                try:
                    change()
                except TypeError:
                    pass
                else:
                    raise AssertionError("author context was mutable")
            archive = [name]
            archive.append(ctx.config.rounds)
            return {"archive": archive, "agent": ctx.initial_agent.binding_set_ref.digest}

        @algorithm
        async def parent(ctx):
            branches = await ctx.parallel([branch("left"), branch("right")])
            return ctx.result(outputs={"branches": branches, "rounds": ctx.config.rounds})

        finished = replay(parent, request(config={"rounds": 2}))
        self.assertEqual(finished["status"], "completed")
        self.assertEqual(finished["result"]["outputs"]["rounds"], 2)
        self.assertEqual([item["value"]["archive"] for item in finished["result"]["outputs"]["branches"]],
                         [["left", 2], ["right", 2]])

    def test_caught_invalid_managed_construction_remains_fatal(self):
        @workflow
        async def child(ctx, value):
            return value

        @algorithm
        async def invalid_kind(ctx):
            try:
                ctx.operation("", {})
            except AuthorError:
                pass
            return await ctx.now()

        @algorithm
        async def invalid_input(ctx):
            try:
                ctx.operation("custom", {"unsupported": object()})
            except Exception:
                pass
            return await ctx.now()

        @algorithm
        async def invalid_workflow_arg(ctx):
            try:
                child({"unsupported": object()})
            except Exception:
                pass
            return await ctx.now()

        @algorithm
        async def invalid_parallel(ctx):
            try:
                ctx.parallel("not-a-list")
            except AuthorError:
                pass
            return await ctx.now()

        for definition in (invalid_kind, invalid_input, invalid_workflow_arg, invalid_parallel):
            with self.subTest(definition=definition.name):
                with self.assertRaises(AuthorError):
                    replay(definition, request())

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
