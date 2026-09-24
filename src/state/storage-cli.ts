import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditStorage } from './storage.js'
import { releaseUnusedResourceRetention } from './resource-retention.js'

export async function storageCommand(argv: string[]): Promise<unknown> {
  const args = [...argv], action = args.shift()
  const take = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; args.splice(index, 2); return value }
  const root = take('--state-root'); if (!root) throw new Error('storage requires --state-root EVOLUTION_STATE_ROOT')
  if (action === 'release-resources') {
    const hitchRoot = take('--hitch-root'), executable = take('--hitch') ?? 'hitch', partition = take('--partition')
    if (!hitchRoot || !['seed', 'held-out'].includes(partition ?? '') || args.length) throw new Error('release-resources requires --hitch-root and --partition seed|held-out')
    return releaseUnusedResourceRetention(root, partition as 'seed' | 'held-out', async input => {
      const temporary = await mkdtemp(join(tmpdir(), 'gear-resource-release-'))
      try {
        const file = join(temporary, 'request.json'); await writeFile(file, JSON.stringify(input), { mode: 0o600 })
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable, ['--root', hitchRoot, 'resources', 'request', 'release', '--input', file], { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''
          child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 8192) stderr = stderr.slice(-8192) })
          child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Hitch resource release failed: ${stderr}`)))
        })
      } finally { await rm(temporary, { recursive: true, force: true }) }
    })
  }
  const apply = args.includes('--apply'); if (apply) args.splice(args.indexOf('--apply'), 1)
  if (!['inspect', 'cleanup'].includes(action ?? '') || args.length || apply && action !== 'cleanup') throw new Error('storage inspect|cleanup --state-root DIRECTORY [--apply]')
  return auditStorage(root, { apply })
}
