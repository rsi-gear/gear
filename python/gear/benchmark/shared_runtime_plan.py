"""Conservative, opt-in factoring of native Dockerfile prefixes.

The author declares which inputs are used only by image builds. No benchmark
names, filesystem sharing assumptions, or arbitrary Dockerfile rewrites belong
here. Unsupported syntax fails before an output dataset is published.
"""

from __future__ import annotations

import json
import re
from pathlib import PurePosixPath

from gear.canonical import digest

from .environment import local_path
from .native import PINNED
from .payload import content_bytes
from .source import BenchmarkError


def fail(message):
    raise BenchmarkError(message, "shared_runtime")


def fields(value, required, optional=()):
    if (
        not isinstance(value, dict)
        or set(value) - set(required) - set(optional)
        or not set(required) <= value.keys()
    ):
        fail("invalid shared runtime declaration fields")


def under(name, directory):
    return name == directory or name.startswith(directory + "/")


def instructions(text):
    # Python recognizes more whitespace/line separators than Docker. Refuse
    # those declarations instead of silently changing filenames or boundaries.
    if any(char.isspace() and char not in " \t\n" for char in text):
        fail("nonstandard Dockerfile whitespace requires the original build path")
    result = []
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            if re.match(r"#\s*(syntax|escape|check)\s*=", stripped, re.I):
                fail("Dockerfile parser directives are not supported")
            result.append((line, "", ""))
            continue
        if "\\" in line or "\r" in line or "<<" in line:
            fail("Dockerfile continuations and heredocs are not supported")
        parts = stripped.split(None, 1)
        if len(parts) != 2:
            fail("invalid Dockerfile instruction")
        op, argument = parts[0].upper(), parts[1]
        if op not in {"FROM", "RUN", "COPY", "ENV", "WORKDIR", "CMD", "ENTRYPOINT", "USER"}:
            fail("unsupported Dockerfile instruction: " + op)
        if op == "RUN" and argument.startswith("--"):
            fail("RUN mounts and flags are not supported")
        result.append((line, op, argument))
    bases = [arg for _, op, arg in result if op == "FROM"]
    if len(bases) != 1 or not PINNED.fullmatch(bases[0]):
        fail("shared runtimes require one stage with a pinned FROM and no stage alias")
    if next((op for _, op, _ in result if op), None) != "FROM":
        fail("FROM must be the first instruction")
    return result


def copy_paths(argument):
    try:
        values = json.loads(argument) if argument.startswith("[") else argument.split()
    except ValueError:
        fail("invalid COPY JSON")
    if (
        not isinstance(values, list)
        or len(values) < 2
        or not all(isinstance(item, str) and item for item in values)
    ):
        fail("COPY requires literal sources and a destination")
    if any(re.search(r"[\s$*?\[\]\\\"']", item) for item in values):
        fail("COPY interpolation, quoting and patterns are not supported")
    sources, target = values[:-1], values[-1]
    for name in sources:
        if name.startswith("--"):
            fail("COPY flags and stage references are not supported")
        local_path(name.rstrip("/"), "shared_runtime")
    if not target.startswith("/") or ".." in PurePosixPath(target).parts:
        fail("COPY requires an absolute destination")
    if str(PurePosixPath(target)) != (target.rstrip("/") or "/"):
        fail("COPY destination must be normalized")
    return [name.rstrip("/") for name in sources], target


def factor(entry, spec, blobs, platform):
    fields(spec, {"context", "dockerfile", "prefix_lines"}, {"varying"})
    context = local_path(spec["context"], "shared_runtime")
    name = context + "/" + local_path(spec["dockerfile"], "shared_runtime")
    if name not in entry["dockerfiles"]:
        fail("declared Dockerfile is not consumed by the native environment: " + name)
    layout = entry["environment_layout"]
    consumers = [(main["context"], main["dockerfile"]) for main in layout["mains"].values()]
    for compose, composition in layout["compositions"].items():
        role = str(PurePosixPath(compose).parent)
        for service in composition["services"].values():
            build = service.get("build")
            if isinstance(build, dict):
                actual = role if build["context"] == "." else role + "/" + build["context"]
                consumers.append((actual, actual + "/" + build["dockerfile"]))
    if not any(pair == (context, name) for pair in consumers) or any(
        actual != context for actual, path in consumers if path == name
    ):
        fail("declared context does not match every native build consumer")
    files = {file["path"]: file for file in entry["files"]}
    if (
        name not in files
        or content_bytes(files[name], blobs).decode("utf-8") != entry["dockerfiles"][name]
    ):
        fail("Dockerfile changed during native source admission")
    if any(
        path in files
        for path in (
            context + "/.dockerignore",
            name + ".dockerignore",
            context + "/Dockerfile.dockerignore",
        )
    ):
        fail("ignore files require the original build path")
    rows = instructions(entry["dockerfiles"][name])
    count = spec["prefix_lines"]
    if type(count) is not int or not 1 <= count <= len(rows):
        fail("prefix_lines must select a nonempty Dockerfile prefix")
    prefix, suffix = rows[:count], rows[count:]
    if any(op == "ENTRYPOINT" for _, op, _ in suffix):
        fail("ENTRYPOINT after the boundary can reset inherited CMD; use the original build")
    varying = spec.get("varying", [])
    if not isinstance(varying, list) or any(not isinstance(item, str) for item in varying):
        fail("varying must contain relative file paths")
    if len(set(varying)) != len(varying):
        fail("duplicate varying input")
    for item in varying:
        local_path(item, "shared_runtime")
        copy_paths(json.dumps([item, "/placeholder"]))
        if context + "/" + item not in files:
            fail("varying input must be an existing regular file")
    selected, needed, copies = set(), {context + "/" + p for p in varying}, []
    restored = set()
    directories = {
        path.removeprefix(context + "/")
        for path in entry["directories"]
        if path.startswith(context + "/")
    }
    context_files = {
        p.removeprefix(context + "/"): f for p, f in files.items() if p.startswith(context + "/")
    }
    selected_dirs, needed_dirs = set(), set()
    for index, (_, op, argument) in enumerate(rows):
        if op != "COPY":
            continue
        sources, target = copy_paths(argument)
        matches = {p for p in context_files if any(under(p, source) for source in sources)}
        if any(source not in context_files and source not in directories for source in sources):
            fail("COPY source is missing")
        if index >= count:
            needed.update(context + "/" + p for p in matches)
            needed_dirs.update(
                context + "/" + p
                for p in directories
                if any(under(p, source) for source in sources)
            )
            continue
        affected = matches & set(varying)
        if affected:
            # Move only leaves of the final directory COPY across FROM. No RUN,
            # ENV, WORKDIR or other COPY may observe their temporary absence.
            if index != count - 1 or len(sources) != 1 or sources[0] not in directories:
                fail("varying inputs must first appear in the final prefix directory COPY")
            # Reapply the directory COPY to the retained sparse tree. A leaf
            # COPY follows a destination symlink, whereas directory COPY
            # replaces it. Retained common files have the same frozen bytes.
            copies.append("COPY " + json.dumps([sources[0], target]) + "\n")
            restored.update(affected)
        selected.update(matches - set(varying))
        selected_dirs.update(p for p in directories if any(under(p, s) for s in sources))
    if restored != set(varying):
        fail("every varying input must be restored immediately after the prefix")
    if "Dockerfile" in selected or name.removeprefix(context + "/") in selected:
        fail("Dockerfile self-copy is not supported")
    records = [{**context_files[p], "path": p} for p in sorted(selected)]
    if ({context + "/" + p for p in selected} | needed) & set(entry["dockerfiles"]):
        fail("COPY of any rewritten Dockerfile requires the original build path")
    for file in records:
        content_bytes(file, blobs)
    body = {
        "protocol": "gear-shared-image@1",
        "platform": platform,
        "dockerfile": "".join(row[0] for row in prefix),
        "files": records,
        "directories": sorted(selected_dirs),
    }
    return {
        "recipe": body,
        "key": digest(body),
        "dockerfile": name,
        "tail": "".join(copies) + "".join(row[0] for row in suffix),
        "consumed": {context + "/" + p for p in selected},
        "needed": needed,
        "consumed_directories": {context + "/" + p for p in selected_dirs},
        "needed_directories": needed_dirs,
    }


def plan_tasks(entries, blobs, plan):
    fields(plan, {"schema_version", "platform", "tasks", "builds", "image_only"})
    if plan["schema_version"] != "1" or plan["platform"] not in {"linux/amd64", "linux/arm64"}:
        fail("unsupported shared runtime plan version or platform")
    ids, builds, image_only = plan["tasks"], plan["builds"], plan["image_only"]
    if (
        not isinstance(ids, list)
        or not ids
        or any(not isinstance(i, str) for i in ids)
        or len(set(ids)) != len(ids)
    ):
        fail("tasks must be a nonempty unique explicit selection")
    if not isinstance(builds, list) or not builds or not isinstance(image_only, list):
        fail("builds and image_only must be lists")
    for item in image_only:
        local_path(item, "shared_runtime")
        if not item.startswith(("environment/", "tests/")):
            fail("image-only inputs must be within environment/ or tests/")
    by_id = {entry["task"]["id"]: entry for entry in entries}
    if not set(ids) <= by_id.keys():
        fail("selected task does not exist")
    recipes, tasks = {}, []
    for identifier in ids:
        entry = by_id[identifier]
        # Avoid unmodelled build args/targets, platform overrides and undeclared
        # consumers of removed files. This is author preparation, not a fallback
        # that silently changes how existing evaluations execute.
        for composition in entry["environment_layout"]["compositions"].values():
            for service in composition["services"].values():
                if service.get("platform", plan["platform"]) != plan["platform"]:
                    fail("service platform differs from shared runtime platform")
                if isinstance(service.get("build"), dict) and set(service["build"]) - {
                    "context",
                    "dockerfile",
                }:
                    fail("explicit build args/targets require the original build path")
        factors = [factor(entry, spec, blobs, plan["platform"]) for spec in builds]
        if len({item["dockerfile"] for item in factors}) != len(factors) or {
            item["dockerfile"] for item in factors
        } != set(entry["dockerfiles"]):
            fail("declare each task Dockerfile exactly once")
        consumed = set().union(*(item["consumed"] for item in factors))
        needed = set().union(*(item["needed"] for item in factors))
        # Native control files have consumers outside COPY even if the author
        # accidentally declares them image-only. Never delete those consumers.
        needed.update(
            {
                "tests/test.sh",
                "environment/.env",
                "tests/.env",
                *entry["environment_layout"]["compositions"],
                *entry["environment_layout"]["removed"],
            }
        )
        removed = {p for p in consumed - needed if any(under(p, root) for root in image_only)}
        # A changed source or dependency becomes a different recipe, rather than
        # accidentally sharing the first task's version.
        for item in factors:
            recipes[item["key"]] = item["recipe"]
        tasks.append(
            {
                "entry": entry,
                "factors": factors,
                "removed": removed,
                "consumed_directories": set().union(
                    *(item["consumed_directories"] for item in factors)
                ),
                "needed_directories": set().union(
                    *(item["needed_directories"] for item in factors)
                ),
            }
        )
    return recipes, tasks
