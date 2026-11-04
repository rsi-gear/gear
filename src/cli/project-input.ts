import { GearError } from '../domain/errors.js'

/** Command-line JSON is external input: malformed text is a command error with a code, not a SyntaxError. */
export function parseJsonInput(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new GearError('invalid-json-input', `${label} must be valid JSON: ${(error as Error).message}`)
  }
}

/** Native command projection; ProjectController owns semantic validation. */
export function parseProjectCommand(input: string): { method: string; params: Record<string, unknown> } {
  const words = input.trim().split(/\s+/u).filter(Boolean)
  const command = words.shift() ?? 'report'
  const take = (name: string): string | undefined => {
    const index = words.indexOf(name)
    if (index < 0) return undefined
    const value = words[index + 1]
    if (!value || value.startsWith('--'))
      throw new GearError('missing-command-value', `${name} requires a value`)
    words.splice(index, 2)
    return value
  }
  const finish = (method: string, params: Record<string, unknown>) => {
    if (words.length)
      throw new GearError('unknown-command-option', `Unexpected arguments: ${words.join(' ')}`)
    return { method, params }
  }
  if (command === 'refine') {
    const rounds = take('--rounds')
    return finish('run.refine', rounds === undefined ? {} : { rounds: Number(rounds) })
  }
  if (command === 'evaluate') {
    const split = take('--split'),
      limit = take('--limit')
    return finish('run.evaluate', {
      ...(split === undefined ? {} : { split }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    })
  }
  if (['report', 'resume', 'cancel', 'export', 'archive'].includes(command)) {
    const id = words.shift()
    if (!id && command !== 'report') throw new GearError('run-id-required', `${command} requires one run ID`)
    return finish(`run.${command}`, id === undefined ? {} : { run_id: id })
  }
  if (command === 'experience') {
    const action = words.shift(),
      snapshot = take('--snapshot'),
      view = take('--view'),
      query = take('--query'),
      queryJson = take('--query-json'),
      limit = take('--limit'),
      cursor = take('--cursor')
    if (action === 'trajectory') {
      const run_id = words.shift(),
        ref = words.shift(),
        source_ref = words.shift()
      if (
        !run_id ||
        !ref ||
        !source_ref ||
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
      return finish('experience.trajectory', {
        run_id,
        ref,
        source_ref,
        snapshot_digest: snapshot,
        query: queryJson === undefined ? {} : parseJsonInput(queryJson, '--query-json'),
      })
    }
    const run_id = words.shift(),
      ref = action === 'read' ? words.shift() : undefined
    if (
      !['query', 'read'].includes(action ?? '') ||
      !run_id ||
      (action === 'read' && !ref) ||
      (action === 'read' && (query !== undefined || queryJson !== undefined)) ||
      (query !== undefined && queryJson !== undefined) ||
      (action === 'query' && view !== undefined)
    )
      throw new GearError(
        'invalid-experience-command',
        'Use experience query RUN_ID or experience read RUN_ID REF',
      )
    return finish(`experience.${action}`, {
      run_id,
      ...(ref
        ? { ref }
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
  if (command === 'benchmark') {
    const action = words.shift()
    if (action === 'import') {
      const plan = take('--apply'),
        template = take('--template'),
        resource = take('--resource-root')
      const researchIndex = words.indexOf('--research')
      if (researchIndex >= 0) words.splice(researchIndex, 1)
      if (plan) {
        if (template || resource || researchIndex >= 0)
          throw new GearError('invalid-benchmark-import', 'Use benchmark import --apply PLAN_ID')
        return finish('benchmark.apply', { plan_id: plan })
      }
      const source = words.shift()
      if (!source) throw new GearError('benchmark-source-required', 'benchmark import requires a source path')
      return finish('benchmark.import', {
        source,
        mode: researchIndex >= 0 ? 'research' : 'holdout',
        ...(template ? { template } : {}),
        ...(resource ? { resource_root: resource } : {}),
      })
    }
    if (action === 'probe') {
      const task = take('--task'),
        image = take('--image'),
        index = words.indexOf('--scorer')
      if (index >= 0) words.splice(index, 1)
      return finish('benchmark.probe', {
        scorer: index >= 0,
        ...(task ? { task_id: task } : {}),
        ...(image ? { image } : {}),
      })
    }
    if (action === 'check') return finish('benchmark.check', {})
    if (action === 'preview') {
      const task = words.shift()
      if (!task) throw new GearError('task-id-required', 'benchmark preview requires one task ID')
      return finish('benchmark.preview', { task_id: task })
    }
  }
  if (command === 'config' && words.shift() === 'explain') return finish('config.explain', {})
  if (command === 'algorithm' && words.shift() === 'test') {
    const entrypoint = words.shift()
    return finish('algorithm.test', entrypoint === undefined ? {} : { entrypoint })
  }
  throw new GearError('unknown-command', `Unknown project command: ${command}`)
}
