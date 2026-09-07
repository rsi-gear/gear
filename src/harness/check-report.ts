export type CheckStatus = 'passed' | 'failed' | 'not_checked'

export interface CheckStage {
  status: CheckStatus
  code?: string
  message?: string
  checked?: number
  expected?: number
}

export interface RuntimeCheckReport {
  schemaVersion: 1
  candidateDigest: string
  activeStage?: 'load' | 'promptAssembly' | 'skillDiscovery' | 'skillRead' | 'cleanup'
  load: CheckStage
  /** Optional on older gear-runtime-check-v1 executables; absence is never passed coverage. */
  promptAssembly?: CheckStage
  skillDiscovery: CheckStage
  skillRead: CheckStage
  cleanup: CheckStage
  identity?: { name: string; version: string; lockDigest: string }
  skills?: Array<{ name: string; path: string; provider: string; contentDigest: string; read: CheckStatus }>
}

export interface CompilerCheckReport {
  ok: boolean
  status: CheckStatus
  code?: string
  message?: string
  runtime: RuntimeCheckReport
}

export interface CandidateCheckReport {
  ok: boolean
  okScope: 'configured_checks'
  static: CheckStage
  compiler: Omit<CompilerCheckReport, 'runtime'>
  runtime: RuntimeCheckReport
}

export function uncheckedRuntime(candidateDigest = '', code = 'RUNTIME_VALIDATION_UNAVAILABLE'): RuntimeCheckReport {
  return {
    schemaVersion: 1, candidateDigest,
    load: { status: 'not_checked', code },
    promptAssembly: { status: 'not_checked', code },
    skillDiscovery: { status: 'not_checked', code },
    skillRead: { status: 'not_checked', code },
    cleanup: { status: 'not_checked', code },
  }
}

export function candidateCheckReport(compiler?: CompilerCheckReport, candidateDigest = ''): CandidateCheckReport {
  const { runtime, ...result } = compiler ?? { ok: true, status: 'passed', runtime: uncheckedRuntime(candidateDigest) }
  return { ok: result.ok, okScope: 'configured_checks', static: { status: 'passed' }, compiler: result, runtime }
}

export class CompilerCheckError extends Error {
  constructor(readonly report: CompilerCheckReport) {
    super(report.message ?? Object.values(report.runtime).find(
      value => typeof value === 'object' && value !== null && 'status' in value && value.status === 'failed',
    )?.message ?? 'harness compiler check failed')
    this.name = 'CompilerCheckError'
  }
}

/** Treat even the fixed checker's wire output as data; never infer coverage from an exit code. */
export function parseRuntimeReport(text: string, candidateDigest: string): RuntimeCheckReport {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) throw new Error('runtime report must be an object')
  const report = value as RuntimeCheckReport
  if (report.schemaVersion !== 1 || report.candidateDigest !== candidateDigest) throw new Error('runtime report identity mismatch')
  if (report.activeStage !== undefined && !['load', 'promptAssembly', 'skillDiscovery', 'skillRead', 'cleanup'].includes(report.activeStage)) throw new Error('invalid active runtime stage')
  if (report.promptAssembly === undefined) report.promptAssembly = { status: 'not_checked', code: 'PROMPT_ASSEMBLY_NOT_REPORTED' }
  for (const key of ['load', 'promptAssembly', 'skillDiscovery', 'skillRead', 'cleanup'] as const) {
    const stage = report[key]
    if (stage === undefined || !['passed', 'failed', 'not_checked'].includes(stage.status)) throw new Error(`invalid runtime stage: ${key}`)
    for (const field of ['message', 'code'] as const) if (stage[field] !== undefined
      && (typeof stage[field] !== 'string' || stage[field].length > 4000)) throw new Error(`invalid ${key}.${field}`)
    for (const field of ['checked', 'expected'] as const) if (stage[field] !== undefined
      && (!Number.isSafeInteger(stage[field]) || stage[field]! < 0)) throw new Error(`invalid ${key}.${field}`)
  }
  if (report.identity !== undefined && (typeof report.identity.name !== 'string' || !report.identity.name || report.identity.name.length > 200
    || typeof report.identity.version !== 'string' || !report.identity.version || report.identity.version.length > 100
    || !/^sha256:[a-f0-9]{64}$/u.test(report.identity.lockDigest))) {
    throw new Error('invalid runtime identity')
  }
  if (report.skills !== undefined && (!Array.isArray(report.skills) || report.skills.length > 1024
    || report.skills.some(skill => typeof skill.name !== 'string' || typeof skill.path !== 'string'
      || typeof skill.provider !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(skill.contentDigest)
      || !['passed', 'failed', 'not_checked'].includes(skill.read)))) throw new Error('invalid Skill report')
  if (report.load.status === 'passed' && report.identity === undefined) throw new Error('loaded runtime must report its identity')
  for (const stage of [report.skillDiscovery, report.skillRead]) if (stage.status === 'passed'
    && (stage.expected === undefined || stage.expected === 0 || stage.checked !== stage.expected)) {
    throw new Error('successful Skill checks must report nonzero matching expected/checked counts')
  }
  if (report.skillRead.status === 'passed' && report.skills?.filter(skill => skill.read === 'passed').length !== report.skillRead.checked) {
    throw new Error('successful Skill reads require matching per-resource evidence')
  }
  return report
}
