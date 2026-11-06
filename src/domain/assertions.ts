/** Independent verifier assertions; excluded is a declared result, not missing evidence. */
export interface AssertionDefinition {
  id: string
  revision: string
  source: { path: string; extractor: 'boolean-v1' | 'assertion-status-v1' }
}
export interface AssertionContract extends AssertionDefinition {
  schemaVersion: 1
  digest: string
}
export interface ProtectedAssertion {
  task_id: string
  partition: 'seed' | 'held_out'
  assertion_id: string
  rule: 'must_pass' | 'no_new_violation'
}
