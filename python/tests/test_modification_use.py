import base64
import json
import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

from gear.algorithms.modification_use import modification_observations, trial_use
from gear.canonical import digest
from gear.observations.hitch import (
    MAIN,
    NativeReader,
    changed_resources,
    observe,
    sha,
    skill_body,
    source_file,
)

RUN = "run_" + "a" * 32
SKILL_PATH = "skills/checked-reads/SKILL.md"
BODY = "# Checked reads\nRead exact evidence."
SKILL = "---\nname: checked-reads\ndescription: test\n---\n" + BODY + "\n"


def wrapped(body=BODY):
    return (
        '<skill_content name="checked-reads">\n<skill_resources>\nResources\n</skill_resources>\n\n<skill_instructions>\n'
        + body
        + "\n</skill_instructions>\n</skill_content>"
    )


def call(seq=1, call_id="call", tool="skill", args=None):
    return {
        "seq": seq,
        "type": "tool/call",
        "data": {"callId": call_id, "name": tool, "arguments": args or {"name": "checked-reads"}},
    }


def result(seq=2, call_id="call", content=None, error=False, modern=False):
    message = {
        "source": {"kind": "tool", "callId": call_id},
        "content": [
            {
                "type": "tool-result",
                "toolCallId": call_id,
                "content": [{"type": "text", "text": wrapped() if content is None else content}],
                "isError": error,
            }
        ],
    }
    if modern:
        message.update(
            role="tool", toolCallId=call_id, isError=error, content=message["content"][0]["content"]
        )
    return {"seq": seq, "type": "tool/result", "data": {"message": message}}


def artifact():
    return {
        "path": SKILL_PATH,
        "candidate_digest": digest("candidate"),
        "content": SKILL,
        "skill_name": "checked-reads",
        "skill_body": BODY,
    }


def file(events, name="main", depth=0):
    return {
        "source_path": MAIN if not depth else "trajectory/provider/deepseek-child-session-1.jsonl",
        "source_digest": sha(name.encode()),
        "session_id": name,
        "delegation_depth": depth,
        "events": events,
    }


def trace(files, coverage="listed-files-complete"):
    return {
        "coverage": coverage,
        "listed_files": len(files),
        "verified_files": len(files),
        "files": files,
    }


class MatchingTests(unittest.TestCase):
    def test_exact_child_read_preserves_source_identity_and_both_native_envelopes(self):
        for modern in (False, True):
            use = trial_use(
                [artifact()], trace([file([]), file([call(), result(modern=modern)], "child", 1)])
            )
            self.assertEqual(use["status"], "observed")
            action = use["artifacts"][0]["actions"][0]
            self.assertEqual(
                (action["session_id"], action["call_seq"], action["result_seq"]), ("child", 1, 2)
            )
            self.assertEqual(action["source_digest"], sha(b"child"))
            self.assertNotIn("files", use["source"])

    def test_mentions_unpaired_or_foreign_results_are_not_success(self):
        mention = {
            "seq": 1,
            "type": "user/message",
            "data": {"source": {"kind": "user"}, "content": wrapped()},
        }
        self.assertEqual(
            trial_use([artifact()], trace([file([mention])]))["status"], "not-observed"
        )
        for events in (
            [call()],
            [call(), result(call_id="other")],
            [call(), result(content=wrapped("old body"))],
            [call(), result(), call(seq=3)],
            [call(), result(), result(seq=3)],
            [call(seq=3), result()],
        ):
            self.assertEqual(trial_use([artifact()], trace([file(events)]))["status"], "unknown")
        self.assertEqual(
            trial_use([artifact()], trace([file([call()]), file([result()], "child", 1)]))[
                "status"
            ],
            "unknown",
        )
        duplicate = result()
        duplicate["data"]["message"]["content"] *= 2
        self.assertEqual(
            trial_use([artifact()], trace([file([call(), duplicate])]))["status"], "unknown"
        )

    def test_failed_tool_status_is_explicit_and_success_beats_failure(self):
        self.assertEqual(
            trial_use([artifact()], trace([file([call(), result(error=True)])]))["status"],
            "attempted-failure",
        )
        events = [
            call(),
            result(error=True),
            call(seq=3, call_id="second"),
            result(seq=4, call_id="second"),
        ]
        use = trial_use([artifact()], trace([file(events)]))
        self.assertEqual(use["status"], "observed")
        self.assertEqual(use["artifacts"][0]["failed_actions"], 1)

    def test_partial_deleted_and_generic_execution_stay_unknown(self):
        self.assertEqual(trial_use([artifact()], trace([file([])], "partial"))["status"], "unknown")
        deleted = {"path": SKILL_PATH, "candidate_digest": None}
        self.assertEqual(
            trial_use([deleted], trace([file([])]))["artifacts"][0]["reason"], "removed-artifact"
        )
        generic = {
            "path": "plugins/a.js",
            "candidate_digest": digest("code"),
            "content": "changed code",
        }
        self.assertEqual(trial_use([generic], trace([file([])]))["status"], "unknown")
        use = trial_use(
            [generic],
            trace(
                [
                    file(
                        [
                            call(tool="read", args={"path": "plugins/a.js"}),
                            result(content="changed code"),
                        ]
                    )
                ]
            ),
        )
        self.assertEqual(use["status"], "observed")

    def test_injection_requires_exact_structured_source_and_text(self):
        source = {"kind": "skill-invocation", "name": "checked-reads", "extra": "metadata"}
        event = {"seq": 0, "type": "user/message", "data": {"source": source, "content": wrapped()}}
        self.assertEqual(trial_use([artifact()], trace([file([event])]))["status"], "observed")
        generic = {
            "path": "prompts/system.md",
            "candidate_digest": digest("prompt"),
            "content": "exact prompt",
        }
        event = {
            "seq": 1,
            "type": "request/header",
            "data": {"header": {"system": ["exact prompt"]}},
        }
        self.assertEqual(trial_use([generic], trace([file([event])]))["status"], "observed")
        event["data"]["header"]["system"] = "prefix exact prompt suffix"
        self.assertEqual(trial_use([generic], trace([file([event])]))["status"], "unknown")
        event = {
            "seq": 2,
            "type": "system/message",
            "data": {
                "message": {
                    "source": {"kind": "user"},
                    "content": [{"type": "text", "text": "exact prompt"}],
                }
            },
        }
        self.assertEqual(trial_use([generic], trace([file([event])]))["status"], "unknown")
        event["data"]["message"]["source"]["kind"] = "system-prompt"
        self.assertEqual(trial_use([generic], trace([file([event])]))["status"], "observed")
        event["data"]["message"]["content"] = [{"type": "image", "metadata": "exact prompt"}]
        self.assertEqual(trial_use([generic], trace([file([event])]))["status"], "unknown")

    def test_bounded_examples_keep_full_counts_and_valid_zero_conditioned_pairs(self):
        events = [
            event
            for index in range(9)
            for event in (
                call(seq=index * 2, call_id=str(index)),
                result(seq=index * 2 + 1, call_id=str(index)),
            )
        ]
        use = trial_use([artifact()], trace([file(events)]))
        self.assertEqual(use["artifacts"][0]["observed_actions"], 9)
        self.assertEqual(use["artifacts"][0]["omitted_actions"], 5)
        summary = modification_observations(
            {
                "changes": [{"path": SKILL_PATH, "after": {"digest": digest("candidate")}}],
                "candidate_id": "candidate",
                "parent_id": "parent",
                "task_ids": ["a"],
                "repetitions": 2,
                "trials": [{"task_id": "a", "repetition": 0, **use}],
                "evidence": [
                    {
                        "candidate_id": name,
                        "task_id": "a",
                        "repetition": 0,
                        "status": "valid",
                        "score": score,
                    }
                    for name, score in [("parent", 0), ("candidate", 1)]
                ],
            }
        )
        self.assertEqual(summary["summary"]["missing_observations"], 1)
        self.assertEqual(summary["summary"]["conditioned_results"][0]["mean_reward_delta"], 1)


class NativeSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run_root = self.root / "runs" / RUN
        self.run_root.mkdir(parents=True)

    def native(self, events, child=False, parent="main", session=None):
        path = "trajectory/provider/deepseek-child-session-1.jsonl" if child else MAIN
        header = {
            "type": "session",
            "version": 0,
            "id": session or ("child" if child else "main"),
            "delegationDepth": int(child),
            **({"parentSession": parent} if child else {}),
        }
        raw = (
            "\n".join(json.dumps(value, ensure_ascii=False) for value in [header, *events]) + "\n"
        ).encode()
        target = self.run_root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        return {
            "role": "provider_events",
            "path": path,
            "bytes": len(raw),
            "sha256": sha(raw),
            "media_type": "application/x-ndjson",
        }

    def manifest(self, files, **fields):
        value = {
            "schema_version": "2",
            "run_id": RUN,
            "fidelity": "provider_native",
            "provider": "deepseek",
            "provider_session_id": "main",
            "files": files,
            **fields,
        }
        raw = json.dumps(value).encode()
        (self.run_root / "trajectory.ref.json").write_bytes(raw)
        return {"run_id": RUN, "native_manifest_digest": sha(raw), "content_digest": None}

    def test_complete_manifest_and_child_match_and_retain_only_relevant_events(self):
        main = self.native([call(tool="bash")])
        child = self.native([call(), result()], True)
        source = self.manifest([main, child])
        observed = NativeReader(str(self.root)).read(source)
        self.assertEqual(observed["coverage"], "listed-files-complete")
        self.assertEqual(sum(len(file["events"]) for file in observed["files"]), 3)
        self.assertEqual(observed["files"][1]["events"][0]["data"], {"callId": "call"})
        self.assertEqual(trial_use([artifact()], observed)["status"], "observed")

    def test_preceding_result_and_other_tool_duplicate_cannot_form_a_successful_pair(self):
        ambiguous = result(seq=3)
        ambiguous["data"]["message"]["content"] *= 2
        for events in (
            [result(seq=0), call(), result()],
            [call(), result(), call(seq=3, tool="bash")],
            [call(), result(), ambiguous],
        ):
            source = self.manifest([self.native(events)])
            observed = NativeReader(str(self.root)).read(source)
            self.assertEqual(trial_use([artifact()], observed)["status"], "unknown")

    def test_retention_overflow_cannot_hide_ambiguity_after_a_successful_pair(self):
        source = self.manifest([self.native([call(), result(), result(seq=3, content="x" * 2000)])])
        observed = NativeReader(str(self.root), {"retained_bytes": 1500}).read(source)
        self.assertEqual(observed["coverage"], "partial")
        self.assertEqual(trial_use([artifact()], observed)["status"], "unknown")

    def test_orphans_and_duplicate_main_session_ids_cannot_supply_positive_evidence(self):
        main = self.native([])
        child = self.native([call(), result()], True, parent="foreign")
        source = self.manifest([main, child])
        observed = NativeReader(str(self.root)).read(source)
        self.assertEqual(observed["coverage"], "partial")
        self.assertEqual(trial_use([artifact()], observed)["status"], "unknown")
        child = self.native([call(), result()], True, session="main")
        observed = NativeReader(str(self.root)).read(self.manifest([main, child]))
        self.assertEqual(observed["coverage"], "unavailable")
        self.assertEqual(observed["files"], [])

    def test_changed_manifest_bytes_digest_or_link_sources_are_unavailable(self):
        main = self.native([call(), result()])
        source = self.manifest([main])
        path = self.run_root / main["path"]
        path.write_bytes(path.read_bytes().replace(b"checked-reads", b"wrong-ed-name"))
        self.assertEqual(NativeReader(str(self.root)).read(source)["coverage"], "unavailable")
        self.native([call(), result()])
        original = path.with_suffix(".original")
        path.rename(original)
        path.symlink_to(original)
        self.assertEqual(NativeReader(str(self.root)).read(source)["coverage"], "unavailable")
        path.unlink()
        original.rename(path)
        (self.run_root / "trajectory.ref.json").write_text("{}")
        self.assertEqual(
            NativeReader(str(self.root)).read(source)["reason"],
            "trajectory-manifest-digest-mismatch",
        )

    def test_shared_byte_budget_and_retention_limits_never_imply_absence(self):
        main = self.native([call(), result()])
        source = self.manifest([main])
        reader = NativeReader(str(self.root), {"snapshot_bytes": main["bytes"]})
        self.assertEqual(reader.read(source)["coverage"], "listed-files-complete")
        limited = reader.read(source)
        self.assertEqual(limited["reason"], "snapshot-byte-limit")
        limited = NativeReader(str(self.root), {"retained_bytes": 1}).read(source)
        self.assertEqual(limited["coverage"], "partial")
        self.assertEqual(trial_use([artifact()], limited)["status"], "unknown")

    def test_actual_size_is_checked_before_native_bytes_are_read(self):
        main = self.native([])
        source = self.manifest([main])
        path = self.run_root / MAIN
        path.write_bytes(path.read_bytes() + b"x" * 2048)
        reads = []

        @contextmanager
        def tracked(root, relative, maximum):
            with source_file(root, relative, maximum) as handle:
                proxy = Mock(wraps=handle)
                if relative.endswith(MAIN):
                    reads.append(proxy)
                yield proxy

        with patch("gear.observations.hitch.source_file", tracked):
            observed = NativeReader(str(self.root)).read(source)
        self.assertEqual(observed["reason"], "native-source-byte-count")
        self.assertEqual(len(reads), 1)
        reads[0].readline.assert_not_called()

    def test_invalid_target_content_still_consumes_the_resource_read_budget(self):
        changes = []
        for name in ("invalid", "valid"):
            (self.root / name).write_bytes(b"x" * 8)
            changes.append(
                {
                    "path": name,
                    "after": {
                        "executable": False,
                        "digest": digest(
                            "bad" if name == "invalid" else base64.b64encode(b"x" * 8).decode()
                        ),
                    },
                }
            )
        resources = changed_resources(self.root, changes, "dsh", 8)
        self.assertTrue(all("content" not in item for item in resources))

    def test_budget_survives_separate_workers_and_zero_is_not_unlimited(self):
        main = self.native([call(), result()])
        source = self.manifest([main])
        input = {
            "root": str(self.root),
            "target_root": str(self.root),
            "adapter": "dsh",
            "changes": [],
            "trials": [{"task_id": "a", "repetition": 0, "source": source}],
            "budget": {"remaining_bytes": main["bytes"], "remaining_runs": 2},
        }
        input["trials"][0]["source_ref"] = "opaque"
        first = observe(input)
        self.assertEqual(first["budget"], {"remaining_bytes": 0, "remaining_runs": 1})
        second = observe({**input, "budget": first["budget"]})
        self.assertEqual(second["trials"][0]["source"]["reason"], "snapshot-byte-limit")
        third = observe({**input, "budget": second["budget"]})
        self.assertEqual(third["trials"][0]["source"]["reason"], "snapshot-run-limit")

    def test_special_files_and_linked_directories_never_block_or_supply_evidence(self):
        main = self.native([])
        source = self.manifest([main])
        path = self.run_root / MAIN
        original = path.with_suffix(".original")
        path.rename(original)
        os.mkfifo(path)
        self.assertEqual(NativeReader(str(self.root)).read(source)["coverage"], "unavailable")
        path.unlink()
        os.link(original, path)
        self.assertEqual(NativeReader(str(self.root)).read(source)["coverage"], "unavailable")
        path.unlink()
        original.rename(path)
        directory = path.parent
        directory.rename(directory.with_name("original-provider"))
        directory.symlink_to(directory.with_name("original-provider"), target_is_directory=True)
        self.assertEqual(NativeReader(str(self.root)).read(source)["coverage"], "unavailable")

    def test_unpinned_sources_unsupported_native_versions_and_canonical_mismatch(self):
        main = self.native([])
        source = self.manifest([main])
        self.assertEqual(
            NativeReader(str(self.root)).read({"run_id": RUN})["reason"], "native-source-not-pinned"
        )
        source["content_digest"] = digest("canonical")
        self.assertEqual(
            NativeReader(str(self.root)).read(source)["reason"], "canonical-source-mismatch"
        )
        path = self.run_root / main["path"]
        raw = path.read_bytes().replace(b'"version": 0', b'"version": 9')
        path.write_bytes(raw)
        main.update(bytes=len(raw), sha256=sha(raw))
        source = self.manifest([main])
        self.assertEqual(NativeReader(str(self.root)).read(source)["coverage"], "unavailable")

    def test_target_and_native_full_observer_uses_exact_new_adapter_path(self):
        target = self.root / "target"
        path = target / SKILL_PATH
        path.parent.mkdir(parents=True)
        path.write_text(SKILL)
        change = {
            "path": SKILL_PATH,
            "after": {
                "digest": digest(base64.b64encode(SKILL.encode()).decode()),
                "executable": False,
            },
        }
        resources = changed_resources(target, [change], "dsh", 65536)
        self.assertEqual(resources[0]["skill_body"], BODY)
        self.assertIn("/opt/gear-target/" + SKILL_PATH, resources[0]["read_paths"])
        self.assertEqual(
            skill_body(
                SKILL.replace("name: checked-reads", 'name: "checked-reads"'), "checked-reads"
            ),
            BODY,
        )
        main = self.native(
            [
                call(tool="read", args={"path": "/opt/gear-target/" + SKILL_PATH}),
                result(content=SKILL),
            ]
        )
        source = self.manifest([main])
        output = observe(
            {
                "root": str(self.root),
                "target_root": str(target),
                "adapter": "dsh",
                "changes": [change],
                "trials": [
                    {"task_id": "a", "repetition": 0, "source_ref": "opaque", "source": source}
                ],
            }
        )
        self.assertEqual(output["trials"][0]["status"], "observed")
        self.assertNotIn(SKILL, json.dumps(output))
        path.write_text("changed after seal")
        self.assertNotIn("content", changed_resources(target, [change], "dsh", 65536)[0])


if __name__ == "__main__":
    unittest.main()
