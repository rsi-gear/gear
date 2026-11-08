"""CPU-only contract checks. No Target/model API or competition evaluation."""
import hashlib
import gzip
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

FIXED = Path(__file__).resolve().parents[1] / 'target-carrier/fixed'
sys.path.insert(0, str(FIXED))
import worker
import research_worker

FACTORY = b'''from sklearn.dummy import DummyClassifier
def build_pipeline(config):
    return DummyClassifier(strategy='constant', constant=config['hyperparameters']['constant'])
'''


def local_python(files, inputs, entrypoint, argv, wall_seconds, cpu_seconds):
    """Replace only Linux chroot creation; execute the identical fit-only entry."""
    if wall_seconds <= 0 or cpu_seconds <= 0:
        raise ValueError('budget exhausted')
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for name, data in {**files, **inputs}.items():
            path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        spec = json.loads((root / 'pipeline.json').read_text())
        spec['entrypoint'] = str(root / Path(spec['entrypoint']).name)
        (root / 'pipeline.json').write_text(json.dumps(spec))
        script = "import sys,json; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from pipeline_runner import fit_predict; p=Path(sys.argv[2]); r=fit_predict(json.loads((p/'pipeline.json').read_text()),p/'train.csv',p/'predict.csv',p/'predictions.csv'); (p/'pipeline-fit.json').write_text(json.dumps(r))"
        result = subprocess.run([sys.executable, '-c', script, str(FIXED), temp], capture_output=True, timeout=30)
        return {'exitCode': result.returncode, 'limit': None, 'cpuSeconds': .01, 'wallSeconds': .01,
                'logs': {'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()},
                'outputs': {name: (root/name).read_bytes() for name in ['predictions.csv', 'pipeline-fit.json'] if (root/name).exists()}}


def config(constant):
    return {'inputSchema': {}, 'preprocessing': {}, 'features': {}, 'model': 'dummy',
            'hyperparameters': {'constant': constant}, 'prediction': {'kind': 'label'}, 'seed': 42}


class WorkflowRuntime(unittest.TestCase):
    def test_round_cv_uses_all_rows_shared_folds_and_no_holdout_fit(self):
        data = b'id,x,target\n' + b''.join(f'{i},{i},{i%2}\n'.encode() for i in range(20))
        schema = {'kind': 'tabular', 'idColumn': 'id', 'targetColumns': ['target'], 'metric': 'accuracy', 'labels': ['0','1']}
        frozen = {'protocol': 'analysis-round-cv-plan@1', 'trainDigest': 'sha256:'+hashlib.sha256(data).hexdigest(),
                  'kind': 'stratified', 'folds': 5, 'shuffle': True, 'seed': 1234, 'metric': 'accuracy',
                  'splitter': 'python-random-stratified-round-robin@1'}
        plan = {'variants': [{'id': 'zero', 'config': config(0)}, {'id': 'one', 'config': config(1)}],
                'validation': {'kind': 'stratified', 'folds': 5, 'shuffle': True, 'seed': 1234}, 'seed': 42,
                'maxFits': 11, 'refitReserve': 1}
        original = worker.run_python
        calls = []
        def tracked(files, inputs, entrypoint, argv, wall, cpu):
            train_ids = [r['id'] for r in worker.read_csv(inputs['train.csv'])[1]]
            qfields, query = worker.read_csv(inputs['predict.csv'])
            query_ids = [r['id'] for r in query]
            self.assertNotIn('target', qfields)
            self.assertFalse(set(train_ids) & set(query_ids))
            self.assertEqual(set(train_ids) | set(query_ids), {str(i) for i in range(20)})
            calls.append((train_ids, query_ids))
            return local_python(files, inputs, entrypoint, argv, wall, cpu)
        worker.run_python = tracked; self.addCleanup(setattr, worker, 'run_python', original)
        with tempfile.TemporaryDirectory() as temp:
            job = {'searchPlan': plan, 'prediction': schema, 'validationPlan': frozen, 'entrypoint': 'solution.py',
                   'outputDirectory': temp, 'cpuSeconds': 200, 'wallSeconds': 200}
            result = research_worker.research(worker, job, {'solution.py': FACTORY}, data)
            self.assertEqual(result['status'], 'completed', result['logs'])
            self.assertEqual(result['fits'], 10)
            self.assertEqual(result['fitAttempts'], 10)
            self.assertIsNone(result['formalFit'])
            self.assertEqual(result['validationRows'], 0)
            self.assertEqual(calls[:5], calls[5:])
            self.assertEqual(len(set(k for _, query in calls[:5] for k in query)), 20)
            self.assertEqual(result['meanScore'], .5)
            self.assertEqual(result['stdScore'], 0)
            self.assertEqual(len(json.loads(gzip.decompress(Path(result['oofPath']).read_bytes()))), 20)
            _, rows = worker.read_csv(data)
            same = research_worker.folds(rows, schema, frozen, 1234)
            self.assertEqual(same, calls[:5])
            self.assertNotEqual(same, research_worker.folds(rows, schema, frozen, 1235))
            # A changed model seed cannot change the admitted CV split.
            self.assertNotEqual(plan['seed'], frozen['seed'])
            for override in [{'folds': 2}, {'kind': 'group', 'column': 'x'}, {'seed': 99}, {'shuffle': False}]:
                before = len(calls)
                with self.assertRaises(ValueError):
                    research_worker.research(worker, {**job, 'searchPlan': {**plan, 'validation': {**plan['validation'], **override}}}, {'solution.py': FACTORY}, data)
                self.assertEqual(len(calls), before)

    def test_group_and_time_splits_respect_dependency_structure(self):
        rows = [{'id': str(i), 'group': str(i//2), 'time': str(i//2), 'target': str(i%2)} for i in range(20)]
        schema = {'idColumn': 'id', 'targetColumns': ['target']}
        for kind, column in [('group', 'group'), ('time', 'time')]:
            splits = research_worker.folds(rows, schema, {'kind': kind, 'column': column, 'folds': 3}, 42)
            lookup = {r['id']: r for r in rows}
            for train, val in splits:
                self.assertFalse(set(train) & set(val))
                self.assertFalse({lookup[k][column] for k in train} & {lookup[k][column] for k in val})
                if kind == 'time':
                    self.assertLess(max(int(lookup[k][column]) for k in train), min(int(lookup[k][column]) for k in val))

    def test_search_freezes_winner_and_expanded_refit_does_not_search(self):
        data = b'id,x,target\n0,0,0\n1,1,0\n2,2,0\n3,3,1\n4,4,0\n5,5,0\n6,6,0\n7,7,1\n8,8,0\n9,9,1\n'
        schema = {'kind': 'tabular', 'idColumn': 'id', 'targetColumns': ['target'], 'metric': 'accuracy', 'labels': ['0','1']}
        plan = {'variants': [{'id': 'zero', 'config': config(0)}, {'id': 'one', 'config': config(1)}],
                'validation': {'kind': 'stratified', 'folds': 2}, 'seed': 42, 'maxFits': 5}
        holdout = {'trainDigest': 'sha256:'+hashlib.sha256(data).hexdigest(), 'assignments': [0,0,0,0,0,0,0,0,1,1], 'metric': 'accuracy'}
        original = worker.run_python; worker.run_python = local_python
        self.addCleanup(setattr, worker, 'run_python', original)
        with tempfile.TemporaryDirectory() as temp:
            job = {'searchPlan': plan, 'prediction': schema, 'validationPlan': holdout, 'entrypoint': 'solution.py',
                   'outputDirectory': temp, 'cpuSeconds': 100, 'wallSeconds': 100}
            result = research_worker.research(worker, job, {'solution.py': FACTORY}, data)
            self.assertEqual(result['status'], 'completed', result['logs'])
            self.assertEqual(result['formalVariantId'], 'zero')
            self.assertEqual(result['fits'], 5)
            self.assertEqual(len(result['variants']), 2)
            self.assertEqual(result['formalFit']['searchCalls'], 0)
            # Adding positive rows reverses which constant classifier would win.
            expanded = data + b''.join(f'{i},{i},1\n'.encode() for i in range(10, 30))
            labels = [r['target'] for r in worker.read_csv(expanded)[1]]
            self.assertGreater(labels.count('1'), labels.count('0'))
            resolved = {'config': config(0), 'actualParameters': result['formalFit']['parametersBefore']}
            delivery = research_worker.invoke(worker, {**job, 'resolvedPipeline': resolved}, {'solution.py': FACTORY},
                {'train.csv': expanded, 'predict.csv': b'id,x\n99,99\n'}, config(0), 10, 30)
            self.assertEqual(delivery['exitCode'], 0, delivery['logs'])
            self.assertEqual(delivery['outputs']['predictions.csv'], b'id,target\n99,0\n')
            self.assertEqual(delivery['fitReceipt']['fits'], 1)
            self.assertEqual(delivery['fitReceipt']['searchCalls'], 0)
            self.assertEqual(delivery['fitReceipt']['parametersBefore'], resolved['actualParameters'])

    def test_factory_cannot_train_or_embed_sklearn_search(self):
        files = {'solution.py': b'''from sklearn.dummy import DummyClassifier
def build_pipeline(config):
    model=DummyClassifier(strategy='most_frequent')
    model.fit([[1],[2]],[0,1])
    return model
''', '_gear_pipeline.py': b''}
        inputs = {'pipeline.json': json.dumps({'config': config(0), 'entrypoint': '/work/source/solution.py',
            'prediction': {'idColumn': 'id', 'targetColumns': ['target']}, 'maxFitCalls': 20}).encode(),
            'train.csv': b'id,x,target\n0,0,0\n1,1,1\n', 'predict.csv': b'id,x\n2,2\n'}
        result = local_python(files, inputs, '_gear_pipeline.py', [], 30, 10)
        self.assertNotEqual(result['exitCode'], 0)
        self.assertIn('fit outside', result['logs']['stderr'])

    def test_learned_transforms_fit_training_only_and_handle_unseen_prediction_values(self):
        factory = b'''from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
class TrainingScope(BaseEstimator, TransformerMixin):
    def fit(self, X, y=None):
        assert X['id'].max() < 100, 'prediction rows leaked into fit'
        return self
    def transform(self, X): return X
def build_pipeline(config):
    transforms=ColumnTransformer([('numeric',SimpleImputer(strategy='median'),['age']),('category',OneHotEncoder(handle_unknown='ignore'),['category'])])
    return Pipeline([('scope',TrainingScope()),('transform',transforms),('model',LogisticRegression(C=config['hyperparameters']['C'],random_state=config['seed']))])
'''
        configuration = {**config(0), 'model': 'logistic', 'hyperparameters': {'C': 1.0}}
        inputs = {'pipeline.json': json.dumps({'config': configuration, 'entrypoint': '/work/source/solution.py',
            'prediction': {'idColumn': 'id', 'targetColumns': ['target']}, 'maxFitCalls': 50}).encode(),
            'train.csv': b'id,age,category,target\n1,20,a,0\n2,,b,1\n3,40,a,0\n4,50,b,1\n',
            'predict.csv': b'id,age,category\n100,999,new\n101,,a\n'}
        result = local_python({'solution.py': factory}, inputs, '_gear_pipeline.py', [], 30, 10)
        self.assertEqual(result['exitCode'], 0, result['logs'])
        receipt = json.loads(result['outputs']['pipeline-fit.json'])
        self.assertGreater(receipt['fitCalls'], 1)
        self.assertEqual(receipt['parametersBefore'], receipt['parametersAfter'])
        self.assertEqual(len(worker.read_csv(result['outputs']['predictions.csv'])[1]), 2)


if __name__ == '__main__':
    unittest.main()
