// Global installation must keep resolving: local installs only warn on peer
// conflicts, so the published dependency ranges once shipped an ERESOLVE that
// broke `npm install -g rsi-gear` (issue #96).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const source = resolve(import.meta.dirname, '..'), root = mkdtempSync(join(tmpdir(), 'gear-global-install-'))
try {
  // The build has already produced lib/, so the pack skips the prepack hook.
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))[0]
  const install = spawnSync('npm', ['install', '--global', '--prefix', join(root, 'global'), '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(install.status, 0, `Global installation of the packed tarball failed:\n${install.stderr}`)
  process.stdout.write('Global installation of the packed tarball passed\n')
} finally { rmSync(root, { recursive: true, force: true }) }
