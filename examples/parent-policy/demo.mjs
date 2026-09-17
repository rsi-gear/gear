import assert from 'node:assert/strict'
import { ComponentRegistry, parentSelectionInput } from 'rsi-gear/search/api'
import { FailureClusterSearch } from 'rsi-gear/search/presets/failure-cluster-gepa'
import { MemorySearchStore, createToySearch, createToySettings, checkParentSelectionPolicy } from 'rsi-gear/search/testing'
import { implementation, ref, uniformParentPolicy } from './uniform-parent.mjs'

const components = new ComponentRegistry()
components.registerParentSelectionPolicy(ref.id, implementation, uniformParentPolicy)
const settings = createToySettings()
settings.search.parentPolicy = ref
const fixture = createToySearch()
const journal = new MemorySearchStore()
const admission = { evolutionId: 'toy', roundId: 'toy-round', roundIndex: 0, maxCandidates: 2,
  anchor: fixture.anchor, championRevisionDigest: fixture.anchor.digest, settings }

// Simulate a crash after the parent decision is persisted, before it is consumed.
const write = journal.write.bind(journal)
let interrupted = false
/** @param {string} name @param {unknown} value */
journal.write = async (name, value) => {
  await write(name, value)
  if (!interrupted && name === 'rounds/toy-round/parents') { interrupted = true; throw new Error('example interruption') }
}
await assert.rejects(new FailureClusterSearch(journal, fixture.provider, fixture.diagnosis, fixture.hooks, components)
  .run(admission, new AbortController().signal), /example interruption/)

const resumed = new MemorySearchStore(journal.checkpoint())
const result = await new FailureClusterSearch(resumed, fixture.provider, fixture.diagnosis, fixture.hooks, components)
  .run(admission, new AbortController().signal)
assert.equal(result.research.parents.policy?.ref.id, ref.id)
assert.ok(result.research.workplans.length > 0)
const archive = await resumed.archive()
assert.ok(archive)
const check = checkParentSelectionPolicy(components.parentSelectionPolicy(ref), parentSelectionInput(archive, 'next-round', 2, 0, fixture.anchor.candidateId))
const calls = fixture.executions.length
const replay = await new FailureClusterSearch(resumed, fixture.provider, fixture.diagnosis, fixture.hooks, components)
  .run(admission, new AbortController().signal)
assert.equal(replay.digest, result.digest)
assert.equal(fixture.executions.length, calls)
console.log(JSON.stringify({ policy: ref.id, candidates: result.research.workplans.length, championChanged: result.championChanged,
  recovered: interrupted, replayedWithoutNewEvaluations: true, contractCheck: check }, null, 2))
