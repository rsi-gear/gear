"""Run inside the real pinned container, with /runner holding fixed source."""
import json
import hashlib
import gzip
import sys
from pathlib import Path
sys.path.insert(0, '/runner')
from worker import run_python, evaluate, validate_predictions

# The forbidden files really exist outside the generated-code chroot.
for path in ['/data/private/expected.csv', '/root/.codex/auth.json', '/outside-canary']:
    target = Path(path); target.parent.mkdir(parents=True, exist_ok=True); target.write_text('synthetic-canary-secret')

canary = b'''import json,os,socket
blocked=[]
for name in ['/proc/self/environ','/data/private/expected.csv','/root/.codex/auth.json','/outside-canary']:
 try: open(name).read()
 except OSError: blocked.append(name)
 else: raise AssertionError('escaped chroot')
try: socket.socket()
except OSError: blocked.append('network')
else: raise AssertionError('network allowed')
try: os.fork()
except OSError: blocked.append('fork')
else: raise AssertionError('fork allowed')
assert not any('TOKEN' in k or 'KEY' in k for k in os.environ)
json.dump(blocked,open('/work/scratch/result.json','w'))
'''
r = run_python({'canary.py': canary}, {}, 'canary.py', [], 30, 10)
assert r['exitCode'] == 0, r
assert len(json.loads(r['outputs']['result.json'])) == 6

solution = b'''import argparse,csv,json
p=argparse.ArgumentParser()
for k in ['train','predict','output','seed']: p.add_argument('--'+k)
a=p.parse_args()
train=list(csv.DictReader(open(a.train))); query=list(csv.DictReader(open(a.predict)))
assert all('label' not in r for r in query)
assert not ({r['row'] for r in train} & {r['row'] for r in query})
with open(a.output,'w') as f:
 w=csv.writer(f);w.writerow(['row','label']);w.writerows([r['row'],str(int(r['x'])%2)] for r in query)
print('accuracy: 0.123456')
'''
train = ('row,x,label\n' + ''.join(f'{i},{i},{i%2}\n' for i in range(20))).encode()
folds = [{'validationIds': [str(i) for i in range(20) if i % 5 == k], 'trainIds': [str(i) for i in range(20) if i % 5 != k]} for k in range(5)]
schema = {'idColumn': 'row', 'targetColumn': 'label', 'allowedLabels': ['0', '1']}
job = {'entrypoint': 'solution.py', 'trainingSeed': 42, 'wallSeconds': 90, 'cpuSeconds': 30}
r = evaluate(job, {'solution.py': solution}, train, schema, {'folds': folds})
assert r['pooledAccuracy'] == 1 and len(r['oof']) == 20 and len(r['foldMetrics']) == 5, r
try: validate_predictions(b'row,label\n0,1\n0,0\n', schema, {'0'})
except ValueError: pass
else: raise AssertionError('duplicate ID accepted')
broken = evaluate(job, {'solution.py': b'raise RuntimeError("candidate error")'}, train, schema, {'folds': folds})
assert broken['status'] == 'candidate_failed' and broken['pooledAccuracy'] is None
limited = run_python({'loop.py': b'while True: pass'}, {}, 'loop.py', [], 10, 2)
assert limited['exitCode'] != 0 and limited['cpuSeconds'] < 2.2
linked = run_python({'link.py': b"import os;os.symlink('/work/source/link.py','/work/scratch/leak')"}, {}, 'link.py', [], 10, 2)
assert linked['limit'] == 'invalid_outputs' and not linked['outputs']
large = run_python({'large.py': b"open('/work/scratch/large','w').write('x'*100)"}, {}, 'large.py', [], 10, 2, max_output_bytes=20)
assert large['limit'] == 'invalid_outputs' and not large['outputs']
waiting = run_python({'sleep.py': b'import time;time.sleep(10)'}, {}, 'sleep.py', [], .15, 2)
assert waiting['limit'] == 'wall_limit' and waiting['wallSeconds'] < 2
memory = run_python({'memory.py': b'bytearray(5*1024**3)'}, {}, 'memory.py', [], 10, 2)
assert memory['exitCode'] != 0 and 'MemoryError' in str(memory['logs'])
tabular = b'''import argparse,csv
p=argparse.ArgumentParser()
for k in ['train','predict','output','seed']: p.add_argument('--'+k)
a=p.parse_args();train=list(csv.DictReader(open(a.train)));query=list(csv.DictReader(open(a.predict)))
targets=[c for c in train[0] if c not in query[0]]
assert targets and not any(c in query[0] for c in targets)
with open(a.output,'w') as f:
 w=csv.writer(f);w.writerow(['row',*targets])
 for r in query:
  x=int(r['x']);w.writerow([r['row'],*([.9 if x%2 else .1] if targets==['label'] else [x/10,x/3])])
'''
for metric, targets in [('auc-roc',['label']),('mean-column-wise-rmsle',['energy','gap'])]:
    data = ('row,x,'+','.join(targets)+'\n'+''.join(f'{i},{i},'+(str(i%2) if len(targets)==1 else f'{i/10},{i/3}')+'\n' for i in range(20))).encode()
    prediction = {'kind':'tabular','metric':metric,'idColumn':'row','targetColumns':targets,'labels':['0','1'] if len(targets)==1 else []}
    plan = {'foldAssignments':[i%5 for i in range(20)],'trainDigest':'sha256:'+hashlib.sha256(data).hexdigest()}
    result = evaluate({**job,'outputDirectory':'/run/generic-oof'}, {'solution.py':tabular}, data, prediction, plan)
    assert result['status']=='completed' and len(result['foldMetrics'])==5, result
    assert result['pooledScore'] == (1 if len(targets)==1 else 0), result
    assert result['pooledUtility']==1 and len(json.loads(gzip.decompress(Path(result['oofPath']).read_bytes())))==20
    holdout = {'protocol': 'analysis-holdout-plan@1', 'seed': 42, 'metric': metric,
               'trainDigest': plan['trainDigest'], 'validationFraction': .2, 'assignments': [0]*16+[1]*4}
    result = evaluate({**job, 'outputDirectory': '/run/holdout-predictions'}, {'solution.py': tabular}, data, prediction, holdout)
    assert result['status'] == 'completed' and result['validationRows'] == 4, result
    assert result['validationScore'] == (1 if len(targets) == 1 else 0) and result['validationUtility'] == 1, result
    assert set(json.loads(gzip.decompress(Path(result['predictionsPath']).read_bytes()))) == {'16', '17', '18', '19'}
print(json.dumps({'isolation': 'passed', 'fiveFolds': 'passed', 'pooledAccuracy': r['pooledAccuracy'], 'candidateFailure': 'passed',
                  'aucAndMultiTargetRmsle':'passed','cpuLimit': 'passed', 'wallLimit': 'passed', 'memoryLimit': 'passed', 'unsafeOutputs': 'passed'}))
