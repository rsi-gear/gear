import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { dump } from 'js-yaml'
import { assertProfileRole, defaultProfiles, profile } from './profile-store.js'
import { harnessAdapter } from './harness-adapters.js'

export async function initProject(
  destination: string,
  options: {
    adapter?: 'dsh' | 'pi'
    template?: 'text' | 'files'
    targetProfile?: string
    metaProfile?: string
  } = {},
) {
  const defaults = await defaultProfiles()
  const targetName = options.targetProfile ?? defaults.target,
    metaName = options.metaProfile ?? defaults.meta
  const targetProfile = targetName ? await profile(targetName) : undefined
  const root = resolve(destination),
    adapter =
      options.adapter ??
      (targetProfile &&
      'kind' in targetProfile &&
      targetProfile.kind === 'hitch' &&
      targetProfile.harnessRef.startsWith('pi@')
        ? 'pi'
        : 'dsh'),
    template = options.template ?? 'text'
  if (targetProfile) assertProfileRole(targetProfile, 'target', adapter)
  if (metaName) assertProfileRole(await profile(metaName), 'meta')
  await mkdir(root, { recursive: false })
  const config = {
    version: 1,
    benchmark: './benchmark.yaml',
    target: { adapter, path: './target', profile: targetName ?? 'default-target' },
    meta: { profile: metaName ?? 'default-meta' },
    algorithm: 'gepa',
    objective: { metric: 'pass_rate' },
    validation: { mode: 'holdout' },
    budget: { rounds: 1, max_evaluations: 40 },
  }
  await writeFile(join(root, 'gear.yaml'), dump(config, { flowLevel: 1, lineWidth: 100 }), { flag: 'wx' })
  await writeFile(
    join(root, 'benchmark.yaml'),
    dump({
      version: 1,
      source: './tasks.csv',
      template,
      ...(template === 'text' ? { normalization: { trim: true } } : {}),
    }),
    { flag: 'wx' },
  )
  const rows =
    template === 'text'
      ? [
          ['sum-01', 'Output only the result of 2 plus 3.', '5', 'arithmetic', 'seed'],
          ['sum-02', 'Output only the result of 4 plus 5.', '9', 'arithmetic', 'seed'],
          ['word-01', 'Output the uppercase form of apple.', 'APPLE', 'case-conversion', 'held_out'],
          ['word-02', 'Output the uppercase form of berry.', 'BERRY', 'case-conversion', 'held_out'],
        ]
      : [
          ['file-01', 'Create result.txt containing exactly 5.', '{"result.txt":"5"}', 'numbers', 'seed'],
          [
            'file-02',
            'Create result.txt containing exactly APPLE.',
            '{"result.txt":"APPLE"}',
            'words',
            'held_out',
          ],
        ]
  const csv =
    [['id', 'instruction', 'expected', 'family', 'split'], ...rows]
      .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
      .join('\n') + '\n'
  await writeFile(join(root, 'tasks.csv'), csv, { flag: 'wx' })
  const target = harnessAdapter(adapter)
  await target.prepare(join(root, 'target'))
  return {
    root,
    target: target.describe(),
    profiles: { target: config.target.profile, meta: config.meta.profile },
    next_action: 'gear benchmark check',
    statistical_note: 'Demonstration tasks only; replace with your benchmark before drawing conclusions.',
  }
}
