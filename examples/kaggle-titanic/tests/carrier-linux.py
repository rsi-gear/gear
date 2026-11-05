"""Real container canary: run as root in a fresh image with a Python chroot.

docker run --rm --user 0 -v .../kaggle-titanic:/example:ro IMAGE \
  python3 /example/tests/carrier-linux.py
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

EXAMPLE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runner', EXAMPLE / 'target-carrier/fixed/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def make_runtime():
    """Canary setup only. Production images ship this immutable runtime layer."""
    root = Path('/opt/kaggle-runtime')
    if root.exists():
        return
    (root / 'usr/bin').mkdir(parents=True)
    # Debian Python's full stdlib/runtime; omit unrelated /usr/local tools,
    # package manager caches, credentials, and any host filesystem mounts.
    for source in Path('/usr/bin').glob('python3*'):
        if source.is_symlink():
            (root / 'usr/bin' / source.name).symlink_to(os.readlink(source))
        elif source.is_file():
            shutil.copy2(source, root / 'usr/bin' / source.name)
    shutil.copytree('/usr/lib', root / 'usr/lib', symlinks=True)
    (root / 'lib').symlink_to('usr/lib')
    if Path('/lib64').exists():
        shutil.copytree('/lib64', root / 'lib64', symlinks=True)
    # Immutable copied runtime has no writable files from the source image.
    for path in root.rglob('*'):
        if not path.is_symlink():
            path.chmod(path.stat().st_mode & ~0o022)


make_runtime()
repository = Path(tempfile.mkdtemp(prefix='carrier-source-'))
data = Path('/data'); data.mkdir(exist_ok=True)
source = repository / 'harness/workflows/titanic'; source.mkdir(parents=True)
pipeline = r'''
import argparse, os, socket, pathlib, time
p=argparse.ArgumentParser()
for name in ('train','predict','output','seed'): p.add_argument('--'+name)
a=p.parse_args()
assert os.geteuid()==65532
assert 'CARRIER_SECRET' not in os.environ
for path in ('/outside-canary', '/output/receipt.json', '/proc/1/environ', '/work/source/pipeline.py'):
    try:
        with open(path,'w') as f: f.write('bypass')
    except (PermissionError,FileNotFoundError): pass
    else: raise AssertionError('write escaped: '+path)
try: socket.socket()
except PermissionError: pass
else: raise AssertionError('network escaped')
if os.fork()==0:
    os.setsid()
    time.sleep(1)
    pathlib.Path('/work/scratch/late-output').write_text('must not survive')
    os._exit(0)
pathlib.Path(a.output).write_text('PassengerId,Survived\n99,1\n')
'''
(source / 'pipeline.py').write_text(pipeline)
entry = {'path':'workflows/titanic/pipeline.py', 'digest':runner.digest(pipeline.encode()), 'bytes':len(pipeline.encode())}
(repository / 'harness/manifest.json').write_text(json.dumps({'artifacts':[entry]}))
(data / 'train.csv').write_text('PassengerId,Survived\n1,0\n2,1\n')
(data / 'predict.csv').write_text('PassengerId\n99\n')
task={'protocol':'kaggle-task@1','mode':'validation','task_id':'canary','seed':42,'timeout_sec':30,
      'input_digests':{name:runner.digest((data / filename).read_bytes()) for name,filename in [('train','train.csv'),('predict','predict.csv')]}}
task['task_digest']=runner.digest(runner.canonical(task))
(data / 'task.json').write_text(json.dumps(task))
artifact=repository / 'artifact.json'
artifact.write_text(json.dumps({'harness_id':'deepseek','source_type':'git','revision_identity':'sha256:'+'b'*64,
                               'resolved_revision':{'revision':{'type':'commit','commit':'a'*40}}}))
os.environ['CARRIER_SECRET']='must-not-leak'
Path('/outside-canary').write_text('unchanged')
receipt=runner.run(repository,artifact)
assert receipt['status']=='completed', receipt
assert receipt['candidate_commit']=='a'*40
assert Path('/output/predictions.csv').read_text()=='PassengerId,Survived\n99,1\n'
assert Path('/outside-canary').read_text()=='unchanged'
assert not runner.processes()
try: runner.run(repository,artifact)
except FileExistsError: pass
else: raise AssertionError('duplicate invocation accepted')

def replace_pipeline(code):
    (source / 'pipeline.py').write_text(code)
    item={'path':'workflows/titanic/pipeline.py','digest':runner.digest(code.encode()),'bytes':len(code.encode())}
    (repository / 'harness/manifest.json').write_text(json.dumps({'artifacts':[item]}))

replace_pipeline('raise RuntimeError("candidate failure")\n')
failed=runner.run(repository,artifact,output=Path('/output-failed'))
assert failed['status']=='candidate_failed' and failed['exit_code']==1
assert 'predictions_sha256' not in failed
assert 'RuntimeError: candidate failure' in failed['untrusted_diagnostics']['stderr']['text']
assert failed['untrusted_diagnostics']['stderr']['truncated'] is False
replace_pipeline('import sys\nsys.stderr.write("x"*10000+"diagnostic-tail\\n")\nraise RuntimeError("bounded failure")\n')
bounded=runner.run(repository,artifact,output=Path('/output-bounded'))
diagnostic=bounded['untrusted_diagnostics']['stderr']
assert diagnostic['truncated'] and len(diagnostic['text'].encode()) <= 4096
assert 'diagnostic-tail' in diagnostic['text'] and 'bounded failure' in diagnostic['text']
replace_pipeline('import os\nos.symlink("/work/source/pipeline.py", "/work/scratch/predictions.csv")\n')
invalid=runner.run(repository,artifact,output=Path('/output-invalid'))
assert invalid['status']=='candidate_failed' and invalid['error_code']=='invalid_prediction'
replace_pipeline('import time\ntime.sleep(60)\n')
task['timeout_sec']=.1
task['task_digest']=runner.digest(runner.canonical({key:value for key,value in task.items() if key!='task_digest'}))
(data / 'task.json').write_text(json.dumps(task))
timed=runner.run(repository,artifact,output=Path('/output-timeout'))
assert timed['status']=='candidate_failed' and timed['timed_out'] and timed['exit_code']==124
assert not runner.processes()
# A trusted boundary failure must produce infrastructure_error, never zero.
Path('/output').rename('/output-success')
Path('/opt/kaggle-runtime').chmod(0o777)
result=subprocess.run([sys.executable,'-B',str(EXAMPLE / 'target-carrier/fixed/runner.py'),
                       '--repository',str(repository),'--artifact',str(artifact)],capture_output=True)
assert result.returncode != 0
assert json.loads(Path('/output/receipt.json').read_text())['status']=='infrastructure_error'
assert not Path('/output/predictions.csv').exists()
print(json.dumps({'status':'passed','checks':['uid','source-write','receipt-write','host-files','environment','network','escaped-descendants','once-only','candidate-failure','bounded-diagnostics','output-symlink','timeout','infrastructure-fail-closed']}))
