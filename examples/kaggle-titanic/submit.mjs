#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicJson, cli, command, hash, isMain, parseCsv, readJson } from './common.mjs'

export function submissionMatch(csv, description) {
  if (csv.trim() === 'No submissions found') return undefined
  const [header, ...rows] = parseCsv(csv)
  if (!header?.includes('description') || !header.includes('ref') || new Set(header).size !== header.length
    || rows.some(row => row.length !== header.length || !row[header.indexOf('ref')]?.trim())) throw new Error('unsupported Kaggle submission listing; no automatic resubmit')
  const matches = rows.map(row => Object.fromEntries(header.map((key, i) => [key, row[i]]))).filter(row => row.description === description)
  if (matches.length > 1) throw new Error('ambiguous Kaggle submission identity')
  return matches[0]
}

export async function main(argv = process.argv.slice(2)) {
  const { values: v } = parseArgs({ args: argv, options: { finalization: { type: 'string' }, kaggle: { type: 'string', default: 'kaggle' }, status: { type: 'boolean' } } })
  if (!v.finalization) throw new Error('--finalization DIRECTORY is required')
  const directory = resolve(v.finalization), final = await readJson(join(directory, 'finalization.json'))
  if (final.status !== 'complete' || final.synthetic || final.competition !== 'titanic') throw new Error('only completed, real Titanic finalizations may be submitted')
  if (hash(await readFile(final.submissionFile)) !== final.submissionDigest) throw new Error('submission file changed')
  const path = join(directory, 'kaggle-submission.json'), description = `gear-${final.runId}-${final.submissionDigest.slice(7, 23)}`
  const query = async () => submissionMatch(await command(v.kaggle, ['competitions', 'submissions', '-c', 'titanic', '--csv']), description)
  let record
  try { record = await readJson(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (record && (record.description !== description || record.submissionDigest !== final.submissionDigest)) throw new Error('submission journal identity mismatch')
  if (!record && !v.status) {
    record = { schema_version: '1', status: 'unknown', description, candidateCommit: final.inputs.candidateCommit,
      submissionDigest: final.submissionDigest, runId: final.runId }
    // Reserve before POST. Even timeout/crash cannot cause a second POST on retry.
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    try { await command(v.kaggle, ['competitions', 'submit', '-c', 'titanic', '-f', final.submissionFile, '-m', description]) }
    catch (error) { await atomicJson(path, { ...record, error: 'submission reply unavailable; query status before any further action' }); throw error }
  }
  if (!record) throw new Error('no submission has been requested')
  const external = await query()
  if (external) record = { ...record, status: 'recorded', submissionId: external.ref, external }
  await atomicJson(path, record)
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
}
if (isMain(import.meta.url)) cli(main)
