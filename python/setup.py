"""Prevent removed modules from surviving an incremental wheel build."""

import shutil
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py


class CleanBuildPy(build_py):
    def run(self):
        # setuptools otherwise copies stale build/lib files into the next wheel.
        # This distribution is pure Python, so the entire generated tree is ours.
        directory = Path(self.build_lib)
        if directory.exists():
            generated = Path(__file__).resolve().parent / "build"
            if generated not in directory.resolve().parents:
                raise RuntimeError("Use an empty custom build directory or the default build/lib")
            shutil.rmtree(directory)
        super().run()


setup(cmdclass={"build_py": CleanBuildPy})
