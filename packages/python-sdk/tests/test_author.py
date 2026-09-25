import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import unittest

from gear_algorithm.author import (AuthorError, OperationFailure, WIRE_VERSION, algorithm,
                                   canonical_json, input_digest, replay, workflow)
from gear_algorithm.errors import ValidationError


def request(history=None, *, config=None):
    return {"version": WIRE_VERSION,
            "input": {"initialAgent": {"id": "agent-0"}, "data": {"tasks": list(range(10))},
                      "config": config or {"rounds": 1}},
            "history": history or []}


def seal(frontier, values=None):
    values = values or {}
    return [{"address": item["address"], "kind": item["kind"],
             "definitionVersion": item["definitionVersion"],
             "inputDigest": input_digest({key: value for key, value in item.items()
                                          if key not in ("address", "kind", "definitionVersion")}),
             "outcome": values.get(item["address"], {"kind": "result", "value": {"at": item["address"]}})}
            for item in frontier]


def finish(definition, *, config=None, outcome_by_wave=None):
    history = []
    frontiers = []
    for wave in range(32):
        reply = replay(definition, request(history, config=config))
        if reply["status"] == "completed":
            return reply, history, frontiers
        frontiers.append(reply["frontier"])
        values = outcome_by_wave(wave, reply["frontier"]) if outcome_by_wave else None
        history += seal(reply["frontier"], values)
    raise AssertionError("workflow did not complete")


@workflow
async def branch(ctx, label, extra):
    role = await ctx.role("analyst", {"branch": label})
    edited = await ctx.edit({"branch": label, "role": role})
    if extra:
        await ctx.operation("extra.stage", {"branch": label})
    tasks = await ctx.parallel([ctx.rollout({"task": task, "edit": edited, "branch": label})
                                for task in range(10)])
    return await ctx.measure({"branch": label, "tasks": tasks})


@algorithm
async def nested(ctx):
    outer = await ctx.parallel([branch("left", False), branch("right", True)])
    return ctx.result(outputs={"branches": outer})


class AuthorReplayTests(unittest.TestCase):
    def test_nested_parallel_two_multi_await_branches_and_replay(self):
        first = replay(nested, request())
        self.assertEqual(first["status"], "waiting")
        self.assertEqual([item["kind"] for item in first["frontier"]], ["author.role", "author.role"])
        self.assertEqual([item["address"] for item in first["frontier"]],
                         ["r/s2/p0/s0/s0", "r/s2/p1/s0/s0"])
        completed, history, frontiers = finish(nested)
        self.assertEqual(replay(nested, request(history)), completed)
        self.assertEqual([len(frontier) for frontier in frontiers], [2, 2, 11, 11, 1])
        self.assertEqual(len(history), 27)
        self.assertTrue(completed["result"]["outputs"]["branches"][0]["ok"])
        self.assertEqual(len(set(item["address"] for item in history)), len(history))

    def test_business_failure_is_collected_after_all_branches(self):
        def fail_right_role(wave, frontier):
            if wave == 0:
                return {frontier[1]["address"]: {"kind": "error", "code": "DENIED",
                                                "message": "role rejected", "retryable": False}}
            return None
        @algorithm
        async def two(ctx):
            return await ctx.parallel([branch("left", False), branch("right", False)])
        result, _, frontiers = finish(two, outcome_by_wave=fail_right_role)
        self.assertEqual(len(frontiers[0]), 2)
        self.assertEqual(len(frontiers[1]), 1)
        self.assertTrue(result["result"][0]["ok"])
        self.assertEqual(result["result"][1]["error"]["code"], "DENIED")

    def test_sequential_business_failure_is_catchable(self):
        @algorithm
        async def catches(ctx):
            try:
                await ctx.operation("fail", {})
            except OperationFailure as failure:
                return {"caught": failure.outcome["code"]}
            return {"caught": None}
        first = replay(catches, request())
        history = seal(first["frontier"], {first["frontier"][0]["address"]:
                                       {"kind": "error", "code": "FAILED", "message": "sealed"}})
        self.assertEqual(replay(catches, request(history)),
                         {"status": "completed", "result": {"caught": "FAILED"}})

    def test_input_drift_and_skipped_history_rejected(self):
        first = replay(nested, request())
        history = seal(first["frontier"])
        bad = copy.deepcopy(history)
        bad[0]["inputDigest"] = "0" * 64
        with self.assertRaisesRegex(AuthorError, "AUTHOR_INPUT_DRIFT"):
            replay(nested, request(bad))
        @algorithm
        async def conditional(ctx):
            if ctx.config.rounds:
                await ctx.operation("a", {})
            return {}
        original = replay(conditional, request())
        with self.assertRaisesRegex(AuthorError, "AUTHOR_HISTORY_DRIFT"):
            replay(conditional, request(seal(original["frontier"]), config={"rounds": 0}))

    def test_duplicate_await_duplicate_parallel_child_and_unused_call(self):
        @algorithm
        async def duplicate(ctx):
            call = ctx.operation("a", {})
            await call
            await call
            return {}
        one = replay(duplicate, request())
        with self.assertRaisesRegex(AuthorError, "AUTHOR_REUSED_CALL"):
            replay(duplicate, request(seal(one["frontier"])))
        @algorithm
        async def duplicate_child(ctx):
            call = ctx.operation("a", {})
            await ctx.parallel([call, call])
        with self.assertRaisesRegex(AuthorError, "AUTHOR_REUSED_CALL"):
            replay(duplicate_child, request())
        @algorithm
        async def caught_duplicate_child(ctx):
            call = ctx.operation("a", {})
            try:
                ctx.parallel([call, call])
            except AuthorError:
                pass
            return await ctx.operation("fallback", {})
        with self.assertRaisesRegex(AuthorError, "AUTHOR_REUSED_CALL"):
            replay(caught_duplicate_child, request())
        @algorithm
        async def clean_completed(ctx):
            return await ctx.operation("a", {})
        completed_history = seal(replay(clean_completed, request())["frontier"])
        @algorithm
        async def caught_after_history(ctx):
            call = ctx.operation("a", {})
            try:
                ctx.parallel([call, call])
            except AuthorError:
                pass
            return await call
        with self.assertRaisesRegex(AuthorError, "AUTHOR_REUSED_CALL"):
            replay(caught_after_history, request(completed_history))

        async def branch(ctx):
            return await ctx.operation("a", {})
        clean_branch = workflow(branch)
        async def branch(ctx):
            call = ctx.operation("a", {})
            try:
                ctx.parallel([call, call])
            except AuthorError:
                pass
            return await call
        caught_branch = workflow(branch)
        @workflow
        async def sibling(ctx):
            prior = await ctx.operation("b", {})
            return await ctx.operation("c", {"prior": prior})
        @algorithm
        async def clean_parallel(ctx):
            return await ctx.parallel([clean_branch(), sibling()])
        @algorithm
        async def caught_parallel(ctx):
            return await ctx.parallel([caught_branch(), sibling()])
        sibling_history = seal(replay(clean_parallel, request())["frontier"])
        self.assertEqual(len(sibling_history), 2)
        self.assertEqual(len(replay(clean_parallel, request(sibling_history))["frontier"]), 1)
        with self.assertRaisesRegex(AuthorError, "AUTHOR_REUSED_CALL"):
            replay(caught_parallel, request(sibling_history))
        @algorithm
        async def unused(ctx):
            ctx.operation("a", {})
            return {}
        with self.assertRaisesRegex(AuthorError, "AUTHOR_UNUSED_CALL"):
            replay(unused, request())

    def test_empty_parallel_and_checkpoint_versions_scopes(self):
        @workflow
        async def save(ctx, name):
            first = await ctx.checkpoint("population", {"name": name, "version": 1})
            second = await ctx.checkpoint("population", {"name": name, "version": 2})
            return [first, second]
        @algorithm
        async def checks(ctx):
            empty = await ctx.parallel([])
            branches = await ctx.parallel([save("a"), save("b")])
            return {"empty": empty, "branches": branches}
        first = replay(checks, request())
        self.assertEqual(len(first["frontier"]), 2)
        self.assertTrue(all(item["kind"] == "author.checkpoint" for item in first["frontier"]))
        result, history, frontiers = finish(checks)
        self.assertEqual([len(wave) for wave in frontiers], [2, 2])
        self.assertEqual(len(history), 4)
        self.assertEqual(replay(checks, request(history)), result)
        self.assertEqual(result["result"]["empty"], [])
        self.assertNotEqual(history[0]["address"], history[2]["address"])

    def test_construction_is_lazy_and_arguments_are_frozen(self):
        @workflow
        async def fails_when_started(ctx, value):
            raise RuntimeError("started")
        @algorithm
        async def outer(ctx):
            data = {"items": [1]}
            call = fails_when_started(data)
            data["items"].append(2)
            return await ctx.parallel([call])
        with self.assertRaisesRegex(AuthorError, "AUTHOR_EXECUTION.*RuntimeError"):
            replay(outer, request())
        @workflow
        async def echo(ctx, value):
            return await ctx.operation("echo", value)
        @algorithm
        async def frozen(ctx):
            data = {"items": [1]}
            call = echo(data)
            data["items"].append(2)
            return await ctx.parallel([call])
        first = replay(frozen, request())
        self.assertEqual(first["frontier"][0]["input"], {"items": [1]})

    def test_mutable_positional_and_keyword_defaults_are_read_only_across_branches(self):
        @workflow
        async def positional(ctx, values=[]):
            values.append(1)
            return await ctx.operation("x", {"count": len(values)})
        @algorithm
        async def two_positional(ctx):
            return await ctx.parallel([positional(), positional()])
        with self.assertRaisesRegex(AuthorError, "AUTHOR_EXECUTION.*AttributeError"):
            replay(two_positional, request())
        @workflow
        async def keyword(ctx, *, values={"count": 0}):
            values["count"] += 1
            return await ctx.operation("x", values)
        @algorithm
        async def two_keyword(ctx):
            return await ctx.parallel([keyword(), keyword()])
        with self.assertRaisesRegex(AuthorError, "AUTHOR_EXECUTION.*TypeError"):
            replay(two_keyword, request())

    def test_finally_cleanup_cannot_create_managed_effect(self):
        @algorithm
        async def unsafe(ctx):
            try:
                await ctx.operation("first", {})
            finally:
                ctx.operation("second", {})
        with self.assertRaisesRegex(AuthorError, "AUTHOR_FINALLY_EFFECT"):
            replay(unsafe, request())

    def test_observations_are_managed_and_no_unknown_history(self):
        @algorithm
        async def observes(ctx):
            return [await ctx.now(), await ctx.budget(), await ctx.random_seed(), await ctx.new_id()]
        first = replay(observes, request())
        self.assertEqual(first["frontier"][0]["input"], {"kind": "now"})
        self.assertEqual(first["frontier"][0]["kind"], "author.observe")
        bad = [{"address": first["frontier"][0]["address"], "kind": "author.observe",
                "inputDigest": "x", "outcome": {"kind": "unknown"}}]
        with self.assertRaisesRegex(AuthorError, "AUTHOR_HISTORY"):
            replay(observes, request(bad))

    def test_definition_and_intent_metadata_drift(self):
        async def stage(ctx):
            return await ctx.operation("a", {})
        old_stage = workflow(stage, version="v1")
        new_stage = workflow(stage, version="v2")
        @algorithm
        async def first(ctx):
            return await old_stage()
        @algorithm
        async def second(ctx):
            return await new_stage()
        initial = replay(first, request())
        history = seal(initial["frontier"])
        with self.assertRaisesRegex(AuthorError, "AUTHOR_INPUT_DRIFT"):
            replay(second, request(history))
        @algorithm
        async def limits(ctx):
            return await ctx.operation("a", {}, limits={"tokens": ctx.config.rounds})
        initial = replay(limits, request())
        history = seal(initial["frontier"])
        with self.assertRaisesRegex(AuthorError, "AUTHOR_INPUT_DRIFT"):
            replay(limits, request(history, config={"rounds": 2}))

    def test_float_input_uses_js_canonical_number_rules(self):
        @algorithm
        async def simple(ctx):
            return await ctx.operation("a", {"rate": ctx.config.rate})
        for number in (1.0, 1e-7, 1e-6):
            first = replay(simple, request(config={"rate": number}))
            self.assertEqual(first["frontier"][0]["input"], {"rate": number})
            self.assertEqual(replay(simple, request(seal(first["frontier"]), config={"rate": number}))["status"], "completed")
        self.assertEqual(canonical_json({"small": 1e-6, "tiny": 1e-7, "score": 0.4, "zero": -0.0}),
                         '{"score":0.4,"small":0.000001,"tiny":1e-7,"zero":0}')
        with self.assertRaises(ValidationError):
            replay(simple, request(config={"rate": 1e20}))

    def test_shared_typescript_wire_vectors(self):
        vectors = Path(__file__).resolve().parents[3] / "tests/fixtures/author-wire-vectors.json"
        for row in json.loads(vectors.read_text()):
            with self.subTest(row["name"]):
                self.assertEqual(canonical_json(row["value"]), row["canonical"])
                self.assertEqual(input_digest(row["value"]), row["digest"])
        self.assertEqual(canonical_json(-0.0), "0")
        self.assertEqual(input_digest(-0.0), "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9")

    def test_known_unmanaged_calls_have_source_diagnostic(self):
        with self.assertRaisesRegex(AuthorError, "AUTHOR_UNMANAGED_IO.*time.time"):
            @algorithm
            async def reads_clock(ctx):
                import time
                return time.time()
        with self.assertRaisesRegex(AuthorError, "AUTHOR_UNMANAGED_IO.*time.time"):
            @workflow
            async def imported_clock(ctx):
                from time import time as wall
                return wall()
        with self.assertRaisesRegex(AuthorError, "AUTHOR_UNMANAGED_IO.*asyncio.create_task"):
            @algorithm
            async def bare_concurrency(ctx):
                import asyncio
                return asyncio.create_task(ctx.operation("a", {}))
        with self.assertRaisesRegex(AuthorError, "AUTHOR_UNMANAGED_IO.*read_text"):
            @algorithm
            async def mutable_file(ctx):
                from pathlib import Path
                return Path("input").read_text()
        with self.assertRaisesRegex(AuthorError, "AUTHOR_UNMANAGED_IO.*requests.post"):
            @algorithm
            async def direct_sdk(ctx):
                import requests
                return requests.post("https://example.invalid")

    def test_real_worker_replays_author_export(self):
        package = Path(__file__).resolve().parents[1]
        fixture = Path(__file__).parent / "fixtures" / "author_sample.py"
        token = "a" * 64
        worker_id = "a0-worker"
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            env = os.environ.copy()
            env["GEAR_ALGORITHM_TOKEN"] = token
            env["GEAR_ALGORITHM_WORKER_ID"] = worker_id
            env["PYTHONPATH"] = str(package / "src")
            process = subprocess.Popen([
                sys.executable, "-m", "gear_algorithm.worker", "--port", str(listener.getsockname()[1]),
                "--module", str(fixture), "--export", "sample", "--config-dir", str(package),
                "--mode", "author"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                listener.settimeout(5)
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(5)
                    def receive():
                        prefix = connection.recv(4)
                        length = struct.unpack(">I", prefix)[0]
                        data = bytearray()
                        while len(data) < length:
                            data.extend(connection.recv(length - len(data)))
                        return json.loads(data.decode("utf-8"))
                    def send(value):
                        data = json.dumps(value, separators=(",", ":")).encode("utf-8")
                        connection.sendall(struct.pack(">I", len(data)) + data)
                    self.assertEqual(receive(), {"type": "hello", "version": 1,
                                                 "token": token, "workerId": worker_id})
                    send({"type": "hello-ack", "version": 1, "workerId": worker_id})
                    send({"type": "request", "id": "one", "method": "author.replay",
                          "params": request()})
                    reply = receive()
                    self.assertEqual(reply["type"], "response")
                    self.assertEqual(reply["result"]["status"], "waiting")
                    self.assertEqual(len(reply["result"]["frontier"]), 2)
            finally:
                process.terminate()
                process.communicate(timeout=5)

    def test_frozen_benchmark_graph_counts(self):
        path = Path(__file__).parent / "fixtures" / "author_benchmark.py"
        spec = importlib.util.spec_from_file_location("author_benchmark_fixture", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        def fake(_wave, frontier):
            values = {}
            for item in frontier:
                value = ({"revision": item["address"]} if item["kind"] == "author.edit"
                         else {"score": 0.4} if item["kind"] == "author.measure"
                         else {"at": item["address"]})
                values[item["address"]] = {"kind": "result", "value": value}
            return values
        for name, expected_waves, expected_ops in (("composite", 12, 156), ("rho_shaped", 19, 163)):
            result, history, frontiers = finish(getattr(module, name), outcome_by_wave=fake)
            self.assertEqual(result["status"], "completed")
            self.assertEqual((len(frontiers), len(history)), (expected_waves, expected_ops))


if __name__ == "__main__":
    unittest.main()
