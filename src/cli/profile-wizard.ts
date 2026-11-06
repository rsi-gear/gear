import { createInterface } from 'node:readline/promises'
import type { ProjectController } from '../application/project-controller.js'
import { GearError } from '../domain/errors.js'

export async function prompt<T>(
  work: (ask: (label: string, fallback?: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  if (!process.stdin.isTTY)
    throw new GearError(
      'interactive-terminal-required',
      'Use profile flags or --from FILE when stdin is not a terminal',
    )
  const reader = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await work(async (label, fallback) => {
      const answer =
        (await reader.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback || ''
      if (!answer) throw new GearError('required-answer', `${label} is required`)
      return answer
    })
  } finally {
    reader.close()
  }
}
export async function createProfileWizard(
  controller: ProjectController,
  name: string,
  suggestedKind?: string,
) {
  return prompt(async (ask) => {
    const kind = await ask('Profile kind (hitch Target / codex Meta)', suggestedKind)
    if (kind !== 'hitch' && kind !== 'codex')
      throw new GearError('invalid-profile-kind', 'Choose hitch or codex')
    const model = await ask('Model accepted by this provider')
    const executable = await ask('Provider executable', kind === 'hitch' ? 'hitch' : 'codex')
    const options: Record<string, unknown> = { kind, model, executable }
    if (kind === 'hitch') {
      options.adapter = await ask('Target adapter (dsh / pi)', 'dsh')
      options.baseImage = await ask('Prepared Docker image or digest', 'python:3.12-slim')
      const names = await ask('Credential environment variable NAMES, comma-separated (or none)', 'none')
      options.passEnv = names === 'none' ? [] : names.split(',').map((name) => name.trim())
    } else {
      const auth = await ask('Authentication source (env / login)', 'env')
      if (auth === 'login') {
        options.authHome = await ask('Codex directory containing auth.json')
        options.passEnv = []
      } else if (auth !== 'env') throw new GearError('invalid-auth-source', 'Choose env or login')
      else options.passEnv = ['CODEX_API_KEY']
    }
    return controller.invoke('profile.create', { name, options })
  })
}
export async function selectProfilesWizard(controller: ProjectController) {
  for (const role of ['target', 'meta'] as const) {
    const inventory = (await controller.invoke('profile.list')) as {
      profiles: Array<{ name: string; kind: string; valid: boolean }>
    }
    const available = inventory.profiles.filter(
      (item) =>
        item.valid && (item.kind === 'process' || item.kind === (role === 'target' ? 'hitch' : 'codex')),
    )
    const name = await prompt((ask) =>
      ask(
        `${role} profile: ${available.map((item) => item.name).join(', ') || 'none yet'}; choose a name to select or create`,
        `default-${role}`,
      ),
    )
    if (!available.some((item) => item.name === name))
      await createProfileWizard(controller, name, role === 'target' ? 'hitch' : 'codex')
    await controller.invoke('profile.select', { name, role, scope: 'default' })
  }
}
