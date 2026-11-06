"""Native upstream grader parity; no dependency on Kaggle credentials or data."""
import importlib
import json
import math
import sys
import tempfile
import hashlib
from pathlib import Path
import pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'target-carrier/fixed'))
import scoring
from worker import public_assets

def check(metric, competition, targets, truths, values, labels):
    schema = {'kind': 'tabular', 'metric': metric, 'idColumn': 'id', 'targetColumns': targets, 'labels': labels}
    ids = ['3', '1', '4', '2']
    answer = pd.DataFrame([[int(k), *v] for k, v in zip(ids, truths)], columns=['id', *targets])
    submitted = pd.DataFrame([[int(k), *v] for k, v in zip(ids, values)], columns=['id', *targets])
    native = importlib.import_module(f'mlebench.competitions.{competition}.grade').grade
    expected = float(native(submitted, answer))
    # Input may be unordered; exported data must match native positional order.
    canonical = scoring.canonical_submission(submitted.iloc[::-1].to_csv(index=False).encode(), schema, ids)
    predicted = scoring.predictions(canonical, schema, ids)
    actual = scoring.score(schema, {str(r['id']): r for r in answer.to_dict('records')}, predicted, ids)
    assert math.isclose(actual, expected, abs_tol=1e-12), (actual, expected)
    return actual

auc = check('auc-roc', 'tabular-playground-series-may-2022', ['target'], [[0],[1],[0],[1]], [[.3],[.3],[.2],[.8]], ['0','1'])
assert auc == .875
rmsle = check('mean-column-wise-rmsle', 'nomad2018-predict-transparent-conductors',
    ['formation_energy_ev_natom','bandgap_energy_ev'], [[0,1],[2,3],[4,5],[6,7]], [[.1,.8],[1.5,2.8],[4.4,6],[6.1,8]], [])
assert 0 < rmsle < 1
# Means of fold AUCs can disagree with pooled AUC; only pooled predictions count.
s = {'metric':'auc-roc','targetColumns':['target'],'labels':['0','1']}
truth = {str(i): {'target': str(i%2)} for i in range(4)}
pred = {str(i): [v] for i,v in enumerate([.1,.2,.8,.9])}
assert scoring.score(s,truth,pred,['0','1']) == scoring.score(s,truth,pred,['2','3']) == 1
assert scoring.score(s,truth,pred,list(truth)) == .75
with tempfile.TemporaryDirectory() as d:
    root = Path(d); assets = []
    for role in ['train','test']:
        for key in ['1','2']:
            path = f'{role}/{key}/geometry.xyz'; dest = root/path; dest.parent.mkdir(parents=True,exist_ok=True)
            content = f'{role}-{key}'.encode(); dest.write_bytes(content)
            assets.append({'path':path,'role':'train' if role=='train' else 'predict','rowId':key,
                'digest':'sha256:'+hashlib.sha256(content).hexdigest(),'bytes':len(content)})
    result = public_assets({'publicDirectory':d,'publicFiles':assets}, {'1'}, {'2'}, cv=True)
    assert result == {'train/1/geometry.xyz':b'train-1','test/2/geometry.xyz':b'train-2'}
print(json.dumps({'status':'passed','auc':auc,'rmsle':rmsle,'pooledAuc':.75,'geometryScope':'passed'}))
