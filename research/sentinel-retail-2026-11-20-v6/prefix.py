"""Capture and replay the original interrupted V6 sample; never submit a model turn."""

import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sentinel-retail-2026-11-20-v5"))
from records import files, read, rebase, redact, require


class OriginalInterruption(Exception):
    pass


def capture_prefix(root, inspection):
    from gear.canonical import digest

    expected = files(root)
    require("result.json" not in expected, "prefix acquired an outcome")
    identity = expected["input.json"]
    config = identity["config"]
    prefix = config["sample_id"] + "/"
    models = {name[6:-5]: value for name, value in expected.items() if name.startswith("model/")}
    native, missing = {}, {}
    for path in Path(identity["call_store"]).glob("*/pending.json"):
        pending = read(path)
        request = pending["request"]
        if not request["key"].startswith(prefix):
            continue
        key = request["key"][len(prefix) :]
        require(
            path.parent.name == digest(request["key"]).removeprefix("sha256:"), "call key differs"
        )
        if path.with_name("result.json").exists():
            saved = read(path.with_name("result.json"))
            require(
                key in models
                and saved["request"] == request
                and saved["digest"] == digest(saved["receipt"])
                and saved["receipt"] == models[key]["receipt"]
                and saved["receipt"]["status"] == "completed"
                and not saved["receipt"].get("fixture", False)
                and all(saved["receipt"][k] == pending[k] for k in ("thread_id", "turn_id")),
                "original completed response binding differs",
            )
            native[key] = {"request": request, "receipt": saved["receipt"]}
        else:
            require(
                str(path) == inspection["pending_path"]
                and request["key"] == inspection["request_key"]
                and inspection["native_turn_status"] == "interrupted"
                and inspection["new_model_submissions"] == 0,
                "missing response lacks original interrupted-turn inspection",
            )
            missing[key] = pending
    require(set(native) == set(models) and len(missing) == 1, "prefix native inventory differs")
    return redact(
        {
            "workspace": str(root),
            "files": expected,
            "native_calls": native,
            "missing": missing,
            "inspection": inspection,
        }
    )


async def verify_prefix(record, source):
    from gear.canonical import digest
    from model_calls import BASE_INSTRUCTIONS
    from sentinel_collect import RetailCollector

    expected = record["files"]
    identity = expected["input.json"]
    config = identity["config"]
    prefix, seen = config["sample_id"] + "/", set()
    require(len(record["missing"]) == 1, "interrupted request inventory differs")
    missing_key, pending = next(iter(record["missing"].items()))
    inspection = record["inspection"]
    require(
        pending["request"]["key"] == inspection["request_key"] == prefix + missing_key
        and inspection["pending_path"]
        == str(
            Path(identity["call_store"])
            / digest(inspection["request_key"]).removeprefix("sha256:")
            / "pending.json"
        )
        and inspection["native_turn_status"] == "interrupted"
        and inspection["error"] is None
        and inspection["usage"] is None
        and inspection["new_model_submissions"] == 0,
        "original interrupted request inspection differs",
    )

    async def call(key, prompt, harness, **settings):
        require(key not in seen, "repeated replay call")
        native = record["native_calls"].get(key)
        require(native is not None or key in record["missing"], "unexpected model call")
        request = native["request"] if native else record["missing"][key]["request"]
        require(
            request
            == {
                "key": prefix + key,
                "prompt": prompt,
                "harness": harness,
                "base_instructions": BASE_INSTRUCTIONS,
                "tools": False,
                "sdk": request["sdk"],
                **settings,
            },
            "replayed request differs from the original submission",
        )
        seen.add(key)
        if native is None:
            raise OriginalInterruption(key)
        require(
            native["receipt"] == expected["model/" + key + ".json"]["receipt"]
            and native["receipt"]["status"] == "completed"
            and not native["receipt"].get("fixture", False)
            and set(native["receipt"]["item_types"])
            <= {"userMessage", "agentMessage", "reasoning"},
            "response changed",
        )
        return native["receipt"]

    calls = SimpleNamespace(
        call=call,
        root=Path(identity["call_store"]),
        max_calls=config["max_calls"],
        identity=identity["model_calls_identity"],
        timeout_seconds=identity["call_timeout_seconds"],
    )
    with tempfile.TemporaryDirectory(prefix="gear-v6-stopped-prefix-") as directory:
        collector = RetailCollector(directory, source, config, calls)
        require(collector.identity == identity, "frozen collector or native runtime changed")
        try:
            await collector.collect()
        except OriginalInterruption as error:
            require(str(error) in record["missing"], "wrong interrupted request")
        else:
            raise ValueError("unfinished caller acquired a task result")
        actual = rebase(files(Path(directory)), str(Path(directory).resolve()), record["workspace"])
        require(
            actual == expected and seen == record["native_calls"].keys() | record["missing"].keys(),
            "CPU prefix, checkpoints or native inventory differ",
        )
    return {
        "status": "passed",
        "workspace": record["workspace"],
        "completed_calls": len(record["native_calls"]),
        "interrupted_calls": len(record["missing"]),
        "steps": len([k for k in expected if k.startswith("steps/")]),
        "task_score": None,
        "native_turn_status": "interrupted",
        "new_model_submissions": 0,
    }
