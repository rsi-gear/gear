#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { ComponentRegistry } from '../../lib/evolution/components.js';
import { registerElitistSelector } from './selection.mjs';
import { inspect } from '../automationbench-marketing/inspect.mjs';
import { fileURLToPath } from 'node:url';
const data = JSON.parse(await readFile(new URL('../../docs/guide/assets/marketing-results.json', import.meta.url), 'utf8'));
console.log('Historical record:');
console.table(data.stagedEvolution.map(r => ({ round: r.round, candidate: r.candidatePassed ?? 'not evaluated globally', champion: r.championPassed, decision: r.decision })));
console.log(await inspect(fileURLToPath(new URL('.', import.meta.url))));
// Synthetic fixture exercises the real ComponentRegistry without claiming a new
// benchmark run, Meta mutation, staged selection decision, or champion update.
const registry = new ComponentRegistry();
const ref = registerElitistSelector(registry);
const candidates = [36,40,34].map((passed,i) => ({ candidateId: `fixture-${i}`, sealedVersion: { treeOid: `fixture-tree-${i}` }, seedEvaluation: { conditionId: 'fixture-common-seed', completeness: 'complete', plannedTrialCount: 100, invalidTrials: [], summary: { total: 100, passed, failed: 100-passed, score: passed/100 } } }));
const decision = registry.selector(ref).select({ candidates, survivors: 2, assessment: { digest: 'fixture-assessment' } });
console.log('Synthetic component demonstration (no model calls; not historical evidence):');
console.log(JSON.stringify(decision,null,2));
