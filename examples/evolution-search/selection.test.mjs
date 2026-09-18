import assert from 'node:assert/strict';
import test from 'node:test';
import { ComponentRegistry } from '../../lib/evolution/components.js';
import { registerElitistSelector } from './selection.mjs';
function setup() { const r = new ComponentRegistry(); return r.selector(registerElitistSelector(r)); }
function c(id,passed,condition='seed',tree=id) { return { candidateId:id,sealedVersion:{treeOid:tree},seedEvaluation:{conditionId:condition,completeness:'complete',plannedTrialCount:100,invalidTrials:[],summary:{total:100,passed,failed:100-passed,score:passed/100}} }; }
function request(candidates,survivors=1) { return {candidates,survivors,assessment:{digest:'assessment'}}; }
test('selects elites independently of input order, with deterministic ties and duplicate trees',()=>{
 const result=setup().select(request([c('z',40),c('b',36),c('a',40),c('duplicate',39,'seed','a')],2));
 assert.deepEqual(result.selectedCandidateIds,['a','z']);assert.equal(result.promotionCandidateId,'a');assert.equal(result.assessmentDigest,'assessment');
});
test('rejects incomparable or incomplete evaluations and insufficient diversity',()=>{
 assert.throws(()=>setup().select(request([c('a',40),c('b',50,'other')])));
 const invalid=c('a',40);invalid.seedEvaluation.completeness='partial';assert.throws(()=>setup().select(request([invalid])));
 const repaired=c('a',40);repaired.seedEvaluation.invalidTrials=[{trialId:'invalid'}];assert.throws(()=>setup().select(request([repaired])));
 const short=c('a',40);short.seedEvaluation.plannedTrialCount=101;assert.throws(()=>setup().select(request([short])));
 assert.throws(()=>setup().select(request([c('a',40,'seed','same'),c('b',39,'seed','same')],2)));
});
