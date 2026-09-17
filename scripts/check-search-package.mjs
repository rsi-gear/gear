import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), 'gear-search-consumer-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
function run(command, args, cwd) {
  try { return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180_000 }) }
  catch (error) { process.stderr.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error }
}
try {
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root))[0]
  const consumer = join(temporary, 'consumer')
  await cp(join(root, 'examples/parent-policy'), consumer, { recursive: true })
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  run(npm, ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', join(temporary, packed.filename), `@types/node@${metadata.devDependencies['@types/node']}`], consumer)
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, types: ['node'],
  }, include: ['*.mjs'] }))
  run(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', consumer], consumer)
  process.stdout.write(run(process.execPath, ['demo.mjs'], consumer))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
