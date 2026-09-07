#!/usr/bin/env node
// Fixed compiler entry point. Run only through Gear's disposable snapshot and
// air-gapped compiler sandbox; this file is never supplied by the candidate.
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const notChecked = () => ({ status: 'not_checked', code: 'PREVIOUS_STAGE_NOT_COMPLETED' })
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (Buffer.byteLength(input) > 16_384) throw new Error('runtime check request too large')
}
const request = JSON.parse(input)
if (request.schemaVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(request.candidateDigest)
  || request.targetRoot !== 'harness' || !process.env.DSH_HOME) throw new Error('invalid DSH check request')
// The outer sandbox wrapper may set its own TMPDIR. DSH's spills and native
// temporary resources must stay inside this check's disposable writable root.
process.env.TMPDIR = join(dirname(process.cwd()), 'tmp')
process.env.TMP = process.env.TMPDIR
process.env.TEMP = process.env.TMPDIR
const report = {
  schemaVersion: 1, candidateDigest: request.candidateDigest,
  load: notChecked(), promptAssembly: notChecked(), skillDiscovery: notChecked(), skillRead: notChecked(), cleanup: notChecked(), skills: [],
}
let phase = 'load'
const checkpoint = () => writeFile(request.reportPath, JSON.stringify({ ...report, activeStage: phase }))
let ctx
let agentHandle
let expectedProvider
let fatal
let prohibitedRequests = 0
let logService
const runtimeErrors = []
const blockRequest = () => {
  prohibitedRequests++
  throw new Error('MODEL_OR_NETWORK_REQUEST_FORBIDDEN: runtime smoke checks cannot make requests')
}
globalThis.fetch = blockRequest
const onRejection = error => { fatal ??= error }
process.on('unhandledRejection', onRejection)
const message = error => String(error?.stack ?? error).replaceAll(request.repository, '<candidate>').replaceAll(request.runtimeRoot, '<runtime>').slice(-4000)
const fail = (key, code, error) => { report[key] = { status: 'failed', code, message: message(error) } }

try {
  await checkpoint()
  const carrierRequire = createRequire(join(request.runtimeRoot, 'package.json'))
  const anchor = await realpath(carrierRequire.resolve('@deepseek-ai/dsh/package.json'))
  const dshRequire = createRequire(anchor)
  const pkg = JSON.parse(await readFile(anchor, 'utf8'))
  if (pkg.version !== '0.1.1-rc.2') throw new Error(`RUNTIME_VERSION_MISMATCH: expected DSH 0.1.1-rc.2, found ${pkg.version}`)
  const lock = await readFile(join(request.runtimeRoot, 'pnpm-lock.yaml'))
  const installedCarrier = JSON.parse(await readFile(join(request.runtimeRoot, 'package.json'), 'utf8'))
  const candidateCarrier = JSON.parse(await readFile(join(request.repository, 'package.json'), 'utf8'))
  const dependencies = carrier => JSON.stringify(Object.entries(carrier.dependencies ?? {}).sort())
  if (dependencies(installedCarrier) !== dependencies(candidateCarrier)
    || installedCarrier.packageManager !== candidateCarrier.packageManager
    || await readFile(join(request.runtimeRoot, 'pnpm-workspace.yaml'), 'utf8')
      !== await readFile(join(request.repository, 'pnpm-workspace.yaml'), 'utf8')) {
    throw new Error('RUNTIME_SUBSTRATE_MISMATCH: carrier dependency contracts differ')
  }
  const candidateLock = await readFile(join(request.repository, 'pnpm-lock.yaml')).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (candidateLock && !candidateLock.equals(lock)) throw new Error('RUNTIME_SUBSTRATE_MISMATCH: carrier lockfiles differ')
  report.identity = { name: pkg.name, version: pkg.version, lockDigest: sha(lock) }
  const nativeImport = name => import(pathToFileURL(dshRequire.resolve(name)).href)
  const appBoot = await nativeImport('@deepseek-ai/dsh-app-boot')
  const skillFilesystem = await nativeImport('@deepseek-ai/dsh-skill-filesystem')
  const agentRuntime = await nativeImport('@deepseek-ai/dsh-agent')
  const systemPrompt = await nativeImport('@deepseek-ai/dsh-system-prompt')
  for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-tools']) {
    const installed = JSON.parse(await readFile(dshRequire.resolve(`${name}/package.json`), 'utf8'))
    if (installed.version !== pkg.version) throw new Error(`RUNTIME_VERSION_MISMATCH: ${name}@${installed.version}`)
  }

  // The same closure and profile composition used by the rc.2 CLI. Dependencies
  // resolve from the fixed Target installation, never Gear's development tree.
  const home = process.env.DSH_HOME
  appBoot.healProfilesModuleFallback(anchor, home)
  const modules = join(home, 'profiles', 'node_modules')
  const codex = dirname(await realpath(carrierRequire.resolve('dsh-codex/package.json')))
  await symlink(codex, join(modules, 'dsh-codex'), 'dir')
  const profile = appBoot.loadProfile('gear-check', 'headless', anchor, home, { userLayer: false })
  await copyFile(join(request.repository, 'fixed', 'target-loader-shim.js'), join(profile.dir, 'target-loader-shim.js'))
  process.env.DSH_REFINE_REPOSITORY = request.repository
  process.env.DSH_REFINE_TARGET_LOADER_URL = pathToFileURL(join(request.repository, 'fixed', 'target-loader.js')).href
  const rootConfig = join(profile.dir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  const patches = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...appBoot.loadOverlayPatches('gear-check', join(request.repository, 'fixed', 'target.patch.yml')),
    // These rows initiate work or telemetry, not candidate loading. Disable
    // them before boot; stopping a headless turn afterwards is already too late.
    ...['headless-runner', 'headless-startup', 'session-telemetry-otel', 'hmr'].map(id => ({ id, disabled: true })),
    { id: 'agent-default-model', config: {
      provider: process.env.GEAR_TARGET_PROVIDER ?? 'openai-codex',
      model: process.env.GEAR_TARGET_MODEL ?? 'gpt-5.6-luna',
    } },
  ]
  ctx = await appBoot.boot('gear-check', rootConfig, patches, host => {
    // Capture partial contexts so cleanup also covers boot/activation failure.
    ctx = host
    logService = host.logger
    // Cordis catches disposer errors and logs them. Keep this observer alive
    // through root disposal, then remove it ourselves after the cleanup audit.
    logService.exporters.set(-1, { export(event) {
      if (event.type === 'error' && runtimeErrors.length < 20) runtimeErrors.push({ phase, text: event.args.map(message).join(' ') })
    } })
    host.provide('cmdlineArgs', [])
    host.provide('appExit', blockRequest)
    host.on('llm/stream', blockRequest)
  })
  await appBoot.assertEntriesActivated(ctx, 'gear-check')
  if (!ctx.get('targetHarness') || ctx.targetHarness.ref !== request.candidateDigest) throw new Error('CARRIER_NOT_LOADED: targetHarness identity was not registered')
  // Match headless's real session context without sending input or starting a
  // model turn. The native skill tool derives its cwd from the calling agent.
  const selection = ctx.agentDefaultModel.currentSelection()
  agentHandle = await ctx.agents.create({ sessionId: 'gear-runtime-check', meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: agentCtx => { agentRuntime.installModelSelection(agentCtx, { current: selection, assembled: undefined }) } })
  if (fatal) throw fatal
  if (runtimeErrors.length) throw new Error(runtimeErrors.map(item => item.text).join('\n'))
  if (prohibitedRequests) throw new Error('MODEL_OR_NETWORK_REQUEST_FORBIDDEN')
  report.load = { status: 'passed' }

  phase = 'promptAssembly'
  await checkpoint()
  // Registration is lazy: callbacks, scoped tool schemas and {{variables}}
  // may fail only when a real turn assembles/renders its model input.
  const assembly = await agentHandle.agent.ctx.get('systemPrompt').assemble(
    agentRuntime.assembleContextFor(agentHandle.agent, new AbortController().signal))
  systemPrompt.renderPrompt(assembly)
  systemPrompt.renderContextSnapshot(assembly)
  if (fatal) throw fatal
  if (runtimeErrors.length) throw new Error(runtimeErrors.map(item => item.text).join('\n'))
  if (prohibitedRequests) throw new Error('MODEL_OR_NETWORK_REQUEST_FORBIDDEN')
  report.promptAssembly = { status: 'passed', expected: 1, checked: 1 }

  phase = 'skillDiscovery'
  await checkpoint()
  const manifest = JSON.parse(await readFile(join(request.repository, 'harness', 'manifest.json'), 'utf8'))
  const resources = manifest.artifacts.filter(item => /^skills\/[^/]+\.md$/.test(item.path) || /^skills\/[^/]+\/SKILL\.md$/.test(item.path))
  const nested = manifest.artifacts.find(item => item.path.startsWith('skills/') && item.path.endsWith('/SKILL.md') && !resources.includes(item))
  if (nested) throw new Error(`UNSUPPORTED_SKILL_LAYOUT: ${nested.path}`)
  if (resources.length === 0) {
    report.skillDiscovery = { status: 'not_checked', code: 'NO_CANDIDATE_SKILLS', expected: 0, checked: 0 }
    report.skillRead = { status: 'not_checked', code: 'NO_CANDIDATE_SKILLS', expected: 0, checked: 0 }
  } else {
    const agent = agentHandle.agent
    const lookup = { cwd: agent.session.header.cwd }
    const skills = agent.ctx.get('skills')
    const tools = agent.ctx.get('tools')
    if (!skills) throw new Error('SKILL_SERVICE_MISSING')
    // Use DSH's own provider/parser to form the expected catalog. This isolated
    // scanner is never registered: only the candidate's actual registry and
    // native tool can satisfy the discovery/read assertions below.
    expectedProvider = new skillFilesystem.FileSystemSkillProvider(agent.ctx, {
      signal: new AbortController().signal, invalidate() {},
    }, { providerName: 'gear-check-expected', includeDefaultRoots: false, watch: false,
      customSkillDirs: [join(request.repository, 'harness', 'skills')] })
    const observation = await expectedProvider.list(lookup)
    const expected = Array.isArray(observation) ? observation : observation.candidates
    if (!Array.isArray(observation) && observation.complete === false) throw new Error('SKILL_SCAN_INCOMPLETE')
    for (const resource of resources) if (!expected.some(item => resolve(item.path) === join(request.repository, 'harness', resource.path))) {
      throw new Error(`INVALID_SKILL_RESOURCE: ${resource.path} was rejected by the locked DSH parser`)
    }
    if (new Set(expected.map(skill => skill.name)).size !== expected.length) throw new Error('DUPLICATE_CANDIDATE_SKILL_NAME')
    const actual = await skills.list(lookup)
    const reads = []
    for (const entry of expected) {
      const found = actual.find(item => item.name === entry.name)
      const full = await skills.get(entry.name, lookup)
      if (!found || !full || resolve(full.path ?? '') !== resolve(entry.path)) {
        throw new Error(`SKILL_NOT_DISCOVERED: ${entry.name} at ${relative(request.repository, entry.path)}; check the fixed skill-filesystem directory configuration`)
      }
      const intended = await expectedProvider.get(entry, lookup)
      if (!intended || full.content !== intended.content) throw new Error(`SKILL_CONTENT_MISMATCH: ${entry.name}`)
      reads.push({ entry, full, intended })
    }
    report.skillDiscovery = { status: 'passed', expected: expected.length, checked: reads.length }
    phase = 'skillRead'
    await checkpoint()
    if (!tools || !tools.get('skill')) throw new Error('NATIVE_SKILL_TOOL_MISSING')
    let checked = 0
    for (const { entry, full, intended } of reads) {
      const item = { name: entry.name, path: relative(join(request.repository, 'harness'), entry.path),
        provider: full.provider, contentDigest: sha(intended.content), read: 'not_checked' }
      report.skills.push(item)
      if (intended.invocation?.modelInvocable === false) continue
      const result = await tools.execute({ name: 'skill', arguments: { name: entry.name },
        agent, callId: `gear-smoke-${checked}`, signal: new AbortController().signal })
      if (result.isError || result.value?.name !== entry.name || result.value?.provider !== full.provider
        || result.value?.content !== intended.content
        || !result.content.some(block => block.type === 'text' && block.text.includes(intended.content))
        || result.value?.resourceBase?.path !== full.resourceBase?.path) {
        item.read = 'failed'
        throw new Error(`NATIVE_SKILL_READ_FAILED: ${entry.name}; ${JSON.stringify(result.content).slice(0, 1200)}`)
      }
      item.read = 'passed'
      checked++
    }
    report.skillRead = checked === 0 ? { status: 'not_checked', code: 'MODEL_INVOCATION_DISABLED', expected: 0, checked: 0 }
      : { status: 'passed', expected: reads.filter(item => item.intended.invocation?.modelInvocable !== false).length, checked }
  }
  if (fatal) throw fatal
  if (runtimeErrors.length) throw new Error(runtimeErrors.map(item => item.text).join('\n'))
  if (prohibitedRequests) throw new Error('MODEL_OR_NETWORK_REQUEST_FORBIDDEN')
} catch (error) {
  fail(phase, { load: 'RUNTIME_LOAD_FAILED', promptAssembly: 'PROMPT_ASSEMBLY_FAILED',
    skillDiscovery: 'SKILL_DISCOVERY_FAILED', skillRead: 'SKILL_READ_FAILED' }[phase], error)
} finally {
  phase = 'cleanup'
  await checkpoint()
  let timer
  try {
    await Promise.race([
      (async () => {
        // dsh-codex 0.2.6 refreshes live agent tools on tools/change. Stop
        // that provider before closing the agent scope it would refresh.
        // This affects teardown only, after all runtime assertions completed.
        try {
          await expectedProvider?.dispose()
          // boot() may already have disposed its partial context on failure.
          const loader = ctx?.get('loader')
          const codex = loader && [...loader.entries()].find(entry => entry.options.id === 'llm-openai-codex')
          await codex?.fiber?.dispose()
          await agentHandle?.dispose()
        }
        finally { await ctx?.fiber.dispose() }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('runtime dispose timed out')), 3000) }),
    ])
    report.cleanup = { status: 'passed' }
    const cleanupErrors = runtimeErrors.filter(item => item.phase === 'cleanup')
    if (cleanupErrors.length) throw new Error(cleanupErrors.map(item => item.text).join('\n'))
  } catch (error) { fail('cleanup', 'RUNTIME_CLEANUP_FAILED', error) }
  finally { clearTimeout(timer) }
  if (fatal && !Object.values(report).some(stage => stage?.status === 'failed')) fail(phase, 'ASYNC_RUNTIME_FAILURE', fatal)
  process.removeListener('unhandledRejection', onRejection)
  logService?.exporters.delete(-1)
  await checkpoint()
  process.exitCode = Object.values(report).some(stage => stage?.status === 'failed') ? 1 : 0
}
