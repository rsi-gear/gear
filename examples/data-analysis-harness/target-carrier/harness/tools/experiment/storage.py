"""Disposable versioned cache; immutable inputs are the recovery source."""
import gzip, json, os
from pathlib import Path
VERSION = 1

def rebuild(records, root):
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    body = {'version': VERSION, 'ids': [r['identity']['experimentId'] for r in records]}
    tmp = root / 'index.tmp'
    tmp.write_bytes(gzip.compress(json.dumps(body).encode(), mtime=0))
    os.replace(tmp, root / 'index.json.gz')
    return body

def migrate(previous, records, root):
    if previous:
        try:
            cached = json.loads(gzip.decompress((Path(previous) / 'index.json.gz').read_bytes()))
            if cached['version'] == VERSION and cached['ids'] == [r['identity']['experimentId'] for r in records]:
                # Copy into this version's output; prior versions stay read-only.
                Path(root).mkdir(parents=True, exist_ok=True)
                (Path(root) / 'index.json.gz').write_bytes(gzip.compress(json.dumps(cached).encode(), mtime=0))
                return cached
        except (OSError, ValueError, KeyError):
            pass
    return rebuild(records, root)
