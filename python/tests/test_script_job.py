"""Frozen ordinary four-stage code through the real subprocess worker."""
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from gear_training.content import ContentStore, ContractError, digest_json
from gear_training.loop import _write, TrainingLoop, TrainingConfig
from gear_training.script_job import ScriptService, ScriptRuntime, worker_run
from gear_training.script_source import loaded_loop

CODE = """
import asyncio
import json
import subprocess
import sys
from pathlib import Path
from gear_training import TrainingLoop
class Q:
    def __init__(self, runtime): self.r=runtime
    def generate(self, ctx):
        with (self.r.workspace/'calls').open('a') as f: f.write('Q\\n')
        return [1,2,3]
class R:
    async def execute(self, ctx, tasks):
        await asyncio.sleep(0)
        return [{'x':x,'y':3*x,'prediction':ctx.checkpoint['weight']*x} for x in tasks]
class D:
    def __init__(self, runtime, config): self.r,self.c=runtime,config
    def build(self, ctx, trajectories):
        if self.c['parameters'].get('fail_once') and not (self.r.workspace/'failed').exists():
            (self.r.workspace/'failed').write_text('1')
            raise RuntimeError('one deliberate failure')
        return trajectories
class U:
    def __init__(self, runtime, config): self.r,self.c=runtime,config
    def update(self, ctx, dataset):
        with (self.r.workspace/'calls').open('a') as f: f.write('U\\n')
        if self.c['parameters'].get('pause') and not (self.r.workspace/'paused-once').exists():
            (self.r.workspace/'paused-once').write_text('1')
            (self.r.workspace/'cancel.json').write_text('{}')
        if self.c['parameters'].get('child'):
            child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(1)'])
            (self.r.workspace/'child.pid').write_text(str(child.pid))
        weight=ctx.checkpoint['weight']
        gradient=sum((weight*x['x']-x['y'])*x['x'] for x in dataset)/sum(x['x']**2 for x in dataset)
        return {'weight':weight-0.5*gradient}
def build_loop(config,runtime):
    return TrainingLoop(Q(runtime),R(),D(runtime,config),U(runtime,config))
"""

class ScriptJobTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.store=ContentStore(self.root/'cas')
        self.service=ScriptService({'nodeRoot':str(self.root/'node'),'storeRoot':str(self.store.root)})
        self.ref=self.store.put_bytes(CODE.encode(), 'application/octet-stream')
        manifest=self.store.put_json({'schemaVersion':1,'kind':'training-script-source','files':[{'path':'recipe.py','contentRef':self.ref}]})
        self.request={'schemaVersion':1,'script':{'entrypoint':'recipe:build_loop','sourceRef':manifest},
                      'config':{'rounds':3,'initialCheckpoint':{'weight':0},'parameters':{}}}
        self.key='cpu-script'
    def control(self, action='start', seq=0, request=None):
        return self.service.control({'request':request or self.request,'idempotencyKey':self.key,'intent':{'sequence':seq,'action':action}})
    def wait(self, handle, terminal=True):
        deadline=time.monotonic()+12
        while time.monotonic()<deadline:
            status=self.service.inspect({'handle':handle})
            if status['execution'] not in ('running','pausing') and (status['resourcesReleased'] or not terminal): return status
            time.sleep(.02)
        self.fail('worker failed to terminate: '+repr(status))
    def test_real_cpu_script_no_native_commits_and_completed_replay(self):
        status=self.wait(self.control()['handle']); self.assertEqual(status['execution'],'completed')
        self.assertEqual(status['result']['checkpoint'], {'weight':2.625})
        directory=self.service.directory(status['handle'])
        self.assertFalse((directory/'ledger.sqlite').exists())
        before={p:p.stat().st_mtime_ns for p in (directory/'loop').rglob('result.json')}
        again=self.control(); self.assertEqual(again['result'],status['result'])
        self.assertEqual(before,{p:p.stat().st_mtime_ns for p in before})
    def test_partial_failure_resumes_from_successful_prefix_with_frozen_code(self):
        self.request['config']['parameters']['fail_once']=True
        status=self.wait(self.control()['handle']); self.assertEqual(status['execution'],'failed')
        directory=self.service.directory(status['handle'])
        (directory/'source/recipe.py').write_text('raise RuntimeError("mutable code must never run")')
        status=self.wait(self.control(seq=1)['handle']); self.assertEqual(status['execution'],'completed')
        self.assertEqual((directory/'calls').read_text().splitlines().count('Q'),3)
    def test_pause_preserves_successful_updater_and_explicit_resume(self):
        self.request['config']['parameters']['pause']=True
        status=self.wait(self.control()['handle']); self.assertEqual(status['execution'],'paused')
        directory=self.service.directory(status['handle'])
        self.assertTrue((directory/'loop/rounds/000000/model-updater/result.json').exists())
        self.assertEqual(self.control()['execution'],'paused')
        status=self.wait(self.control(seq=1)['handle']); self.assertEqual(status['execution'],'completed')
        self.assertEqual((directory/'calls').read_text().splitlines().count('U'),3)
    def test_ordered_prelaunch_pause_and_config_identity_drift(self):
        status=self.control('pause',1); self.assertEqual(status['execution'],'paused')
        with self.assertRaisesRegex(ContractError,'newer intent'): self.control(seq=0)
        changed=json.loads(json.dumps(self.request)); changed['config']['rounds']=4
        with self.assertRaisesRegex(ContractError,'another frozen'): self.control(seq=2,request=changed)
        status=self.wait(self.control(seq=2)['handle']); self.assertEqual(status['execution'],'completed')
    def test_child_session_blocks_resume_until_resources_exit(self):
        self.request['config']['rounds']=1; self.request['config']['parameters']['child']=True
        status=self.wait(self.control()['handle'],terminal=False)
        self.assertEqual(status['execution'],'completed'); self.assertFalse(status['resourcesReleased'])
        with self.assertRaisesRegex(ContractError,'worker must exit'): self.control(seq=1)
        self.assertTrue(self.wait(status['handle'])['resourcesReleased'])
    def test_session_observation_skips_unrelated_denied_processes(self):
        import psutil
        from gear_training.recovery import owned_session_alive
        from types import SimpleNamespace
        identity={'pid':4444,'createdAt':10}
        unrelated=SimpleNamespace(pid=5555,create_time=lambda: self.fail('unrelated process must not be inspected'))
        member=SimpleNamespace(pid=6666,create_time=lambda:11,status=lambda:'running')
        with patch('psutil.Process',side_effect=psutil.NoSuchProcess(4444)), patch('psutil.process_iter',return_value=[unrelated,member]), patch('os.getsid',side_effect=[5555,4444]):
            self.assertTrue(owned_session_alive(identity))
        inaccessible=SimpleNamespace(pid=6666,create_time=lambda: (_ for _ in ()).throw(psutil.AccessDenied(6666)))
        with patch('psutil.Process',side_effect=psutil.NoSuchProcess(4444)), patch('psutil.process_iter',return_value=[inaccessible]), patch('os.getsid',return_value=4444):
            with self.assertRaisesRegex(ContractError,'owned session'): owned_session_alive(identity)
        reused=SimpleNamespace(create_time=lambda:99)
        with patch('psutil.Process',return_value=reused): self.assertFalse(owned_session_alive(identity))
    def test_loader_rejects_corrupt_bytes_unsafe_path_wrong_factory(self):
        self.store.path(self.ref['digest']).write_bytes(b'altered')
        runtime=ScriptRuntime(self.root,self.store)
        with self.assertRaisesRegex(ContractError,'content changed'):
            with loaded_loop(self.store,self.request['script'],self.request['config'],runtime,self.root/'source'): pass
        ref=self.store.put_bytes(b'def build_loop(config,runtime): return None', 'application/octet-stream')
        for path, error in (('../recipe.py','unsafe'),('recipe.py','must return TrainingLoop')):
            recipe={'entrypoint':'recipe:build_loop','sourceRef':self.store.put_json({'schemaVersion':1,'kind':'training-script-source','files':[{'path':path,'contentRef':ref}]})}
            with self.assertRaisesRegex(ContractError,error):
                with loaded_loop(self.store,recipe,self.request['config'],runtime,self.root/'source'): pass
    def test_unavailable_native_capability_is_explicit(self):
        runtime=ScriptRuntime(self.root,self.store)
        with self.assertRaisesRegex(ContractError,'native training runtime'): runtime.slime
    def test_pause_before_worker_registration_never_invokes_factory(self):
        from gear_training.recovery import process_identity
        status=self.control('pause',1); directory=self.service.directory(status['handle'])
        _write(directory/'service.json', self.service.config)
        _write(directory/'worker.json', {'token':'launch','sequence':0,'process':process_identity(os.getpid())})
        with self.assertRaisesRegex(ContractError,'superseded before registration'): worker_run(directory,'launch')
        self.assertFalse((directory/'calls').exists())
    def test_same_workspace_rejects_changed_source_identity(self):
        runtime=ScriptRuntime(self.root,self.store)
        config=TrainingConfig(self.root/'loop',1,{'weight':0},{})
        with loaded_loop(self.store,self.request['script'],self.request['config'],runtime,self.root/'source') as loop: loop.run(config)
        changed=self.store.put_bytes((CODE+'\n# new revision\n').encode(),'application/octet-stream')
        recipe={'entrypoint':'recipe:build_loop','sourceRef':self.store.put_json({'schemaVersion':1,'kind':'training-script-source','files':[{'path':'recipe.py','contentRef':changed}]})}
        with loaded_loop(self.store,recipe,self.request['config'],runtime,self.root/'source') as loop:
            with self.assertRaisesRegex(ContractError,'another configuration'): loop.run(config)
    def test_node_scripts_rpc_requires_no_native_job_config(self):
        from gear_training.node import NodeService
        config={'schemaVersion':2,'nodeId':'cpu-script','nodeRoot':str(self.root/'rpc-node'),'storeRoot':str(self.store.root)}
        with patch('gear_training.node.boot_identity', return_value='test-boot'):
            node=NodeService(config)
        payload={'request':self.request,'idempotencyKey':'node-rpc','intent':{'sequence':0,'action':'start'}}
        envelope={'schemaVersion':2,'requestId':'script-rpc','node':node.identity,'operation':'scripts.control','inputDigest':digest_json(payload),'payload':payload}
        response=node.rpc(envelope)
        handle=response['result']['handle']
        status=self.wait_node(node,handle)
        self.assertEqual(status['execution'],'completed')
    def wait_node(self,node,handle):
        deadline=time.monotonic()+12
        while time.monotonic()<deadline:
            payload={'handle':handle}
            response=node.rpc({'schemaVersion':2,'requestId':'script-inspect','node':node.identity,'operation':'scripts.inspect','inputDigest':digest_json(payload),'payload':payload})
            status=response['result']
            if status['execution']=='completed' and status['resourcesReleased']: return status
            time.sleep(.02)
        self.fail(repr(status))
    def test_frozen_helper_supersedes_preloaded_external_module_and_restores_it(self):
        import sys
        from types import ModuleType
        helper=ModuleType('helper'); helper.value=999
        recipe=self.store.put_bytes(('from helper import value\n'+CODE.replace('return [1,2,3]', 'return [value]')).encode(),'application/octet-stream')
        helper_ref=self.store.put_bytes(b'value=7\n','application/octet-stream')
        script={'entrypoint':'recipe:build_loop','sourceRef':self.store.put_json({'schemaVersion':1,'kind':'training-script-source','files':[{'path':'recipe.py','contentRef':recipe},{'path':'helper.py','contentRef':helper_ref}]})}
        with patch.dict(sys.modules,{'helper':helper}):
            with loaded_loop(self.store,script,self.request['config'],ScriptRuntime(self.root,self.store),self.root/'source') as loop:
                result=loop.run(TrainingConfig(self.root/'loop',1,{'weight':0},{}))
                self.assertEqual(result.history[0]['tasks'],[7])
            self.assertIs(sys.modules['helper'],helper)
    def test_unicode_checkpoint_survives_real_node_rpc_and_cas(self):
        from gear_training.node import NodeService
        code=CODE.replace("return {'weight':weight-0.5*gradient}", "return {'权重':weight-0.5*gradient}")
        ref=self.store.put_bytes(code.encode(),'application/octet-stream')
        self.request['script']['sourceRef']=self.store.put_json({'schemaVersion':1,'kind':'training-script-source','files':[{'path':'recipe.py','contentRef':ref}]})
        self.request['config']['rounds']=1
        with patch('gear_training.node.boot_identity',return_value='test-boot'):
            node=NodeService({'schemaVersion':2,'nodeId':'unicode-script','nodeRoot':str(self.root/'rpc-node'),'storeRoot':str(self.store.root)})
        payload={'request':self.request,'idempotencyKey':'unicode-rpc','intent':{'sequence':0,'action':'start'}}
        response=node.rpc({'schemaVersion':2,'requestId':'unicode-start','node':node.identity,'operation':'scripts.control','inputDigest':digest_json(payload),'payload':payload})
        status=self.wait_node(node,response['result']['handle'])
        self.assertEqual(status['result']['checkpoint'],{'权重':1.5})
        self.assertEqual(self.store.read_json(status['resultRef']),status['result'])
        self.assertIn('权重', json.dumps(status,ensure_ascii=False))
    def test_result_cas_corruption_is_rejected(self):
        status=self.wait(self.control()['handle'])
        self.store.path(status['resultRef']['digest']).write_bytes(b'{}')
        with self.assertRaisesRegex(ContractError,'content changed'): self.service.inspect({'handle':status['handle']})

if __name__=='__main__': unittest.main()
