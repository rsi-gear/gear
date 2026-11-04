import { builtinPolicyImplementationDigest } from './builtin-policy.js'

// These three immutable readers have the same experience/trajectory algorithms.
// After path-only import relocation, the reviewed current source snapshot must
// still match exactly before it may read their frozen snapshots or cursors.
const reviewedReaderSnapshot = 'sha256:66edad0204c6c55f73baeb97d8d745a3993c49076d815e8d472a4936a6bce3ce'
const historicalReaderSnapshots = new Set([
  'sha256:41cae40c53d91a5263e1e0cdef7393360d242bfd32cfdeb2f550c811633bb43b',
  'sha256:e17f295b0ca090b1206d3f3bfb02f91eab04c95be3f8d78cddc31a63ba0a2e8f',
  'sha256:d6f41db8207b3e3210c3c5e13b3810f5bc8f4c54162b8a7e3a0066138efe6d18',
])

export function policyReaderCompatible(identity: string): boolean {
  return (
    identity === builtinPolicyImplementationDigest ||
    (builtinPolicyImplementationDigest === reviewedReaderSnapshot && historicalReaderSnapshots.has(identity))
  )
}
