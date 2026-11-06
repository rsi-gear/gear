/** V2 identities are independent of DSH's historical v1 manifest. */
export interface TargetResource {
  path: string
  digest: string
  executable: boolean
}
export interface TargetManifest {
  version: 2
  adapterRef: { id: string; version: string }
  runtimeIdentity: string
  baseRef: string
  mutationPolicyDigest: string
  resources: TargetResource[]
  digest: string
}
