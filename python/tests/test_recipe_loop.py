"""Merged native objectives through actual public factories and CPU actor doubles."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_recipes as recipe_fixtures
import test_dev_grpo as online_fixtures
from test_placement import Remote, Ref
from gear_training.content import ContractError, atomic_json
from gear_training.driver import run
from gear_training.ledger import Ledger
from gear_training.offline import generate_rollout as generate_sft
from gear_training.offline_sft import AssistantDatasetBuilder
from gear_training.recipes.registry import ESTIMATORS
from gear_training.rollout import generate_rollout as generate_online


class Sample:
    class Status: COMPLETED = 'completed'
    def __init__(self, **values): self.__dict__.update(values)


class Output:
    def __init__(self,samples,metrics): self.samples,self.metrics=samples,metrics


class SFTLoopTests(unittest.TestCase):
    def helper(self):
        fixture=recipe_fixtures.OfflineDriverTests(methodName='runTest')
        helper=fixture.helper(); self.addCleanup(fixture.doCleanups)
        source=helper.store.put_bytes(b'from gear_training.offline_sft import build_loop\n','application/octet-stream')
        helper.request['trainer']['script']={'entrypoint':'recipe:build_loop','sourceRef':helper.store.put_json({'schemaVersion':1,'kind':'training-script-source','files':[{'path':'recipe.py','contentRef':source}]})}
        self.preprocessed=[]; self.fixture=fixture
        def preprocess(update):
            helper.rt.event('offline-generate')
            replay=json.loads((helper.root/'offline-replay.json').read_text())
            builder=json.loads((helper.root/'four-stage-loop/rounds'/f'{update:06d}'/'dataset-builder/result.json').read_text())
            self.assertEqual(replay['batchRef'],builder['output']['batchRef'])
            with patch.dict(sys.modules,{'slime.utils.types':SimpleNamespace(Sample=Sample),'slime.rollout.base_types':SimpleNamespace(RolloutFnTrainOutput=Output)}), patch.dict(os.environ,{'GEAR_TRAINING_JOB':str(helper.root)}):
                output=generate_sft(helper.args,update,None)
            sample=output.samples[0][0]
            self.assertEqual(sample.tokens[:2],[1,2]); self.assertEqual(sample.loss_mask,[1,1,0,0,1])
            self.assertFalse(hasattr(sample,'rollout_log_probs'))
            data={'backend':object(),'samples':output.samples}; self.preprocessed.append(data)
            return data
        helper.rt.manager.generate=Remote(preprocess)
        def train(update,data):
            self.assertIs(data,self.preprocessed[-1]); helper.rt.train()
        helper.rt.actor.async_train=lambda update,data:Ref(lambda:train(update,data))
        return helper
    def result(self,helper,round_index,stage):
        return json.loads((helper.root/'four-stage-loop/rounds'/f'{round_index:06d}'/stage/'result.json').read_text())['output']
    def assert_actor_only(self,helper):
        self.fixture.assert_offline(helper)
        self.assertEqual(helper.rt.events.count('train'),helper.request['trainer']['updatesPerCandidate'])
        loop=json.loads((helper.root/'four-stage-loop/result.json').read_text())
        self.assertEqual(loop['roundsCompleted'],helper.request['trainer']['updatesPerCandidate'])
        ledger=Ledger(helper.root/'ledger.sqlite')
        try:
            for row in ledger.db.execute('SELECT ref FROM commits'):
                commit=helper.store.read_json(json.loads(row['ref']))
                cursor=helper.store.read_json(commit['dataCursorRef'])
                self.assertEqual(cursor['position'],commit['committedUpdate']*helper.request['trainer']['rolloutBatchSize'])
        finally: ledger.close()
    def test_actual_four_stages_project_masked_supervision_without_generation(self):
        helper=self.helper(); helper.run_driver(); self.assert_actor_only(helper)
        self.assertEqual(len(self.preprocessed),2)
        self.assertEqual(self.result(helper,0,'model-updater')['committedUpdate'],1)
        before=helper.rt.events[:]; helper.run_driver(); self.assertEqual(helper.rt.events,before)
    def test_read_complete_and_builder_seal_reply_gaps_recover_cached_prefix(self):
        for seal_first in (False,True):
            with self.subTest(seal_first=seal_first):
                helper=self.helper(); helper.request['trainer']['updatesPerCandidate']=1
                original=AssistantDatasetBuilder.build
                def interrupted(stage,ctx,raw):
                    if seal_first: original(stage,ctx,raw)
                    raise RuntimeError('builder reply gap')
                with patch.object(AssistantDatasetBuilder,'build',interrupted), self.assertRaisesRegex(RuntimeError,'builder reply gap'): helper.run_driver()
                raw=helper.root/'four-stage-loop/rounds/000000/rollout-executor/result.json'
                before=raw.stat().st_mtime_ns
                self.assertEqual(helper.rt.events.count('train'),0)
                helper.run_driver(); self.assertEqual(raw.stat().st_mtime_ns,before)
                self.assert_actor_only(helper); self.assertEqual(len(self.preprocessed),1)
    def test_native_commit_leading_framework_result_reconciles_without_cuda(self):
        helper=self.helper(); helper.request['trainer']['updatesPerCandidate']=1; helper.fail_commit_reply=True
        with self.assertRaisesRegex(OSError,'commit response lost'): helper.run_driver()
        self.assertFalse((helper.root/'four-stage-loop/rounds/000000/model-updater/result.json').exists())
        before=helper.rt.events[:]
        with patch('gear_training.gpu_visibility.verify_visible_devices',side_effect=AssertionError('no CUDA recovery')): helper.run_driver()
        self.assertEqual(helper.rt.events,before); self.assert_actor_only(helper)
    def test_pending_export_recovery_never_repeats_supervised_gradient(self):
        helper=self.helper(); helper.request['trainer']['updatesPerCandidate']=1
        original=helper.commit
        helper.commit=lambda *a,**kw:(_ for _ in ()).throw(OSError('export publication interrupted'))
        with self.assertRaisesRegex(OSError,'interrupted'): helper.run_driver()
        self.assertTrue((helper.root/'pending-update.json').exists())
        helper.commit=original; helper.run_driver()
        self.assert_actor_only(helper); self.assertEqual(len(self.preprocessed),1)
        self.assertIn('exporter-released',helper.created_components)
    def test_pause_and_dataset_drift_rejected_before_any_extra_training(self):
        helper=self.helper(); original=helper.commit
        def pause(*a,**kw):
            value=original(*a,**kw); atomic_json(helper.root/'cancel.json',{'pause':True}); return value
        helper.commit=pause; helper.run_driver()
        self.assertEqual(helper.rt.events.count('train'),1)
        self.assertTrue((helper.root/'four-stage-loop/rounds/000000/model-updater/result.json').exists())
        (helper.root/'cancel.json').unlink(); helper.commit=original; helper.run_driver(); self.assert_actor_only(helper)
        dataset=helper.store.read_json(helper.request['offlineTraining']['datasetRef'])
        dataset['records'].reverse(); helper.request['offlineTraining']['datasetRef']=helper.store.put_json(dataset)
        with self.assertRaises(ContractError): helper.run_driver()
        self.assertEqual(helper.rt.events.count('train'),2)
    def test_offline_agent_stage_override_is_rejected_before_cuda(self):
        helper=self.helper(); helper.request['stages']={'taskSource':{'kind':'agent'}}
        with patch('gear_training.gpu_visibility.verify_visible_devices',side_effect=AssertionError('no CUDA')),             self.assertRaisesRegex(ContractError,'not agent stage overrides'): helper.run_driver()


class OnlineRecipeLoopTests(unittest.TestCase):
    def test_all_online_objectives_use_actual_capture_builder_and_native_replay(self):
        for recipe,estimator in ESTIMATORS.items():
            if recipe=='offline-sft-v1': continue
            with self.subTest(recipe=recipe):
                helper=online_fixtures.DevGRPOTests(methodName='runTest'); helper.setUp(); self.addCleanup(helper.doCleanups)
                request,args=helper.d.request,helper.d.args
                request['trainer'].update(recipe=recipe,updatesPerCandidate=1)
                group_size=1 if estimator=='reinforce_plus_plus' else 2
                request['rollout']['groupSize']=group_size; request['trainer']['globalBatchSize']=group_size
                args.advantage_estimator=estimator; args.n_samples_per_prompt=args.global_batch_size=group_size
                args.loss_type='policy_loss'; args.normalize_advantages=True
                args.rewards_normalization=estimator!='reinforce_plus_plus'; args.grpo_std_normalization=estimator!='reinforce_plus_plus_baseline'
                projected=[]
                def preprocess(update):
                    output=generate_online(args,update,None)
                    samples=[sample for group in output.samples for sample in group]
                    self.assertEqual(len(samples),group_size)
                    self.assertEqual([s.reward for s in samples],list(range(group_size)))
                    self.assertTrue(all(s.tokens==[1,2,3,4,90,91,5] and s.loss_mask==[1,1,0,0,1] for s in samples))
                    data={'native':object(),'samples':samples}; projected.append(data); return data
                def train(update,data):
                    self.assertIs(data,projected[-1]); helper.d.rt.train()
                helper.d.rt.manager.generate=Remote(preprocess)
                helper.d.rt.actor.async_train=lambda update,data:Ref(lambda:train(update,data))
                with helper.cpu_runtime(): run(helper.d.root)
                self.assertEqual(helper.stage('model-updater')['committedUpdate'],1)
                self.assertEqual(len(helper.native_calls),group_size*2)
                self.assertEqual(len(projected),1)
                batch=helper.d.store.read_json(helper.stage('dataset-builder')['batchRef'])
                self.assertEqual(helper.d.store.read_json(batch['samplesRef'])[0][0]['reward'],0)


if __name__=='__main__': unittest.main()
