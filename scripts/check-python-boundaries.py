"""Enforce the new package's pure algorithm and CLI ownership boundaries."""
import ast
import importlib.util
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1] / 'python' / 'gear'
failures = []
capabilities = {'core', 'evaluation', 'memory', 'search'}
pure_packages = capabilities | {'algorithms'}
graph = {}
for path in root.rglob('*.py'):
    tree = ast.parse(path.read_text())
    relative = path.relative_to(root)
    owner = 'gear.' + '.'.join(relative.with_suffix('').parts)
    owner = owner.removesuffix('.__init__')
    package = owner if path.name == '__init__.py' else owner.rpartition('.')[0]
    edges = graph.setdefault(owner, set())
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            module = importlib.util.resolve_name('.' * node.level + (node.module or ''), package) if node.level else node.module or ''
            modules = [module]
            # `from . import child` is also a dependency on the child module.
            modules.extend(module + '.' + item.name for item in node.names)
        else:
            modules = [item.name for item in node.names] if isinstance(node, ast.Import) else []
        for module in modules:
            if module.startswith('gear.'):
                edges.add(module)
            target = module.split('.')[1] if module.startswith('gear.') else None
            if relative.parts[0] in capabilities | {'training'} and target in {'algorithms', 'ops', 'project'}:
                failures.append(f'{relative}: capability depends on higher/compatibility layer {module}')
            if relative.parts[0] == 'core' and target in {'evaluation', 'memory', 'search', 'training', 'refine'}:
                failures.append(f'{relative}: core depends on domain/runtime {module}')
            if relative.parts[0] in {'evaluation', 'memory'} and target in {'search', 'training'}:
                failures.append(f'{relative}: result/record capability depends on strategy {module}')
            if target == 'ops':
                failures.append(f'{relative}: implementation uses compatibility import {module}')
            if module == 'gear_training' or module.startswith('gear_training.'):
                failures.append(f'{relative}: imports retired package {module}')
            if module.split('.')[0] in {'tests', 'retired_policies'} or module.startswith('gear.algorithms._retired'):
                failures.append(f'{relative}: production imports historical test policies {module}')
            if relative.parts[0] in pure_packages and module.split('.')[0] in {'os', 'pathlib', 'subprocess', 'socket', 'requests', 'httpx', 'urllib'}:
                failures.append(f'{relative}: pure algorithm imports {module}')
            if relative.parts[0] == 'training' and 'cli' not in relative.parts and module == 'argparse':
                failures.append(f'{relative}: command-line parsing belongs in training/cli')
            if relative.parts[0] == 'training' and 'cli' not in relative.parts and path.name != '__main__.py' and module.startswith('gear.training.cli'):
                failures.append(f'{relative}: implementation imports command-line entrypoint {module}')
    if path.relative_to(root).parts[0] == 'training' and 'cli' not in path.relative_to(root).parts and path.name != '__main__.py':
        for node in tree.body:
            if isinstance(node, ast.If) and any(isinstance(item, ast.Name) and item.id == '__name__' for item in ast.walk(node.test)):
                failures.append(f'{path.relative_to(root)}: module execution entrypoint belongs in training/cli')
    if path.name == 'random_search.py' and 'gepa' in path.read_text():
        failures.append(f'{path.name}: RandomSearch depends on the GEPA recipe')
    if path.name in {'gepa.py', 'random_search.py'}:
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and 'archived' in node.name:
                failures.append(f'{path.relative_to(root)}: historical policy belongs in test fixtures')
for name in ['parents', 'sampling', 'proposal', 'ranking', 'stopping', 'workflow']:
    if not (root / 'search' / (name + '.py')).is_file():
        failures.append(f'search: missing shared capability {name}')
for recipe in ['gepa', 'random_search']:
    if not (root / 'algorithms' / (recipe + '.py')).is_file():
        failures.append(f'{recipe}: missing complete algorithm')
for recipe in ['opro', 'ace', 'rrsi', 'darwinx', 'harness2']:
    if not (root / 'algorithms' / (recipe + '.py')).is_file():
        failures.append(f'{recipe}: missing complete algorithm')
for path in (root / 'algorithms').rglob('*.py'):
    if 'Compatibility imports' in (ast.get_docstring(ast.parse(path.read_text())) or ''):
        failures.append(f'{path.relative_to(root)}: obsolete compatibility module')
# Inspect actual module imports, including package re-exports, within pure capabilities.
visited = set()
def visit(module, trail):
    if module in trail:
        failures.append('capability import cycle: ' + ' -> '.join(trail + [module]))
        return
    if module in visited:
        return
    visited.add(module)
    for target in graph.get(module, ()):
        if target in graph and target.partition('.')[2].partition('.')[0] in capabilities:
            visit(target, trail + [module])
for module in graph:
    if module.partition('.')[2].partition('.')[0] in capabilities:
        visit(module, [])
if (root / 'ops').exists():
    failures.append('The retired gear.ops package still exists')
for recipe in ['gepa', 'random_search']:
    if (root / 'algorithms' / recipe).exists():
        failures.append(f'{recipe}: obsolete algorithm package')
if (root.parent / 'gear_training').exists():
    failures.append('The retired gear_training package still exists')
for name in ['gates.py', 'history.py', 'observations.py', '_retired', 'contracts.py', 'operators.py', 'meta.py', 'gepa/parents.py', 'random_search/parents.py']:
    if (root / 'algorithms' / name).exists():
        failures.append(f'algorithms/{name}: retired policy leaked into the production package')
for patch in (root.parent / 'patches').glob('*.patch'):
    if re.search(r'^\+\s*(?:from|import)\s+gear_training(?:\.|\s)', patch.read_text(), re.MULTILINE):
        failures.append(f'{patch.name}: added code imports the retired training package')
if failures:
    raise SystemExit('\n'.join(failures))
print('Python algorithm, training and CLI boundaries passed')
