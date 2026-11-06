import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../../src/adapters/codex/runner.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { CodexInput } from '../../src/adapters/codex/contracts.js'

vi.mock('../../src/adapters/codex/identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/codex/identity.js')>()
  return {
    ...actual,
    describeCodex: vi.fn(async () => ({
      identity: `sha256:${'1'.repeat(64)}`,
      executable: '/test/codex',
      version: 'codex-cli 0.0.0',
    })),
  }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function stdin(chunks: Buffer[]) {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(chunks) as typeof process.stdin)
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
}

it.each([
  { character: '—', split: 1 },
  { character: '—', split: 2 },
  { character: '🧭', split: 2 },
])(
  'preserves admission identity when UTF-8 $character is split at byte $split',
  async ({ character, split }) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-meta-utf8-'))
    roots.push(root)
    const input: CodexInput = {
      version: 1,
      action: 'prepare_admission',
      request: null,
      configuration: {
        executable: '/test/codex',
        model: 'test-model',
        allowedDomains: ['chatgpt.com'],
        timeoutMs: 1000,
      },
      context: {
        runId: 'run_utf8',
        directory: join(root, 'operations'),
        targets: join(root, 'targets'),
        targetAdapter: 'dsh',
        protectedPaths: [root],
        tasks: [{ id: 'seed', family: 'support', instruction: 'x'.repeat(150_000) + character }],
      },
      implementationIdentity: `sha256:${'1'.repeat(64)}`,
    }
    const bytes = Buffer.from(JSON.stringify(input))
    const boundary = bytes.indexOf(Buffer.from(character)) + split
    stdin([bytes.subarray(0, boundary), bytes.subarray(boundary)])

    await main([])

    const journal = JSON.parse(await readFile(join(input.context.directory, 'operations.json'), 'utf8'))
    expect(journal.identity).toBe(
      canonicalDigest({
        configuration: input.configuration,
        context: input.context,
        implementationIdentity: input.implementationIdentity,
      }),
    )
    expect(journal.operations).toEqual({})
  },
)

it('rejects stdin above the 16 MiB byte limit before parsing or admitting it', async () => {
  stdin([Buffer.alloc(16 * 1024 * 1024, 'x'), Buffer.from('x')])
  await expect(main([])).rejects.toThrow('Meta request exceeds 16 MiB')
})
