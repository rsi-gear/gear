"""Reject undeclared installed imports before executing their module bodies."""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import importlib.metadata
import importlib.util
import json
import sys
import sysconfig
from pathlib import Path
from types import ModuleType
from typing import Any


class DeclaredImports(importlib.abc.MetaPathFinder):
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.stdlib = {
            Path(sysconfig.get_path(name)).resolve() for name in ("stdlib", "platstdlib")
        }
        # sysconfig can name an installation alias which the OS sandbox cannot
        # resolve (notably Homebrew venvs). The interpreter reports the directory
        # it actually loaded; it is collected before any author module executes.
        actual_stdlib = getattr(sys, "_stdlib_dir", None)
        self.stdlib.add(
            Path(actual_stdlib).resolve()
            if actual_stdlib
            else Path(sysconfig.__file__).resolve().parent
        )
        self.files: set[Path] = set()
        recorded = json.loads((root / "dependencies.json").read_text())
        for expected in recorded:
            distribution = importlib.metadata.distribution(expected["name"])
            for file in distribution.files or ():
                if ".." not in file.parts and not str(file).endswith(".pyc"):
                    self.files.add(Path(str(distribution.locate_file(file))).resolve())

    def allowed(self, origin: str, name: str) -> bool:
        if origin in ("built-in", "frozen"):
            return True
        path = Path(origin).resolve()
        if path.suffix == ".pyc":
            try:
                path = Path(importlib.util.source_from_cache(str(path)))
            except ValueError:
                return False
        if path.is_relative_to(self.root) or path in self.files:
            return True
        return (
            name.partition(".")[0] in sys.stdlib_module_names
            and not {"site-packages", "dist-packages"}.intersection(path.parts)
            and any(path.is_relative_to(root) for root in self.stdlib)
        )

    def find_spec(self, fullname: str, path: Any = None, target: ModuleType | None = None) -> Any:
        spec = (
            importlib.machinery.BuiltinImporter.find_spec(fullname)
            or importlib.machinery.FrozenImporter.find_spec(fullname)
            or importlib.machinery.PathFinder.find_spec(fullname, path, target)
        )
        if spec is None:
            raise ImportError(
                "module is outside the frozen source and dependency closure: " + fullname
            )
        if spec.origin is not None:
            if not self.allowed(spec.origin, fullname):
                raise ImportError("undeclared installed dependency: " + fullname)
        elif not all(
            Path(location).resolve().is_relative_to(self.root)
            or any(file.is_relative_to(Path(location).resolve()) for file in self.files)
            for location in spec.submodule_search_locations or ()
        ):
            raise ImportError("undeclared namespace dependency: " + fullname)
        return spec


def enforce_declared_imports(root: Path) -> None:
    policy = DeclaredImports(root)
    # Python startup may preload distribution helpers through .pth files. They
    # must not give author code an undeclared dependency via sys.modules reuse.
    for name, module in list(sys.modules.items()):
        origin = getattr(getattr(module, "__spec__", None), "origin", None)
        if origin and not policy.allowed(origin, name):
            del sys.modules[name]
    sys.meta_path.insert(0, policy)
