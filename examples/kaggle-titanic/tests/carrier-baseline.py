"""Exercise the actual sklearn baseline on synthetic Titanic-shaped inputs."""
import csv
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import numpy
import pandas
import sklearn

assert (numpy.__version__, pandas.__version__, sklearn.__version__) == ('1.26.4', '2.2.3', '1.5.2')
entry = Path(__file__).resolve().parents[1] / 'target-carrier/harness/workflows/titanic/pipeline.py'
confined = '--confined' in sys.argv
if confined:
    spec = importlib.util.spec_from_file_location('runner', entry.parents[3] / 'fixed/runner.py')
    runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
    runtime = Path('/opt/kaggle-runtime')
    if not runtime.exists():
        # Match the producer's runtime/Dockerfile mirroring recipe.
        (runtime / 'etc').mkdir(parents=True)
        for name in ('usr', 'lib', 'lib64', 'bin'):
            source = Path('/') / name
            if source.is_symlink(): (runtime / name).symlink_to(os.readlink(source))
            elif source.exists(): shutil.copytree(source, runtime / name, symlinks=True)
        if Path('/etc/ld.so.cache').exists(): shutil.copy2('/etc/ld.so.cache', runtime / 'etc/ld.so.cache')
        for path in runtime.rglob('*'):
            if not path.is_symlink(): path.chmod(path.stat().st_mode & ~0o022)
columns = ['PassengerId', 'Pclass', 'Sex', 'Age', 'SibSp', 'Parch', 'Fare', 'Embarked']
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    with (root / 'train.csv').open('w') as stream:
        writer = csv.writer(stream); writer.writerow(columns + ['Survived'])
        for index in range(60):
            writer.writerow([index + 1, index % 3 + 1, 'female' if index % 2 else 'male',
                             '' if index % 7 == 0 else 15 + index % 50, index % 3, index % 2,
                             10 + index, 'S' if index % 3 else 'C', index % 2])
    with (root / 'predict.csv').open('w') as stream:
        writer = csv.writer(stream); writer.writerow(columns)
        for index in range(8):
            # Missing numeric data and unseen categorical levels must be valid.
            writer.writerow([99 - index, 3, 'female' if index % 2 else 'male', '', 0, 0, '', 'Q'])
    outputs = []
    for index in range(2):
        output = root / f'prediction-{index}.csv'
        if confined:
            repository = root / 'repository'; harness = repository / 'harness'
            if not repository.exists():
                shutil.copytree(entry.parent, harness / 'workflows/titanic')
                artifacts = [{'path':'workflows/titanic/'+path.name,'digest':runner.digest(path.read_bytes()),'bytes':path.stat().st_size}
                             for path in sorted((harness / 'workflows/titanic').iterdir())]
                (harness / 'manifest.json').write_text(json.dumps({'artifacts':artifacts}))
                (root / 'artifact.json').write_text(json.dumps({'harness_id':'deepseek','source_type':'git','revision_identity':'sha256:'+'b'*64,
                                                               'resolved_revision':{'revision':{'type':'commit','commit':'a'*40}}}))
                task={'protocol':'kaggle-task@1','mode':'validation','task_id':'baseline','seed':42,'timeout_sec':60,
                      'input_digests':{name:runner.digest((root / (name+'.csv')).read_bytes()) for name in ('train','predict')}}
                task['task_digest']=runner.digest(runner.canonical(task)); (root / 'task.json').write_text(json.dumps(task))
            outdir = root / f'sealed-{index}'
            receipt=runner.run(repository,root / 'artifact.json',data_dir=root,output=outdir)
            assert receipt['status']=='completed', receipt
            shutil.copyfile(outdir / 'predictions.csv',output)
        else:
            subprocess.run([sys.executable, '-B', str(entry), '--train', str(root / 'train.csv'),
                            '--predict', str(root / 'predict.csv'), '--output', str(output), '--seed', '42'], check=True)
        outputs.append(output.read_bytes())
    assert outputs[0] == outputs[1]
    with (root / 'prediction-0.csv').open() as stream:
        reader = csv.DictReader(stream); rows = list(reader)
        assert reader.fieldnames == ['PassengerId', 'Survived']
        assert [int(row['PassengerId']) for row in rows] == list(range(99, 91, -1))
        assert {row['Survived'] for row in rows} <= {'0', '1'}
    print(('confined ' if confined else '') + 'baseline passed: missing data, unseen category, IDs, binary labels, deterministic rerun')
