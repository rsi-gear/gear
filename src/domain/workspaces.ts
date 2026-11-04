import type { Operation, OperationResult } from './algorithm-wire.js'
import { GearError } from './errors.js'

export interface WorkspaceRef {
  id: string
  digest: string
  root_id: string
  parent_id: string | null
  base_candidate_id: string
  base_digest: string
}
export interface WorkspaceCommand {
  output_id?: string
  base_digest?: string
  source?: WorkspaceRef
}
export const workspaceKinds = [
  'workspace_open',
  'workspace_edit',
  'workspace_seal',
  'workspace_discard',
  'workspace_apply',
] as const
export const isWorkspace = (kind: string): boolean =>
  workspaceKinds.includes(kind as (typeof workspaceKinds)[number])
export const isLocalWorkspace = (kind: string): boolean => isWorkspace(kind) && kind !== 'workspace_edit'
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/u.test(value)
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
export function workspaceRef(value: unknown): WorkspaceRef {
  const ref = value as WorkspaceRef
  if (
    !ref ||
    !id(ref.id) ||
    !id(ref.root_id) ||
    !digest(ref.digest) ||
    !id(ref.base_candidate_id) ||
    !digest(ref.base_digest) ||
    !(ref.parent_id === null || id(ref.parent_id)) ||
    Object.keys(ref).sort().join(',') !== 'base_candidate_id,base_digest,digest,id,parent_id,root_id'
  )
    throw new GearError('invalid-workspace-ref', 'Expected a frozen workspace revision')
  return ref
}
export function workspaceCommand(operation: Operation): WorkspaceCommand {
  const payload = operation.payload as Record<string, unknown> | null
  const command = payload?.gear_workspace_v1 as WorkspaceCommand | undefined
  if (!isWorkspace(operation.kind) || !command || typeof command !== 'object' || Array.isArray(command))
    throw new GearError('invalid-workspace-operation', 'Workspace operations need a workspace command')
  const keys = Object.keys(command).sort().join(',')
  if (operation.kind === 'workspace_open') {
    if (keys !== 'base_digest,output_id' || !id(command.output_id) || !digest(command.base_digest))
      throw new GearError(
        'invalid-workspace-operation',
        'Opening a workspace requires a base and output revision',
      )
  } else {
    workspaceRef(command.source)
    if (
      keys !==
        (['workspace_edit', 'workspace_apply'].includes(operation.kind) ? 'output_id,source' : 'source') ||
      (['workspace_edit', 'workspace_apply'].includes(operation.kind) && !id(command.output_id))
    )
      throw new GearError('invalid-workspace-operation', 'Invalid workspace source or output revision')
  }
  return command
}
export function workspaceResult(result: OperationResult): WorkspaceRef | null {
  const data = result.data as Record<string, unknown> | null
  return result.status === 'complete' && isWorkspace(result.kind) && data?.workspace
    ? workspaceRef(data.workspace)
    : null
}
