import { createHash } from 'node:crypto'
const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Current Hitch verifier-evidence v1, with independent process and primary scores. */
export function verifierFixture(trial, evalId) {
  const process = { schema_version: '1', metric: 'process_quality', score: 0.5, detail_status: 'components', passed: 1, total: 2, excluded: 0,
    components: [{ id: 'read-evidence', category: 'workflow', status: 'passed', weight: 1 },
      { id: 'verify-change', category: 'workflow', status: 'failed', weight: 1, code: 'missing-check', public_details: { checks: 0 }, private_details_ref: 'private/PRIVATE_VERIFIER_REFERENCE' }] }
  const feedback = { schema_version: '1', items: [{ code: 'missing-check', severity: 'error', message: 'Check the recorded evidence before changing the answer.', component_ids: ['verify-change'] }] }
  const result = { rewards: { reward: trial.reward, total_score: trial.reward, process_score: 0.5 }, private: 'PRIVATE_VERIFIER_RESULT' }
  return { schema_version: '1', kind: 'verifier-evidence', run_id: trial.run_id,
    parent: { eval_id: evalId, trial_id: trial.trial_id, attempt: trial.attempt },
    observation: { status: trial.observation_status, reward: trial.reward, verifier_result_ref: trial.verifier_result_ref },
    verifier: { status: 'result_only', result, result_sha256: hash(result), scores: { normalization: 'standard', total_score: trial.reward, process_score: 0.5 },
      process, feedback, structured_artifacts: Object.fromEntries(Object.entries({ process, feedback }).map(([name, value]) => [name, { ref: 'verifier/' + name + '.json', sha256: hash(value), bytes: Buffer.byteLength(JSON.stringify(value)) }])) } }
}
