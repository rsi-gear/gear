"""Enforce the new package's pure algorithm and CLI ownership boundaries."""
import ast
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1] / 'python' / 'gear'
failures = []
for path in root.rglob('*.py'):
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        modules = [node.module or ''] if isinstance(node, ast.ImportFrom) else [item.name for item in node.names] if isinstance(node, ast.Import) else []
        for module in modules:
            relative = path.relative_to(root)
            if module == 'gear_training' or module.startswith('gear_training.'):
                failures.append(f'{relative}: imports retired package {module}')
            if module.split('.')[0] in {'tests', 'retired_policies'} or module.startswith('gear.algorithms._retired'):
                failures.append(f'{relative}: production imports historical test policies {module}')
            if relative.parts[0] == 'algorithms' and module.split('.')[0] in {'os', 'pathlib', 'subprocess', 'socket', 'requests', 'httpx', 'urllib'}:
                failures.append(f'{relative}: pure algorithm imports {module}')
            if relative.parts[0] == 'training' and 'cli' not in relative.parts and module == 'argparse':
                failures.append(f'{relative}: command-line parsing belongs in training/cli')
            if relative.parts[0] == 'training' and 'cli' not in relative.parts and path.name != '__main__.py' and module.startswith('gear.training.cli'):
                failures.append(f'{relative}: implementation imports command-line entrypoint {module}')
    if path.relative_to(root).parts[0] == 'training' and 'cli' not in path.relative_to(root).parts and path.name != '__main__.py':
        for node in tree.body:
            if isinstance(node, ast.If) and any(isinstance(item, ast.Name) and item.id == '__name__' for item in ast.walk(node.test)):
                failures.append(f'{path.relative_to(root)}: module execution entrypoint belongs in training/cli')
    if path.parent.name == 'random_search' and 'gepa' in path.read_text():
        failures.append(f'{path.name}: RandomSearch depends on the GEPA recipe')
    if path.parent.name in {'gepa', 'random_search'}:
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and 'archived' in node.name:
                failures.append(f'{path.relative_to(root)}: historical policy belongs in test fixtures')
for recipe in ['gepa', 'random_search']:
    for name in ['parents', 'sampling', 'proposal', 'ranking', 'stopping', 'algorithm']:
        if not (root / 'algorithms' / recipe / (name + '.py')).is_file():
            failures.append(f'{recipe}: missing standard module {name}')
if (root.parent / 'gear_training').exists():
    failures.append('The retired gear_training package still exists')
for name in ['gates.py', 'history.py', 'observations.py', '_retired']:
    if (root / 'algorithms' / name).exists():
        failures.append(f'algorithms/{name}: retired policy leaked into the production package')
for patch in (root.parent / 'patches').glob('*.patch'):
    if re.search(r'^\+\s*(?:from|import)\s+gear_training(?:\.|\s)', patch.read_text(), re.MULTILINE):
        failures.append(f'{patch.name}: added code imports the retired training package')
if failures:
    raise SystemExit('\n'.join(failures))
print('Python algorithm, training and CLI boundaries passed')
