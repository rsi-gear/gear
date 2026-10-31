import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { GearError } from '../domain/errors.js'
import { ProjectController } from '../application/project-controller.js'
import { createProjectControlPlane } from '../application/control-plane.js'
import { ProjectApplication } from '../application/project-service.js'
import { configuredBindings } from '../application/profiles.js'
import { createProfileWizard, selectProfilesWizard } from './profile-wizard.js'
import { parseJsonInput } from './project-input.js'
import { formatRunPlan } from './run-plan.js'
import type { RunPlan } from '../application/run-plan.js'

const help = `gear setup [--hitch --target dsh|pi] [--python PATH] [--interactive] | doctor | init DIRECTORY [--target dsh|pi] [--template text|files]
gear profile list | create NAME [--kind hitch|codex --model MODEL [--agent-args-json JSON] | --from FILE] | use NAME --role target|meta [--default]
gear benchmark check | benchmark preview TASK_ID | benchmark import SOURCE [--template text|json|files|harbor] [--research]
gear benchmark import --apply PLAN_ID
gear benchmark probe [--task TASK_ID] [--scorer] [--image IMAGE] (builds a Docker environment; no Target/model call)
gear algorithm test [gepa|random-search|module:function]
gear evaluate --split seed|held_out [--limit N]\ngear refine [--rounds N] [--dry-run] | resume RUN_ID | cancel RUN_ID | report [RUN_ID] | archive RUN_ID | export RUN_ID
gear config explain | serve [--socket PATH]
gear experience query RUN_ID [--query TEXT] [--snapshot DIGEST] [--limit N] [--cursor TOKEN]
gear experience read RUN_ID REF [--view card|task-results|diff|trajectory|modification-use|verifier] [--snapshot DIGEST] [--limit N] [--cursor TOKEN]
gear experience trajectory RUN_ID REF SOURCE_REF --snapshot DIGEST [--query-json JSON]
All commands accept --project DIRECTORY and --json. Credentials remain in provider profiles.`

async function foreground(controller: ProjectController, method: string, params: unknown, showPlan = false) {
  const abort = new AbortController()
  const stop = () =>
    abort.abort(new GearError('command-interrupted', 'Command interrupted; resume the saved run'))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    return await controller.invoke(method, params, {
      signal: abort.signal,
      ...(showPlan
        ? {
            onPlan: (plan: RunPlan) => {
              process.stderr.write(formatRunPlan(plan))
            },
          }
        : {}),
    })
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

export async function projectCommand(argv: string[]): Promise<boolean> {
  const args = [...argv]
  const take = (name: string): string | undefined => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    if (args[index + 1] === undefined || args[index + 1]!.startsWith('--'))
      throw new GearError('missing-cli-value', `${name} requires a value`)
    return args.splice(index, 2)[1]
  }
  const root = resolve(take('--project') ?? '.'),
    jsonIndex = args.indexOf('--json')
  if (jsonIndex >= 0) args.splice(jsonIndex, 1)
  const command = args.shift()
  if (command === '--help' || command === 'help' || command === undefined) {
    process.stdout.write(`${help}\n`)
    return true
  }
  if (
    ![
      'serve',
      'profile',
      'setup',
      'doctor',
      'init',
      'benchmark',
      'algorithm',
      'evaluate',
      'refine',
      'resume',
      'cancel',
      'report',
      'export',
      'archive',
      'experience',
      'config',
    ].includes(command)
  )
    return false
  let result: unknown
  const app = new ProjectApplication(root, configuredBindings)
  const controller = new ProjectController(app)
  if (command === 'serve') {
    const socketPath = take('--socket')
    if (args.length) throw new GearError('unknown-cli-option', args.join(' '))
    const control = await createProjectControlPlane(root, socketPath === undefined ? {} : { socketPath })
    process.stdout.write(
      `${JSON.stringify({ ready: true, project: root, socketPath: control.socketPath })}\n`,
    )
    const stopping = Promise.withResolvers<void>()
    const stop = () => stopping.resolve()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      await stopping.promise
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      await control.dispose()
    }
    return true
  } else if (command === 'setup') {
    const flag = (name: string) => {
      const index = args.indexOf(name)
      if (index < 0) return false
      args.splice(index, 1)
      return true
    }
    const interactive = flag('--interactive') || (jsonIndex < 0 && !!process.stdin.isTTY)
    const options: Record<string, unknown> = Object.fromEntries(
      Object.entries({
        python: take('--python'),
        hitch: flag('--hitch'),
        adapter: take('--target'),
        hitchExecutable: take('--hitch-executable'),
        hitchRoot: take('--hitch-root'),
        image: take('--image'),
        targetProfile: take('--target-profile'),
        metaProfile: take('--meta-profile'),
      }).filter(([, value]) => value !== undefined),
    )
    if (args.length) throw new GearError('unknown-cli-option', args.join(' '))
    result = await controller.invoke('environment.setup', options)
    if (interactive) {
      await selectProfilesWizard(controller)
      result = { setup: result, doctor: await controller.invoke('environment.doctor') }
    }
  } else if (command === 'doctor') {
    if (args.length) throw new GearError('unknown-cli-option', args.join(' '))
    result = await controller.invoke('environment.doctor')
  } else if (command === 'profile') {
    const action = args.shift()
    if (action === 'list' && !args.length) result = await controller.invoke('profile.list')
    else if (action === 'use') {
      const role = take('--role'),
        index = args.indexOf('--default')
      if (index >= 0) args.splice(index, 1)
      if (args.length !== 1)
        throw new GearError('invalid-profile-command', 'Use profile use NAME --role target|meta [--default]')
      result = await controller.invoke('profile.select', {
        name: args[0],
        role,
        scope: index >= 0 ? 'default' : 'project',
      })
    } else if (action === 'create') {
      const from = take('--from'),
        kind = take('--kind'),
        agentArgsJson = take('--agent-args-json')
      let agentArgs: unknown
      if (agentArgsJson !== undefined) {
        try {
          agentArgs = JSON.parse(agentArgsJson)
        } catch {
          throw new GearError('invalid-profile-options', '--agent-args-json requires a JSON string array')
        }
      }
      const options: Record<string, unknown> = Object.fromEntries(
        Object.entries({
          kind,
          model: take('--model'),
          executable: take('--executable'),
          adapter: take('--adapter'),
          root: take('--hitch-root'),
          harnessRef: take('--harness-ref'),
          baseImage: take('--image'),
          passEnv: take('--pass-env')?.split(',').filter(Boolean),
          agentArgs,
          timeoutMs: take('--timeout-ms'),
          maxConcurrent: take('--max-concurrent'),
          preparationTimeoutMs: take('--preparation-timeout-ms'),
          setupTimeoutMs: take('--setup-timeout-ms'),
          authHome: take('--auth-home'),
          allowedDomains: take('--allowed-domains')?.split(',').filter(Boolean),
        }).filter(([, value]) => value !== undefined),
      )
      for (const key of ['timeoutMs', 'maxConcurrent', 'preparationTimeoutMs', 'setupTimeoutMs']) {
        if (options[key] !== undefined) options[key] = Number(options[key])
      }
      if (args.length !== 1 || args[0]!.startsWith('--'))
        throw new GearError(
          'invalid-profile-command',
          'Use profile create NAME --kind hitch|codex --model MODEL or --from FILE',
        )
      if (from) {
        if (Object.keys(options).length)
          throw new GearError('invalid-profile-command', '--from cannot be combined with creation options')
        result = await controller.invoke('profile.import', {
          name: args[0],
          profile: parseJsonInput(await readFile(resolve(root, from), 'utf8'), `--from ${from}`),
        })
      } else if (!Object.keys(options).length && jsonIndex < 0)
        result = await createProfileWizard(controller, args[0]!)
      else result = await controller.invoke('profile.create', { name: args[0], options })
    } else throw new GearError('invalid-profile-command', 'Use profile list, create or use')
  } else if (command === 'init') {
    const options: Record<string, unknown> = Object.fromEntries(
      Object.entries({
        adapter: take('--target'),
        template: take('--template'),
        targetProfile: take('--target-profile'),
        metaProfile: take('--meta-profile'),
      }).filter(([, value]) => value !== undefined),
    )
    if (args.length !== 1 || args[0]!.startsWith('--'))
      throw new GearError('invalid-init-options', 'init DIRECTORY --target dsh|pi --template text|files')
    result = await controller.invoke('project.init', { directory: resolve(root, args[0]!), ...options })
  } else if (command === 'benchmark') {
    const action = args.shift()
    if (action === 'import') {
      const plan = take('--apply'),
        template = take('--template'),
        resource_root = take('--resource-root')
      const index = args.indexOf('--research')
      if (index >= 0) args.splice(index, 1)
      if (plan) {
        if (args.length || template || resource_root || index >= 0)
          throw new GearError('invalid-benchmark-import', 'Use benchmark import --apply PLAN_ID')
        result = await controller.invoke('benchmark.apply', { plan_id: plan })
      } else {
        if (args.length !== 1 || args[0]!.startsWith('--'))
          throw new GearError(
            'invalid-benchmark-import',
            'Use benchmark import SOURCE [--template text|json|files|harbor] [--research]',
          )
        result = await controller.invoke('benchmark.import', {
          source: args[0],
          mode: index >= 0 ? 'research' : 'holdout',
          ...(template ? { template } : {}),
          ...(resource_root ? { resource_root } : {}),
        })
      }
    } else if (action === 'probe') {
      const task = take('--task'),
        image = take('--image'),
        index = args.indexOf('--scorer')
      if (index >= 0) args.splice(index, 1)
      if (args.length) throw new GearError('unknown-cli-option', args.join(' '))
      result = await foreground(controller, 'benchmark.probe', {
        scorer: index >= 0,
        ...(task ? { task_id: task } : {}),
        ...(image ? { image } : {}),
      })
    } else if (action === 'check' && !args.length) result = await controller.invoke('benchmark.check')
    else if (action === 'preview' && args.length === 1) {
      result = await controller.invoke('benchmark.preview', { task_id: args[0] })
    } else
      throw new GearError('invalid-benchmark-command', 'Use benchmark check or benchmark preview TASK_ID')
  } else if (command === 'experience') {
    const action = args.shift(),
      query = take('--query'),
      queryJson = take('--query-json'),
      snapshot = take('--snapshot'),
      view = take('--view'),
      limit = take('--limit'),
      cursor = take('--cursor')
    if (action === 'trajectory') {
      if (
        args.length !== 3 ||
        !snapshot ||
        query !== undefined ||
        view !== undefined ||
        limit !== undefined ||
        cursor !== undefined
      )
        throw new GearError(
          'invalid-experience-command',
          'Use experience trajectory RUN_ID REF SOURCE_REF --snapshot DIGEST [--query-json JSON]',
        )
      result = await foreground(controller, 'experience.trajectory', {
        run_id: args[0],
        ref: args[1],
        source_ref: args[2],
        snapshot_digest: snapshot,
        query: queryJson === undefined ? {} : parseJsonInput(queryJson, '--query-json'),
      })
    } else {
      if (
        !['query', 'read'].includes(action ?? '') ||
        args.length !== (action === 'read' ? 2 : 1) ||
        (action === 'read' && (query !== undefined || queryJson !== undefined)) ||
        (query !== undefined && queryJson !== undefined) ||
        (action === 'query' && view !== undefined)
      )
        throw new GearError(
          'invalid-experience-command',
          'Use experience query RUN_ID or experience read RUN_ID REF',
        )
      result = await controller.invoke(`experience.${action}`, {
        run_id: args[0],
        ...(action === 'read'
          ? { ref: args[1] }
          : {
              query:
                queryJson === undefined ? { query: query ?? '' } : parseJsonInput(queryJson, '--query-json'),
            }),
        ...(snapshot ? { snapshot_digest: snapshot } : {}),
        ...(view ? { view } : {}),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(cursor ? { cursor } : {}),
      })
    }
  } else if (command === 'config') {
    if (args.length !== 1 || args[0] !== 'explain')
      throw new GearError('invalid-config-command', 'Use config explain')
    result = await controller.invoke('config.explain')
  } else if (command === 'algorithm') {
    if (args.shift() !== 'test' || args.length > 1)
      throw new GearError('invalid-algorithm-command', 'Use algorithm test [entrypoint]')
    result = await controller.invoke('algorithm.test', { entrypoint: args[0] ?? 'gepa' })
  } else if (command === 'evaluate') {
    const split = take('--split'),
      limit = take('--limit')
    if (args.length || !['seed', 'held_out'].includes(split ?? ''))
      throw new GearError('explicit-split-required', 'Use evaluate --split seed|held_out [--limit N]')
    result = await foreground(controller, 'run.evaluate', {
      split: split as 'seed' | 'held_out',
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    })
  } else if (command === 'refine') {
    const dryIndex = args.indexOf('--dry-run'),
      dryRun = dryIndex >= 0
    if (dryRun) args.splice(dryIndex, 1)
    const rounds = take('--rounds'),
      algorithmPath = take('--algorithm-config')
    if (
      args.length ||
      (rounds !== undefined && (!Number.isSafeInteger(Number(rounds)) || Number(rounds) < 1))
    )
      throw new GearError('invalid-refine-options', 'Use refine --rounds N')
    const algorithm = algorithmPath
      ? (parseJsonInput(
          await readFile(resolve(root, algorithmPath), 'utf8'),
          `--algorithm-config ${algorithmPath}`,
        ) as Parameters<ProjectApplication['refine']>[0])
      : {}
    result = await foreground(
      controller,
      dryRun ? 'run.plan' : 'run.refine',
      {
        ...algorithm,
        ...(rounds === undefined ? {} : { rounds: Number(rounds) }),
      },
      !dryRun && jsonIndex < 0,
    )
  } else {
    const id = args.shift()
    if ((!id && command !== 'report') || args.length)
      throw new GearError('run-id-required', `${command} requires one run ID`)
    result =
      command === 'resume'
        ? await foreground(controller, 'run.resume', { run_id: id })
        : await controller.invoke(`run.${command}`, id === undefined ? {} : { run_id: id })
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return true
}
