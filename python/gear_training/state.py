"""Private durable state primitives shared by node services."""
import fcntl
import json
from contextlib import contextmanager
from pathlib import Path


def load(path, default=None):
    try: return json.loads(Path(path).read_text())
    except FileNotFoundError: return default


@contextmanager
def lock(path, *, blocking=True):
    Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path, "a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        try: yield
        finally: fcntl.flock(stream, fcntl.LOCK_UN)
