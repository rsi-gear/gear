import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


class ImportClosureTests(unittest.TestCase):
    def test_interpreter_stdlib_remains_allowed_when_configured_alias_cannot_resolve(self):
        from gear.refine.imports import DeclaredImports

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dependencies.json").write_text("[]")
            with patch("sysconfig.get_path", return_value="/unavailable/stdlib-alias"):
                policy = DeclaredImports(root)
            self.assertTrue(policy.allowed(json.__spec__.origin, "json"))
            self.assertFalse(policy.allowed(str(root.parent / "vendor/json/__init__.py"), "json"))
            with (
                patch("sysconfig.get_path", return_value="/unavailable/stdlib-alias"),
                patch.object(sys, "_stdlib_dir", None, create=True),
            ):
                fallback = DeclaredImports(root)
            self.assertTrue(fallback.allowed(json.__spec__.origin, "json"))

    def test_only_frozen_sources_and_declared_installed_files_are_importable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frozen = root / "frozen"
            vendor = root / "vendor"
            frozen.mkdir()
            vendor.mkdir()
            (vendor / "hidden_dependency.py").write_text("raise RuntimeError('module executed')\n")
            (vendor / "declared_dependency.py").write_text("VALUE = 7\n")
            metadata = vendor / "declared_dependency-1.0.dist-info"
            metadata.mkdir()
            (metadata / "METADATA").write_text(
                "Metadata-Version: 2.1\nName: declared-dependency\nVersion: 1.0\n"
            )
            (metadata / "RECORD").write_text(
                "declared_dependency.py,,\ndeclared_dependency-1.0.dist-info/METADATA,,\ndeclared_dependency-1.0.dist-info/RECORD,,\n"
            )
            (frozen / "author_source.py").write_text("VALUE = 11\n")
            script = """
import json, sys
from pathlib import Path
from gear.refine.dependencies import dependency_identity
from gear.refine.imports import enforce_declared_imports
frozen, vendor = map(Path, sys.argv[1:])
sys.path[:0] = [str(frozen), str(vendor)]
(frozen / 'dependencies.json').write_text(json.dumps([dependency_identity('declared-dependency')]))
enforce_declared_imports(frozen)
import declared_dependency, author_source
from fractions import Fraction
try:
    import hidden_dependency
except ImportError as error:
    print(json.dumps([declared_dependency.VALUE, author_source.VALUE, str(Fraction(1, 2)), str(error)]))
else:
    raise AssertionError('hidden dependency was accepted')
"""
            result = subprocess.run(
                [sys.executable, "-c", script, str(frozen), str(vendor)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            values = json.loads(result.stdout)
            self.assertEqual(values[:3], [7, 11, "1/2"])
            self.assertIn("undeclared installed dependency", values[3])
