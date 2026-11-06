"""Private frozen-policy bootstrap; invoked in an isolated Python interpreter."""

import importlib.abc
import importlib.util
import json
import sys

if sys.version_info < (3, 10):
    print(
        json.dumps(
            {
                "error": "Python policies require Python 3.10+; run gear setup or set GEAR_PYTHON",
                "type": "RuntimeError",
            }
        )
    )
    sys.exit()
sources = json.loads(sys.stdin.readline())["sources"]


class Frozen(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path=None, target=None):
        if name != "gear" and not name.startswith("gear."):
            return None
        base = name.replace(".", "/")
        filename = base + "/__init__.py" if base + "/__init__.py" in sources else base + ".py"
        if filename not in sources:
            raise ImportError("Module is outside the packaged policy snapshot: " + name)
        spec = importlib.util.spec_from_loader(
            name, self, is_package=filename.endswith("/__init__.py")
        )
        spec.loader_state = filename
        return spec

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        filename = module.__spec__.loader_state
        module.__file__ = "<packaged/" + filename + ">"
        exec(compile(sources[filename], module.__file__, "exec"), module.__dict__)


sys.meta_path.insert(0, Frozen())
from gear.algorithms.operators import main  # noqa: E402 — install the frozen loader first

for line in sys.stdin:
    main(json.loads(line))
