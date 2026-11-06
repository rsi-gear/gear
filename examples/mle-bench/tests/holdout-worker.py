"""Check both research entry points at the generated-code boundary, without a container."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'target-carrier/fixed'))
import worker

schema = {'kind': 'tabular', 'idColumn': 'id', 'targetColumns': ['target'], 'metric': 'accuracy', 'labels': ['0', '1']}
train = b'id,x,target\n1,0,0\n2,1,1\n3,0,0\n4,1,1\n5,0,0\n6,1,1\n'
plan = {'protocol': 'analysis-holdout-plan@1', 'seed': 42, 'metric': 'accuracy',
        'trainDigest': 'sha256:' + hashlib.sha256(train).hexdigest(), 'validationFraction': 1/3, 'assignments': [0, 0, 0, 0, 1, 1]}

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    files = []
    for role, ids in [('train', range(1, 7)), ('test', [9])]:
        for key in ids:
            name = f'{role}/{key}/geometry.xyz'; content = str(key).encode()
            path = root / 'public' / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(content)
            files.append({'path': name, 'role': 'train' if role == 'train' else 'predict', 'rowId': str(key),
                          'digest': 'sha256:' + hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
    calls = []

    def execute(sources, inputs, entrypoint, argv, wall_seconds, cpu_seconds):
        calls.append(inputs)
        fields, visible = worker.read_csv(inputs['train.csv'])
        assert fields == ['id', 'x', 'target'] and [r['id'] for r in visible] == ['1', '2', '3', '4']
        fields, query = worker.read_csv(inputs['predict.csv'])
        assert fields == ['id', 'x'] and [r['id'] for r in query] == ['5', '6']
        assert 'train/5/geometry.xyz' not in inputs and 'train/6/geometry.xyz' not in inputs
        assert inputs['test/5/geometry.xyz'] == b'5' and inputs['test/6/geometry.xyz'] == b'6'
        assert 'test/9/geometry.xyz' not in inputs
        return {'exitCode': 0, 'limit': None, 'outputs': {'predictions.csv': b'id,target\n5,0\n6,1\n'},
                'cpuSeconds': .1, 'wallSeconds': .1, 'logs': {'stdout': 'claimed score=0.123', 'stderr': ''}}

    worker.run_python = execute
    job = {'entrypoint': 'solution.py', 'trainingSeed': 42, 'cpuSeconds': 10, 'wallSeconds': 10,
           'publicFiles': files, 'publicDirectory': str(root / 'public'), 'outputDirectory': str(root / 'output')}
    # No forced folds or repeated model fitting. Formal reward uses fixed answers.
    for _ in range(2):
        result = worker.evaluate(job, {}, train, schema, plan)
        assert result['validationScore'] == 1 and result['validationRows'] == 2
        assert result['status'] == 'completed' and 'foldMetrics' not in result
    assert len(calls) == 2 and calls[0] == calls[1]

    # The data-inspection tool must receive the SAME filtered inputs as evaluation.
    (root / 'train.csv').write_bytes(train)
    (root / 'predict.csv').write_bytes(b'id,x\n9,1\n')
    job.update(operation='script', files={}, inputs={'train.csv': str(root / 'train.csv'), 'predict.csv': str(root / 'predict.csv')},
               prediction=schema, validationPlan=plan, argv=[])
    job_file = root / 'job.json'; job_file.write_text(json.dumps(job))
    sys.argv = ['worker.py', '--job', str(job_file)]
    with contextlib.redirect_stdout(io.StringIO()):
        worker.main()
    assert calls[-1] == calls[0]
    for bad in [{**plan, 'assignments': [0] * 6}, {**plan, 'trainDigest': 'changed'}]:
        try:
            worker.holdout_scope(train, schema, bad)
        except ValueError:
            pass
        else:
            raise AssertionError('changed validation scope accepted')

print(json.dumps({'status': 'passed', 'formalCalls': 2, 'validationLabels': 'hidden', 'analysisScope': 'same-as-evaluation'}))
