import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initProject } from '../../src/application/init.js'
import { ProjectController } from '../../src/application/project-controller.js'
import { ProjectApplication } from '../../src/application/project-service.js'
import { resolveProject } from '../../src/application/project-config.js'

let root: string, project: string, controller: ProjectController
const python = execFileSync(process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gear-import-')); project = join(root, 'project')
  vi.stubEnv('GEAR_PROFILE_ROOT', join(root, 'profiles')); vi.stubEnv('GEAR_PYTHON', python)
  await initProject(project)
  controller = new ProjectController(new ProjectApplication(project, { provider: async () => { throw new Error('Authoring may not contact a model provider') } }))
})
afterEach(async () => { await controller.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
async function source() {
  const path = join(root, 'source.jsonl')
  await writeFile(join(root, 'input.txt'), 'private attachment')
  await writeFile(path, [
    { id: 'one', instruction: 'One', expected: 'SECRET_EXPECTED', family: 'alpha', attachments: ['input.txt'] },
    { id: 'two', instruction: 'Two', expected: 'B', family: 'beta' },
  ].map((row) => JSON.stringify(row)).join('\n'))
  return path
}
it('previews without changing project files, applies the frozen data and retries idempotently', async () => {
  const input = await source(), before = await readFile(join(project, 'gear.yaml'), 'utf8')
  const plan = await controller.invoke('benchmark.import', { source: input }) as { plan_id: string; splits: { seed: string[]; held_out: string[] } }
  expect(JSON.stringify(plan)).not.toContain('SECRET_EXPECTED')
  expect(await readFile(join(project, 'gear.yaml'), 'utf8')).toBe(before)
  expect(await readdir(project)).not.toContain('benchmarks')
  await writeFile(input, 'changed'); await writeFile(join(root, 'input.txt'), 'changed')
  const applied = await controller.invoke('benchmark.apply', { plan_id: plan.plan_id })
  expect(await controller.invoke('benchmark.apply', { plan_id: plan.plan_id })).toEqual(applied)
  const check = await controller.invoke('benchmark.check') as { splits: { seed: string[]; held_out: string[] } }
  expect(check.splits).toEqual({ seed: plan.splits.seed, held_out: plan.splits.held_out })
  const preview = await controller.invoke('benchmark.preview', { task_id: 'one' }) as { task: { resources: Array<{ content_base64: string }> }; scorer: { expected: string } }
  expect(preview.scorer.expected).toBe('SECRET_EXPECTED')
  expect(Buffer.from(preview.task.resources[0]!.content_base64, 'base64').toString()).toBe('private attachment')
  expect(await readFile(join(project, 'tasks.csv'), 'utf8')).toContain('sum-01')
})
it('rejects changed configuration, tampered plans and changed import destinations', async () => {
  const input = await source()
  const plan = await controller.invoke('benchmark.import', { source: input }) as { plan_id: string; destination: string }
  const before = await readFile(join(project, 'gear.yaml'), 'utf8')
  await writeFile(join(project, 'gear.yaml'), before + '\n# operator edit\n')
  await expect(controller.invoke('benchmark.apply', { plan_id: plan.plan_id })).rejects.toMatchObject({ code: 'import-config-conflict' })
  await writeFile(join(project, 'gear.yaml'), before)
  await controller.invoke('benchmark.apply', { plan_id: plan.plan_id })
  await writeFile(join(project, plan.destination, 'tasks.jsonl'), 'operator edit')
  await expect(controller.invoke('benchmark.apply', { plan_id: plan.plan_id })).rejects.toMatchObject({ code: 'import-content-conflict' })
  const path = join(project, '.gear/imports', `${plan.plan_id}.json`), saved = JSON.parse(await readFile(path, 'utf8'))
  saved.prepared.directory = '../../escape'; await writeFile(path, JSON.stringify(saved))
  await expect(controller.invoke('benchmark.apply', { plan_id: plan.plan_id })).rejects.toMatchObject({ code: 'import-plan-invalid' })
})
it('requires explicit research mode for one group and preserves error locations across Python transport', async () => {
  const input = join(root, 'one.jsonl')
  await writeFile(input, '\n' + JSON.stringify({ id: 'one', instruction: 'one', expected: 'x' }))
  await expect(controller.invoke('benchmark.import', { source: input })).rejects.toMatchObject({ code: 'authoring-error', details: { location: 'split' } })
  const plan = await controller.invoke('benchmark.import', { source: input, mode: 'research' }) as { plan_id: string }
  await controller.invoke('benchmark.apply', { plan_id: plan.plan_id })
  expect((await resolveProject(project)).config.validation.mode).toBe('research')
  await writeFile(input, '\n' + JSON.stringify({ id: 'one', instruction: '', expected: 'x' }))
  await expect(controller.invoke('benchmark.import', { source: input })).rejects.toMatchObject({ details: { location: 'one.jsonl:2:instruction' } })
})
it('preserves empty native build directories and refuses a changed directory tree on retry', async () => {
  const source = join(root, 'native')
  for (const id of ['one', 'two']) {
    const task = join(source, id)
    await mkdir(join(task, 'environment/inputs'), { recursive: true })
    await mkdir(join(task, 'tests'))
    await writeFile(join(task, 'task.toml'), 'version="1.0"\n')
    await writeFile(join(task, 'instruction.md'), `Solve ${id}`)
    await writeFile(join(task, 'environment/Dockerfile'), `FROM python@sha256:${'1'.repeat(64)}\nCOPY inputs/ /app/\n`)
    await writeFile(join(task, 'tests/test.sh'), 'printf 1 > /logs/verifier/reward.txt\n')
  }
  const plan = await controller.invoke('benchmark.import', { source, template: 'harbor' }) as { plan_id: string; destination: string }
  const applied = await controller.invoke('benchmark.apply', { plan_id: plan.plan_id })
  const inputs = join(project, plan.destination, 'tasks/one/environment/inputs')
  expect(await readdir(inputs)).toEqual([])
  expect(await controller.invoke('benchmark.apply', { plan_id: plan.plan_id })).toEqual(applied)
  await rm(inputs, { recursive: true })
  await expect(controller.invoke('benchmark.apply', { plan_id: plan.plan_id })).rejects.toMatchObject({ code: 'import-content-conflict' })
  await mkdir(inputs)
  await mkdir(join(inputs, 'unexpected'))
  await expect(controller.invoke('benchmark.apply', { plan_id: plan.plan_id })).rejects.toMatchObject({ code: 'import-content-conflict' })
})
