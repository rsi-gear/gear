// A bounded read-only Hitch page protocol fixture. No evaluation or model commands.
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
export async function trajectoryFixture(args = process.argv.slice(2)) {
  const take = name => { const index = args.indexOf(name); return index < 0 ? undefined : args.splice(index, 2)[1] }
  const root = take('--root'), limit = Number(take('--limit') ?? 20), maximum = Number(take('--max-bytes'))
  const digest = take('--canonical-sha256'), cursor = take('--cursor'), types = take('--types'), start = take('--seq-start'), end = take('--seq-end'), field = take('--field')
  args.splice(args.indexOf('--json'), 1)
  const [command, action, run] = args
  if (command !== 'trajectory' || action !== 'events' || !/^run_[a-f0-9]{32}$/.test(run)) throw new Error('Fixture forbids arbitrary commands and sources')
  await appendFile(join(root, 'calls.jsonl'), JSON.stringify({ run, limit, field: field ?? null }) + '\n')
  const raw = await readFile(join(root, run + '.json'), 'utf8')
  const current = 'sha256:' + createHash('sha256').update(raw).digest('hex')
  if (digest && digest !== current) { process.exitCode = 3; return }
  const mode = await readFile(join(root, 'mode'), 'utf8').catch(() => '')
  if (mode === 'hang') { await new Promise(resolve => setTimeout(resolve, 60000)); return }
  const filter = { ...(types ? { types: types.split(',') } : {}), ...(start === undefined ? {} : { seq_start: Number(start) }), ...(end === undefined ? {} : { seq_end: Number(end) }), ...(field ? { field } : {}) }
  const values = JSON.parse(raw).filter(event => (!types || types.split(',').includes(event.type)) && event.seq >= Number(start ?? 0) && event.seq <= Number(end ?? Number.MAX_SAFE_INTEGER))
  const offset = cursor === undefined ? 0 : Number(Buffer.from(cursor, 'base64url').toString())
  const events = values.slice(offset, offset + limit), eof = offset + events.length >= values.length
  const body = { schema_version: '1', kind: 'trajectory-events-page', run_id: mode === 'wrong-run' ? 'run_' + 'f'.repeat(32) : run,
    canonical_sha256: current, filter: mode === 'wrong-filter' ? { types: ['other'] } : filter, events, total_matches: values.length, eof,
    ...(eof ? {} : { next_cursor: Buffer.from(String(offset + events.length)).toString('base64url') }), private_provider_field: 'PRIVATE_CANARY' }
  if (mode === 'oversized') body.extra = 'x'.repeat(maximum + 1)
  const output = Buffer.from(JSON.stringify(body) + '\n')
  if (mode === 'split-utf8') {
    for (let index = 0; index < output.length; index++) {
      process.stdout.write(output.subarray(index, index + 1)); await new Promise(resolve => setImmediate(resolve))
    }
  } else process.stdout.write(output)
}
