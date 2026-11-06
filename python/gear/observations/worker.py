"""Private one-shot I/O worker. Sources arrive from the trusted installed adapter."""

import importlib.abc
import importlib.util
import json
import sys

request = json.load(sys.stdin)
sources = request.pop("sources")


class Frozen(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path=None, target=None):
        if name != "gear" and not name.startswith("gear."):
            return None
        base = name.replace(".", "/")
        filename = base + "/__init__.py" if base + "/__init__.py" in sources else base + ".py"
        if filename not in sources:
            raise ImportError("Module outside the observation source snapshot: " + name)
        spec = importlib.util.spec_from_loader(
            name, self, is_package=filename.endswith("/__init__.py")
        )
        spec.loader_state = filename
        return spec

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        filename = module.__spec__.loader_state
        module.__file__ = "<observation/" + filename + ">"
        exec(compile(sources[filename], module.__file__, "exec"), module.__dict__)


sys.meta_path.insert(0, Frozen())
from gear.observations.hitch import observe  # noqa: E402

try:
    print(json.dumps(observe(request), ensure_ascii=False, allow_nan=False, separators=(",", ":")))
except Exception:
    print(json.dumps({"error": "native-observation-unavailable"}))
    sys.exit(1)
