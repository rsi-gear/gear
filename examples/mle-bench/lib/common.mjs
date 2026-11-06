import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const exampleRoot = dirname(fileURLToPath(import.meta.url))
export const gearRoot = resolve(exampleRoot, '../../..')
export const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
export const identity = value => hash(canonical(value))
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
export async function atomicJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temp, path) }
  finally { await rm(temp, { force: true }) }
}
export async function command(executable, args, { cwd = gearRoot, env = process.env, signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', bytes = 0, overflow = false
    const collect = (stream, chunk) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxBytes) { overflow = true; child.kill('SIGKILL'); return }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk
    }
    child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk))
    child.once('error', reject)
    child.once('close', code => {
      if (overflow) return reject(new Error('command output exceeded limit'))
      if (code !== 0) { const error = new Error(`${executable} failed (${code}): ${(stderr || stdout).slice(-2000)}`); error.stdout = stdout; error.exitCode = code; return reject(error) }
      accept(stdout.trim())
    })
  })
}
export async function hitchJson(config, args, options) {
  return JSON.parse(await command(config.hitch.executable, ['--root', config.hitch.root, ...args], options))
}
export async function requireArtifacts(config) {
  if (config.hitch.controlPlane?.mode && config.hitch.controlPlane.mode !== 'direct') throw new Error('Kaggle example currently requires Hitch direct mode')
  const value = await hitchJson(config, ['capabilities', '--json'])
  if (value.schema_version !== '1' || value.run_output_artifacts !== '1'
    || value.run_output_artifact_backends !== undefined && (!Array.isArray(value.run_output_artifact_backends) || !value.run_output_artifact_backends.includes('local-docker'))) throw new Error('Hitch run-output-artifacts@1 is required; build the matching Hitch version')
}
export function isMain(url) {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)) } catch { return false }
}
export function cli(main) { main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }) }

export const objective = { terms: [{ metric: 'total_score', weight: 1 }], constraints: [{ metric: 'valid_output', rule: 'minimum', value: 1 }] }
export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false, closed = false
  const pushField = () => { row.push(field); field = ''; closed = false }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') { quoted = false; closed = true } else field += c
    } else if (c === ',' || c === '\n' || c === '\r') {
      pushField()
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++ }
    } else if (c === '"' && !field && !closed) quoted = true
    else { if (closed || c === '"') throw new Error('malformed CSV'); field += c }
  }
  if (quoted) throw new Error('unterminated CSV quote')
  if (field || row.length || closed) { pushField(); rows.push(row) }
  return rows
}

export function validateSubmission(bytes, schema) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('submission exceeds limit')
  const rows = parseCsv(bytes.toString('utf8'))
  if (JSON.stringify(rows.shift()) !== JSON.stringify([schema.id_column, schema.target_column])) throw new Error('unexpected submission columns')
  const expected = new Set(schema.expected_ids.map(String))
  if (expected.size !== schema.rows || rows.length !== expected.size) throw new Error('submission row count mismatch')
  for (const row of rows) {
    if (row.length !== 2 || !expected.delete(row[0]) || !schema.allowed_labels.map(String).includes(row[1])) throw new Error('invalid submission ID or label')
  }
  if (expected.size) throw new Error('missing submission IDs')
}
