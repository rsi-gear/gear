"""Load a factory only from an explicitly frozen, bounded source snapshot."""
from __future__ import annotations

import importlib
import importlib.util
import re
import shutil
import sys
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

from .content import require, digest_file
from .loop import TrainingLoop, _copy

MAX_FILES = 1024
MAX_BYTES = 16 * 1024 * 1024


def source_files(store, recipe):
    require(isinstance(recipe, dict) and set(recipe) == {"entrypoint", "sourceRef"}
            and isinstance(recipe["entrypoint"], str)
            and re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*", recipe["entrypoint"]),
            "invalid-script-recipe", "entrypoint must be module:factory")
    ref = recipe["sourceRef"]
    require(isinstance(ref, dict) and set(ref) == {"uri", "digest", "mediaType"}
            and isinstance(ref.get("digest"), str) and re.fullmatch(r"sha256:[0-9a-f]{64}", ref["digest"])
            and ref.get("uri") == "cas:" + ref["digest"]
            and ref.get("mediaType") == "application/json", "invalid-script-source", "source must be a CAS JSON manifest")
    require(store.path(ref["digest"]).stat().st_size <= MAX_BYTES, "script-source-limit", "source manifest exceeds 16 MiB")
    manifest = store.read_json(ref)
    require(isinstance(manifest, dict) and set(manifest) == {"schemaVersion", "kind", "files"}
            and manifest["schemaVersion"] == 1 and manifest["kind"] == "training-script-source"
            and isinstance(manifest["files"], list) and 0 < len(manifest["files"]) <= MAX_FILES,
            "invalid-script-source", "source needs 1..1024 explicit files")
    seen, total = set(), 0
    for item in manifest["files"]:
        require(isinstance(item, dict) and set(item) == {"path", "contentRef"} and isinstance(item["path"], str),
                "invalid-script-source", "source file must have path/contentRef")
        name = item["path"]; path = PurePosixPath(name)
        require(name and not path.is_absolute() and str(path) == name and not any(p in (".", "..") for p in path.parts)
                and "\\" not in name and name not in seen and "__pycache__" not in path.parts
                and not name.endswith((".pyc", ".pyo")), "invalid-script-path", "unsafe or repeated source path")
        require(not any(name.startswith(old + "/") or old.startswith(name + "/") for old in seen),
                "invalid-script-path", "source file/directory collision")
        seen.add(name); content = item["contentRef"]
        require(isinstance(content, dict) and set(content) == {"uri", "digest", "mediaType"}
                and isinstance(content["digest"], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", content["digest"])
                and isinstance(content["mediaType"], str) and content["uri"] == "cas:" + content["digest"], "invalid-script-source", "source files must use CAS")
        total += store.path(content["digest"]).stat().st_size
        require(total <= MAX_BYTES, "script-source-limit", "source files exceed 16 MiB")
        require(digest_file(store.path(content["digest"])) == content["digest"], "script-source-drift", "referenced content changed")
    module = recipe["entrypoint"].split(":")[0].replace(".", "/")
    require(module + ".py" in seen or module + "/__init__.py" in seen,
            "script-entrypoint-missing", "entrypoint must exist in the frozen source")
    return manifest["files"]


@contextmanager
def loaded_loop(store, recipe, config, runtime, directory):
    """Fresh materialization/import per incarnation; no global plugin registry.

    The script is trusted executable code. Its explicit source files are frozen;
    installed runtime dependencies remain the deployment's responsibility.
    """
    files = source_files(store, recipe)
    directory = Path(directory)
    if directory.exists():
        require(not directory.is_symlink(), "invalid-script-path", "source destination cannot be a symlink")
        # Never consume mutated files from the previous executable incarnation.
        shutil.rmtree(directory)
    directory.mkdir(parents=True, mode=0o700)
    for item in files:
        target = directory / item["path"]; target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        store.copy_ref(item["contentRef"], target)
        require(digest_file(target) == item["contentRef"]["digest"], "script-source-drift", "materialized code differs")
    module, factory_name = recipe["entrypoint"].split(":")
    roots = {PurePosixPath(item["path"]).parts[0].removesuffix(".py") for item in files if item["path"].endswith(".py")}
    require("gear_training" not in roots, "script-module-conflict", "script cannot replace the framework module")
    def belongs(name): return any(name == top or name.startswith(top + ".") for top in roots)
    previous = {name: value for name, value in sys.modules.items() if belongs(name)}
    for name in previous: del sys.modules[name]
    sys.path.insert(0, str(directory)); importlib.invalidate_caches()
    try:
        for top in roots:
            spec = importlib.util.find_spec(top)
            require(spec is not None and (spec.origin is None or Path(spec.origin).resolve().is_relative_to(directory.resolve())),
                    "script-module-conflict", "a frozen source module resolves to an external dependency: " + top)
        factory_module = importlib.import_module(module)
        require(Path(factory_module.__file__).resolve().is_relative_to(directory.resolve()),
                "script-entrypoint-drift", "factory resolved outside the frozen source")
        factory = getattr(factory_module, factory_name, None)
        require(callable(factory), "invalid-script-factory", "entrypoint must be a callable factory")
        loop = factory(_copy(config), runtime)
        require(isinstance(loop, TrainingLoop), "invalid-script-factory", "build_loop(config, runtime) must return TrainingLoop")
        loop.source_identity = _copy(recipe)
        yield loop
    finally:
        sys.path.remove(str(directory))
        for name, value in list(sys.modules.items()):
            filename = getattr(value, "__file__", None)
            if belongs(name) or (filename and Path(filename).resolve().is_relative_to(directory.resolve())):
                sys.modules.pop(name, None)
        sys.modules.update(previous)
