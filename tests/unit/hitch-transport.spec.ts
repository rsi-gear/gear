import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { hitchJson } from '../../src/adapters/hitch/transport.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(mode = 'ordinary') {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-probe-')); roots.push(root)
  const executable = join(root, 'hitch.mjs')
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync, existsSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), root = args[1], nonce = args[args.indexOf('--nonce') + 1];
const log = value => appendFileSync(join(root, 'events.jsonl'), JSON.stringify(value)+'\\n');
const busy = () => { log({event:'busy',nonce}); process.stderr.write(JSON.stringify({schema_version:'1',kind:'error',error:{code:'execution_observation_busy',exit_code:12,message:'PRIVATE_DIAGNOSTIC'}})); process.exit(12); };
log({event:'call',command:args[2],nonce});
if(args[2]==='eval'||${JSON.stringify(mode)}==='always-busy') busy();
if(${JSON.stringify(mode)}==='busy-once'&&!existsSync(join(root,'seen'))){writeFileSync(join(root,'seen'),'1');busy();}
if(${JSON.stringify(mode)}==='other-error'){process.stderr.write('PRIVATE_DIAGNOSTIC');process.exit(12);}
try{closeSync(openSync(join(root,'probe.lock'),'wx'));}catch{busy();}
log({event:'start',nonce});
setTimeout(()=>{unlinkSync(join(root,'probe.lock'));log({event:'end',nonce});process.stdout.write(JSON.stringify({nonce}));},150);
`, { mode: 0o700 })
  return { root, executable, events: async () => (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}
const probe = (nonce: string) => ['worker', 'observe', 'local-docker', '--nonce', nonce, '--json']

it('coordinates fresh observations across simultaneous calls without reusing nonce responses', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const replies = await Promise.all(['a', 'b', 'c'].map(nonce => hitchJson(f.executable, f.root, probe(nonce), signal, 5000)))
  expect(replies).toEqual([{ nonce: 'a' }, { nonce: 'b' }, { nonce: 'c' }])
  const events = await f.events()
  expect(events.filter(e => e.event === 'busy')).toEqual([])
  expect(events.filter(e => e.event === 'start' || e.event === 'end').map(e => e.event)).toEqual(['start', 'end', 'start', 'end', 'start', 'end'])
})

it('retries only the structured read-only busy response within the original deadline', async () => {
  const f = await fixture('busy-once')
  expect(await hitchJson(f.executable, f.root, probe('fresh'), new AbortController().signal, 3000)).toEqual({ nonce: 'fresh' })
  expect((await f.events()).filter(e => e.event === 'call')).toHaveLength(2)
})

it.each(['always-busy', 'other-error'])('bounds failed observation %s and never exposes stderr', async mode => {
  const f = await fixture(mode), start = Date.now()
  await expect(hitchJson(f.executable, f.root, probe('fresh'), new AbortController().signal, 400)).rejects.toMatchObject({ code: 'hitch-call-failed', message: 'Hitch worker observe did not complete' })
  expect(Date.now() - start).toBeLessThan(2000)
  expect((await f.events()).filter(e => e.event === 'call')).toHaveLength(1)
})

it('never retries a submission even when its diagnostic reports the busy code', async () => {
  const f = await fixture()
  await expect(hitchJson(f.executable, f.root, ['eval', 'submit', '--json'], new AbortController().signal)).rejects.toMatchObject({ code: 'hitch-call-failed', message: 'Hitch eval submit did not complete' })
  expect((await f.events()).filter(e => e.event === 'call')).toHaveLength(1)
})

it('cancels a queued probe without dispatching it or dropping the preceding lock', async () => {
  const f = await fixture(), signal = new AbortController().signal, cancelled = new AbortController()
  const first = hitchJson(f.executable, f.root, probe('first'), signal, 5000)
  const second = hitchJson(f.executable, f.root, probe('cancelled'), cancelled.signal, 5000)
  const rejected = expect(second).rejects.toThrow('cancelled probe')
  cancelled.abort(new Error('cancelled probe'))
  await rejected
  const third = hitchJson(f.executable, f.root, probe('third'), signal, 5000)
  await Promise.all([first, third])
  expect((await f.events()).filter(e => e.event === 'call').map(e => e.nonce)).toEqual(['first', 'third'])
  expect((await f.events()).filter(e => e.event === 'busy')).toEqual([])
})

it('counts time waiting for the probe lock against the original call deadline', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const first = hitchJson(f.executable, f.root, probe('first'), signal, 5000)
  await expect(hitchJson(f.executable, f.root, probe('expired'), signal, 10)).rejects.toMatchObject({ code: 'hitch-call-failed' })
  await first
  // Let the expired queue position drain without spawning a child.
  await hitchJson(f.executable, f.root, probe('after'), signal, 5000)
  expect((await f.events()).filter(e => e.event === 'call').map(e => e.nonce)).toEqual(['first', 'after'])
})
