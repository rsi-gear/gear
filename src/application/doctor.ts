import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { acquireAirGappedSandbox, type LinuxSandboxIsolation } from '../sandbox.js'
import { codexAuthFile } from '../adapters/codex/auth.js'
import { describeCodex } from '../adapters/codex/identity.js'
import { capabilities as codexCapabilities, codexCredentialEnvNames } from '../adapters/codex/contracts.js'
import { ProcessOperationProvider } from '../adapters/process/operation-provider.js'
import { inspectHitchConnection, hitchCapabilities } from '../adapters/hitch/connection.js'
import { hitchJson } from '../adapters/hitch/transport.js'
import { GearError } from '../domain/errors.js'
import { harnessAdapter } from './harness-adapters.js'
import {
  assertProfileRole,
  defaultProfiles,
  listProfiles,
  profile,
  type ProfileRole,
} from './profile-store.js'
import { resolveProject } from './project-config.js'
import { pythonExecutable, pythonSourceRoot } from './python.js'
import { runtimeMatrix, supportedNode } from './runtime-matrix.js'

const execute = promisify(execFile)
interface Check {
  component: string
  status: 'passed' | 'failed' | 'not_checked'
  detail: string
  next_action?: string
  data?: unknown
}
/** Local prerequisites only: never submits a model request or benchmark trial. */
export async function doctor(root: string) {
  root = resolve(root)
  const checks: Check[] = []
  const probe = async (component: string, next_action: string, run: () => Promise<unknown>) => {
    try {
      const data = await run()
      checks.push({
        component,
        status: 'passed',
        detail: 'Local check passed',
        ...(data === undefined ? {} : { data }),
      })
    } catch (error) {
      checks.push({
        component,
        status: 'failed',
        detail: error instanceof GearError ? error.code : 'Check did not complete',
        next_action:
          error instanceof GearError && error.details.next_action ? error.details.next_action : next_action,
      })
    }
  }
  checks.push({
    component: 'node',
    status: supportedNode(process.version) ? 'passed' : 'failed',
    detail: `${process.version}; required ${runtimeMatrix.node}`,
  })
  await probe('python', 'gear setup', async () => {
    const executable = await pythonExecutable()
    const { stdout } = await execute(
      executable,
      [
        '-c',
        'import json,sys,gear,psutil,tomli_w;import gear.benchmark.native;from gear.algorithms import GEPA;assert sys.version_info >= (3,10);print(json.dumps({"version":".".join(map(str,sys.version_info[:3]))}))',
      ],
      { timeout: 10_000, maxBuffer: 4096, env: { ...process.env, PYTHONPATH: pythonSourceRoot } },
    )
    return { executable, ...(JSON.parse(stdout) as { version: string }) }
  })
  let selection: Partial<Record<ProfileRole, string>> = {},
    adapter: 'dsh' | 'pi' | undefined
  let linuxIsolation: LinuxSandboxIsolation | undefined
  await probe('configuration', 'gear config explain', async () => {
    const hasProject = await access(join(root, 'gear.yaml')).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return false
      },
    )
    if (hasProject) {
      const { config } = await resolveProject(root)
      selection = { target: config.target.profile, meta: config.meta.profile }
      adapter = config.target.adapter
      linuxIsolation = config.sandbox?.linux_isolation
      return { scope: 'project', adapter }
    }
    selection = await defaultProfiles()
    return { scope: 'default' }
  })
  await probe(
    'isolation',
    'Configure the supported OS sandbox tools and sandbox.linux_isolation; see the configuration guide',
    async () => {
      const lease = await acquireAirGappedSandbox(linuxIsolation, 'Gear doctor')
      await lease.release()
      return {
        platform: process.platform,
        linux_isolation: linuxIsolation ?? 'seccomp',
        process_probe: 'passed',
      }
    },
  )
  const authentication: Partial<
    Record<ProfileRole, { status: string; names?: string[]; next_action?: string }>
  > = {}
  for (const role of ['target', 'meta'] as const) {
    const name = selection[role]
    if (!name) {
      checks.push({
        component: `${role}.profile`,
        status: 'failed',
        detail: 'No profile selected',
        next_action: `gear profile create default-${role}`,
      })
      authentication[role] = { status: 'not_configured' }
      continue
    }
    await probe(`${role}.profile`, `gear profile list`, async () => {
      const value = await profile(name)
      assertProfileRole(value, role, adapter)
      if ('kind' in value && value.kind === 'codex') {
        const runtime = await describeCodex(value.configuration)
        const present = value.passEnv.filter(
          (key) => codexCredentialEnvNames.includes(key) && !!process.env[key]?.trim(),
        )
        if (value.configuration.authHome) {
          // Check the exact credential file copied into real operations, without reading user config or printing credentials.
          const temporary = await mkdtemp(join(tmpdir(), 'gear-auth-check-'))
          try {
            const home = join(temporary, '.codex')
            await mkdir(home, { mode: 0o700 })
            await writeFile(join(home, 'auth.json'), await codexAuthFile(value.configuration.authHome), {
              mode: 0o600,
            })
            await execute(runtime.executable, ['login', 'status'], {
              timeout: 10_000,
              maxBuffer: 16_384,
              env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: temporary, CODEX_HOME: home },
            })
          } catch {
            const next_action =
              'Complete Codex file-based login in this profile authHome, then rerun gear doctor'
            authentication[role] = { status: 'not_configured', next_action }
            throw new GearError(
              'codex-credentials-unavailable',
              'Codex could not read a usable local login',
              { next_action },
            )
          } finally {
            await rm(temporary, { recursive: true, force: true })
          }
          authentication[role] = { status: 'local_login_present' }
        } else
          authentication[role] = present.length
            ? { status: 'environment_present', names: present }
            : {
                status: 'not_configured',
                next_action:
                  'Set CODEX_API_KEY or create a profile with --auth-home pointing to Codex file-based login',
              }
        if (!value.configuration.allowedDomains.length)
          throw new GearError('codex-network-disabled', 'Configure model service domains')
        return {
          name,
          kind: value.kind,
          model: value.configuration.model,
          runtime,
          capabilities: codexCapabilities,
        }
      }
      if ('kind' in value) {
        const present = value.passEnv.filter(
          (key) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/u.test(key) && !!process.env[key]?.trim(),
        )
        authentication[role] = present.length
          ? { status: 'environment_present', names: present }
          : {
              status: 'not_configured',
              next_action:
                'Configure model credentials in Target passEnv; confirm the selected provider accepts them',
            }
        const selectedAdapter = adapter ?? (value.harnessRef.startsWith('pi@') ? 'pi' : 'dsh')
        const connection = await inspectHitchConnection(
          value,
          harnessAdapter(selectedAdapter),
          new AbortController().signal,
        )
        await probe(`${role}.dependencies`, 'gear setup --hitch', async () => {
          const dependencies = await hitchJson(
            value.executable,
            value.root,
            ['eval', 'doctor', '--json'],
            new AbortController().signal,
          )
          if (dependencies.ready !== true)
            throw new GearError('hitch-dependencies-unavailable', 'Prepare Harbor and Docker')
          const checks = dependencies.checks as { harbor?: { version?: unknown } } | undefined
          if (checks?.harbor?.version !== runtimeMatrix.harbor)
            throw new GearError('harbor-version-mismatch', 'Install the Harbor version in the runtime matrix')
          await execute('docker', ['image', 'inspect', value.baseImage, '--format', '{{.Id}}'], {
            timeout: 15_000,
            maxBuffer: 4096,
          })
          return { harbor: runtimeMatrix.harbor, docker: 'running', image: value.baseImage }
        })
        return {
          name,
          kind: value.kind,
          model: value.model,
          harness: value.harnessRef,
          runtime_identity: connection.revisionIdentity,
          capabilities: hitchCapabilities,
        }
      }
      const provider = await ProcessOperationProvider.connect(value, {
        runId: 'doctor',
        directory: join(root, '.gear', 'doctor'),
        targets: join(root, '.gear', 'doctor', 'targets'),
        targetAdapter: adapter ?? 'dsh',
        protectedPaths: [root],
        tasks: [],
      })
      if (
        !provider.capabilities.inspect ||
        !provider.capabilities.subsets ||
        !provider.capabilities.physicalAttemptAccounting
      )
        throw new GearError(
          'provider-capability-missing',
          'Provider must support inspect, subsets and physical attempt accounting',
        )
      authentication[role] = {
        status: 'provider_managed',
        next_action: 'Verify authentication with the custom provider; then run a seed smoke test',
      }
      return { name, kind: 'process', identity: provider.identity, capabilities: provider.capabilities }
    })
    authentication[role] ??= { status: 'not_checked' }
  }
  const common = checks
    .filter((check) => !check.component.includes('.'))
    .every((check) => check.status === 'passed')
  const localReady = (role: ProfileRole) =>
    checks.some((check) => check.component === `${role}.profile` && check.status === 'passed') &&
    checks
      .filter((check) => check.component.startsWith(`${role}.`))
      .every((check) => check.status === 'passed') &&
    ['local_login_present', 'environment_present'].includes(authentication[role]?.status ?? '')
  return {
    checks,
    profiles: await listProfiles(),
    selection,
    authentication,
    model_access: 'not_checked',
    benchmark: 'not_run',
    model_requests: 0,
    ready_for_seed_smoke: common && localReady('target'),
    ready_for_refine_smoke: common && localReady('target') && localReady('meta'),
    next_action:
      common && localReady('target')
        ? 'gear benchmark check, then gear evaluate --split seed --limit 1'
        : 'Resolve the failed checks and credential configuration, then rerun gear doctor',
    matrix: runtimeMatrix,
  }
}
