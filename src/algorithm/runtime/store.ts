import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertDigest, sha256 } from '../artifacts.js';
import { assertJson, canonicalJson, type JsonValue } from '../schema.js';

type JournalRecord<T> = { seq: number; previous: string | null; event: string; state: T };
type Head = { seq: number; digest: string };
type Lease = { alive: boolean; pid?: number; send(request: string): Promise<void> };

// All journal writes happen in the kernel-lock holder. Its lock file is never
// unlinked, so a dead process leaves no stale-file election race.
const keeper = `import fcntl,hashlib,json,os,sys,time,uuid
lock,records,head=sys.argv[1:]
fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600)
end=time.monotonic()+5
while True:
 try:
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);break
 except BlockingIOError:
  if time.monotonic()>end:sys.exit(3)
  time.sleep(.02)
print('locked',flush=True)
def atomic(path,data):
 tmp=path+'.'+uuid.uuid4().hex+'.tmp'
 with open(tmp,'xb') as output:
  output.write(data);output.flush();os.fsync(output.fileno())
 os.replace(tmp,path)
 directory=os.open(os.path.dirname(path),os.O_RDONLY)
 try:os.fsync(directory)
 finally:os.close(directory)
for line in sys.stdin:
 try:
  request=json.loads(line)
  raw=request['record'].encode('utf-8')
  digest=hashlib.sha256(raw).hexdigest()
  if digest!=request['digest']:raise ValueError('record digest mismatch')
  record=json.loads(raw)
  previous=json.load(open(head)) if os.path.exists(head) else None
  if record['previous']!=(previous['digest'] if previous else None):raise ValueError('stale journal head')
  if record['seq']!=(previous['seq']+1 if previous else 0):raise ValueError('journal sequence mismatch')
  atomic(os.path.join(records,digest+'.json'),raw)
  atomic(head,json.dumps({'seq':record['seq'],'digest':digest},separators=(',',':')).encode('utf-8'))
  print(json.dumps({'ok':True}),flush=True)
 except Exception as error:
  print(json.dumps({'ok':False,'error':str(error)}),flush=True)
os.close(fd)
`;

export class CampaignStore<T extends JsonValue> {
  private readonly records: string;
  private readonly headPath: string;
  private readonly lockPath: string;
  private readonly context = new AsyncLocalStorage<Lease>();
  constructor(readonly root: string) {
    this.records = join(root, 'journal'); this.headPath = join(root, 'HEAD'); this.lockPath = join(root, 'WRITER.lock');
    mkdirSync(this.records, { recursive: true });
  }

  assertLease(): void { if (!this.context.getStore()?.alive) throw new Error('Campaign writer lease lost or absent'); }
  testingWriterProcessId(): number | undefined { return this.context.getStore()?.pid; }

  async withWriter<R>(work: () => Promise<R>): Promise<R> {
    if (this.context.getStore()) throw new Error('Nested campaign writer');
    const child = spawn(process.env.GEAR_ALGORITHM_LOCK_PYTHON || 'python3', ['-c', keeper, this.lockPath, this.records, this.headPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume(); child.stdin.on('error', () => {});
    let handshakeResolve!: () => void; let handshakeReject!: (error: Error) => void;
    const handshake = new Promise<void>((resolve, reject) => { handshakeResolve = resolve; handshakeReject = reject; });
    let pending: { resolve(): void; reject(error: Error): void } | null = null;
    let buffer = ''; let acquired = false;
    const lease: Lease = {
      alive: false,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      send: request => new Promise<void>((resolve, reject) => {
        if (!lease.alive || pending) { reject(new Error('Campaign writer lease unavailable')); return; }
        pending = { resolve, reject };
        child.stdin.write(`${request}\n`, error => { if (error && pending) { const current = pending; pending = null; current.reject(error); } });
      }),
    };
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const cut = buffer.indexOf('\n'); const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
        if (!acquired) { if (line !== 'locked') { handshakeReject(new Error('Campaign writer lock unavailable')); return; } acquired = true; lease.alive = true; handshakeResolve(); continue; }
        const current = pending; pending = null;
        if (!current) continue;
        try { const reply = JSON.parse(line) as { ok: boolean; error?: string }; if (reply.ok) current.resolve(); else current.reject(new Error(reply.error ?? 'Journal commit failed')); }
        catch (error) { current.reject(error as Error); }
      }
    });
    const closed = new Promise<void>(resolve => {
      child.once('close', () => { lease.alive = false; handshakeReject(new Error('Campaign writer lock unavailable')); if (pending) { pending.reject(new Error('Campaign writer lease lost')); pending = null; } resolve(); });
      child.once('error', error => { lease.alive = false; handshakeReject(new Error(`Python 3 with fcntl required for campaign lock: ${error.message}`)); if (pending) { pending.reject(error); pending = null; } resolve(); });
    });
    try {
      const timer = setTimeout(() => child.kill('SIGKILL'), 7_000);
      try { await handshake; } finally { clearTimeout(timer); }
      return await this.context.run(lease, work);
    } finally { lease.alive = false; child.stdin.end(); await closed; }
  }

  load(): { state: T; seq: number; digest: string } | null {
    if (!existsSync(this.headPath)) return null;
    const head = JSON.parse(readFileSync(this.headPath, 'utf8')) as Head;
    if (!Number.isSafeInteger(head.seq) || head.seq < 0) throw new Error('Corrupt journal head');
    assertDigest(head.digest);
    let digest: string | null = head.digest;
    let expected = head.seq;
    let latest: T | undefined;
    while (digest !== null) {
      assertDigest(digest);
      const raw = readFileSync(join(this.records, `${digest}.json`), 'utf8');
      if (sha256(raw) !== digest) throw new Error('Journal digest mismatch');
      const record = JSON.parse(raw) as JournalRecord<T>;
      assertJson(record);
      if (record.seq !== expected || typeof record.event !== 'string') throw new Error('Journal sequence mismatch');
      if (latest === undefined) latest = record.state;
      digest = record.previous;
      expected--;
    }
    if (expected !== -1 || latest === undefined) throw new Error('Incomplete journal chain');
    return { state: latest, seq: head.seq, digest: head.digest };
  }

  async commit(state: T, event: string): Promise<void> {
    this.assertLease(); assertJson(state);
    const previous = this.load();
    const record: JournalRecord<T> = { seq: previous === null ? 0 : previous.seq + 1, previous: previous?.digest ?? null, event, state };
    const serialized = canonicalJson(record);
    await this.context.getStore()!.send(canonicalJson({ record: serialized, digest: sha256(serialized) }));
  }
}
