import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const version = '0.1.1-rc.2'
const integrity = 'sha512-llX8AWbaI3CGme/a2eeTSfy5atk8u3iJeOFzmZV/KZ0v0hMhKZIK1xQInWwC9OmSDJ/StStJe0hDPVLWbB7hVg=='
const directory = await mkdtemp(join(tmpdir(), 'gear-tool-fs-'))

try {
  // npm's content-addressed cache avoids downloading the pinned archive on every build.
  // Even during a parent pack --dry-run, this input archive must exist for integrity verification.
  const packed = JSON.parse(execFileSync('npm', [
    'pack', `@deepseek-ai/dsh-tool-fs@${version}`, '--ignore-scripts',
    '--prefer-offline', '--dry-run=false', '--json', '--pack-destination', directory,
  ], { cwd: root, encoding: 'utf8' }))
  const archive = join(directory, packed[0].filename)
  const bytes = await readFile(archive)
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) {
    throw new Error('ToolFs source archive does not match the pinned integrity')
  }
  const extract = path => execFileSync('tar', ['-xOf', archive, `package/${path}`], { encoding: 'utf8' })
  const original = extract('lib/index.js')
  const before = 'ctx.inject(["attachments"], (imageCtx) => {'
  const after = 'ctx.inject(["attachments", "fs"], (imageCtx) => {'
  if (original.split(before).length !== 2) throw new Error('ToolFs fs injection patch no longer matches once')

  await build({
    stdin: { contents: original.replace(before, after), resolveDir: root, sourcefile: `dsh-tool-fs-${version}.js` },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // Keep the host's DSH service identities. Only ToolFs and its own diff version are bundled.
    external: ['@deepseek-ai/*'],
    alias: { diff: 'gear-tool-fs-diff' },
    outfile: join(root, 'assets/gear-tool-fs.js'),
    banner: { js: `// Gear private ToolFs ${version}; read_image explicitly injects fs. See gear-tool-fs.LICENSE.` },
  })
  const diffRoot = dirname(fileURLToPath(import.meta.resolve('gear-tool-fs-diff/package.json')))
  const diffLicense = await readFile(join(diffRoot, 'LICENSE'), 'utf8')
  await writeFile(join(root, 'assets/gear-tool-fs.LICENSE'),
    `@deepseek-ai/dsh-tool-fs ${version}\n${extract('LICENSE')}\nBundled diff 9.0.0\n${diffLicense}`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
