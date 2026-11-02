import { describe, expect, it, vi } from 'vitest'
import pkg from '../../package.json' with { type: 'json' }
import { main } from '../../src/cli.js'
const { version } = pkg

const capture = () => {
  const writes: string[] = []
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
  return { writes, restore: () => spy.mockRestore() }
}

describe('gear version', () => {
  it('reports the package version with --version', async () => {
    const { writes, restore } = capture()
    await main(['--version'])
    restore()
    expect(writes.join('')).toBe(`gear ${version}\n`)
  })

  it('reports the package version with the version subcommand', async () => {
    const { writes, restore } = capture()
    await main(['version'])
    restore()
    expect(writes.join('')).toBe(`gear ${version}\n`)
  })

  it('rejects unknown top-level commands with a clear error', async () => {
    await expect(main(['frobnicate'])).rejects.toMatchObject({
      code: 'unknown-cli-command',
      message: `Unknown command: frobnicate. Run 'gear' for usage.`,
    })
  })

  it('prints usage when no command is given', async () => {
    const { writes, restore } = capture()
    await main([])
    restore()
    expect(writes.join('')).toContain(`gear version`)
    expect(writes.join('')).toContain(`serve [--socket PATH]`)
  })
})
