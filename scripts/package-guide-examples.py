#!/usr/bin/env python3
"""Build deterministic guide downloads from reviewed example source (stdlib only)."""
from pathlib import Path
import json
import zipfile
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'docs/guide/assets'
BUNDLES = {
    'automationbench-marketing': 'marketing-harness-example.zip',
    'evolution-search': 'evolution-search-example.zip',
}
for example, output in BUNDLES.items():
    source_root = ROOT / 'examples' / example
    provenance = json.loads((source_root / 'provenance.json').read_text())
    names = set(provenance['files']) | {'README.md', 'README.zh-CN.md', 'provenance.json', 'meta-input.txt'}
    if example == 'automationbench-marketing':
        names.update({'inspect.mjs', 'evidence-index.json'})
    else:
        names.update({'selection.mjs', 'selection.test.mjs', 'replay.mjs', 'algorithm-settings.json', 'max-evaluation.json', 'codex-astra-max-evaluation.json'})
    files = [source_root / name for name in sorted(names)]
    files += [ROOT / 'LICENSE', ROOT / 'docs/guide/assets/marketing-results.json']
    if example == 'evolution-search':
        files.append(ROOT / 'examples/automationbench-marketing/inspect.mjs')
    with zipfile.ZipFile(ASSETS / output, 'w', zipfile.ZIP_DEFLATED) as archive:
        def add(name, data):
            entry = zipfile.ZipInfo(name, (2026, 9, 14, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
        for source in sorted(files):
            add(source.relative_to(ROOT).as_posix(), source.read_bytes())
        add('START-HERE.txt', (
            f'Extract into a matching Gear source checkout and read examples/{example}/README.md.\n'
            'Historical Harness files are exact source; a new carrier creates new identities.\n'
            'The download excludes runtime dependencies, datasets, credentials and historical state.\n'
        ).encode())
    print(f'Packaged {output}: {len(files)} source files')

# Expose only the source files explicitly referenced by the public guide.
# Text extensions keep code and Markdown inert when opened in a browser.
manifest = json.loads((ROOT / 'docs/guide/manifest.json').read_text())
for source, asset in manifest.get('sourceAssets', {}).items():
    source_path = ROOT / source
    if source_path.is_symlink() or not source_path.is_file() or ROOT not in source_path.resolve().parents:
        raise ValueError(f'Invalid guide source: {source}')
    (ROOT / 'docs/guide' / asset).write_bytes(source_path.read_bytes())
print(f'Exported {len(manifest.get("sourceAssets", {}))} source attachments.')

# Keep the historical search source available even when its GitHub repository is private.
revision = 'e172456672414bfe0a14c8b94fd1b640b6493c30'
def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])
source_paths = git('ls-tree', '-r', '--name-only', revision, 'src/search').decode().splitlines()
if not source_paths:
    raise ValueError('The pinned search implementation is unavailable locally')
with zipfile.ZipFile(ASSETS / 'staged-search-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for source in [*source_paths, 'LICENSE']:
        entry = zipfile.ZipInfo(source, (2026, 9, 14, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, git('show', f'{revision}:{source}'))
    entry = zipfile.ZipInfo('SOURCE.txt', (2026, 9, 14, 0, 0, 0))
    archive.writestr(entry, f'Gear {revision}\nExact src/search files for source inspection, not a standalone runtime.\n')
print(f'Exported {len(source_paths)} pinned search source files.')
