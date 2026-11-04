/**
 * Verified objective identities from the last three bundled policy snapshots.
 * Their canonical/assertions/objective/projection/verifier Python sources and the
 * four TypeScript scoring contracts are byte-identical. Check that complete
 * closure plus the reviewed current dispatcher, adapter, canonical codec and
 * frozen transport again at runtime before accepting a historical identity.
 *
 * Source and emitted-JavaScript identities are both recorded: published builds
 * and source-based runs hash different wrapper bytes. The original 1f5c8e3
 * values were also checked against an unmodified historical tsc build.
 */
const scoringClosures = new Set([
  'sha256:865c0e30501df440948da7124bb7406b14b62cdaac36d6bdc0da1518ab26545f',
  'sha256:6370c1728b74fb5dcccc0cda013c7253318b2247db74b1e830f4592187a70020',
])
const identities = new Set([
  // 1f5c8e3f0f95516ee6bdbe1a0365b2451f2e0618; policy 41cae40c…
  'sha256:fe7af329610fa4b39dd0bf638457cf1c51df6807ae47c669af62c02f8a40b53c',
  'sha256:6b3ff878a989d346d7a6e73fdee94f4c36fb1866bc081efb11fd85c9a8a8c69e',
  // 17a656b1963f9e88fc6dc1174d122180107b1c68; policy e17f295b…
  'sha256:9b001008fc1ae74b093e1bbd7cb9316fa1b56b17cb96fb28e896ef9b310affa9',
  'sha256:66e6b25e4b3d20a6049d1ed4ddfe4634df85b441261eabbf5ed4d1bcc84f5315',
  // 7721b78e00d61becff3ff2801760ba87a9be5ff3; policy d6f41db8…
  'sha256:a3850c0623ddb1c0f63485f06dfa85fd1b0bba40472eacc826d5d352577d2819',
  'sha256:74d0ea4a701afb0df54dea75eea1de6c201de09601672bf0b11028ff99cd8a30',
])

export function historicalObjectiveCompatible(identity: string | undefined, closure: string): boolean {
  return identity !== undefined && scoringClosures.has(closure) && identities.has(identity)
}
