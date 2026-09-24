// Real FICLONE and EXDEV acceptance on an isolated XFS loopback filesystem.
// Uses only newly owned containers/files; never formats an existing device.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const docker = process.env.GEAR_CANARY_DOCKER ?? 'docker'
const directory = await mkdtemp(join(tmpdir(), 'gear-clone-filesystem-'))
const helper = `gear-clone-helper-${randomUUID()}`, seed = `gear-clone-node-${randomUUID()}`
const run = (args, input) => new Promise((resolve, reject) => {
  const child = spawn(docker, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', c => { stdout = (stdout + c).slice(-1_000_000) }); child.stderr.on('data', c => { stderr = (stderr + c).slice(-8192) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(`docker ${args[0]} failed: ${stderr || stdout}`)) })
  if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input) }
})
const program = `
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, stat, statfs } from 'node:fs/promises';
import { materializeTrees } from './materialize.mjs';
import { digestDatasetRef } from './dataset.mjs';
const root='/fixture', source=root+'/source', signal=new AbortController().signal;
await mkdir(source); await mkdir(source+'/empty');
await writeFile(source+'/data',randomBytes(16*1024**2)); await writeFile(source+'/run',randomBytes(16*1024**2),{mode:0o755});
const digest=await digestDatasetRef(source);
const free=async()=>{execFileSync('/bin/sync');const s=await statfs(root,{bigint:true});return Number(s.bavail*s.bsize)};
const reports={}, delta={}, allocationSamples={}, peakObservedBytes={};
for(const mode of ['require-clone','copy']) {
  const before=await free(); reports[mode]=[]; allocationSamples[mode]=[0];
  let sampling=false; const sample=async()=>{const s=await statfs(root,{bigint:true});allocationSamples[mode].push(before-Number(s.bavail*s.bsize))};
  const timer=setInterval(()=>{if(sampling)return;sampling=true;sample().finally(()=>{sampling=false})},5);
  try {for(let i=0;i<3;i++) {const destination=root+'/'+mode+'-'+i;const report=await materializeTrees([{source,destination}],{signal,policy:{mode,minFreeBytes:64*1024**2}}); reports[mode].push(report); if(await digestDatasetRef(destination)!==digest) throw Error('materialized digest changed'); await sample();}}
  finally {clearInterval(timer);while(sampling)await new Promise(resolve=>setTimeout(resolve,1));}
  delta[mode]=before-await free();
  allocationSamples[mode].push(delta[mode]);peakObservedBytes[mode]=Math.max(...allocationSamples[mode]);
  const a=root+'/'+mode+'-0', b=root+'/'+mode+'-1';
  const files=await Promise.all([source+'/data',a+'/data',b+'/data'].map(p=>stat(p)));
  if(new Set(files.map(s=>s.ino)).size!==3) throw Error('shared inode');
  await writeFile(a+'/data','private A'); if(await digestDatasetRef(source)!==digest||await digestDatasetRef(b)!==digest) throw Error('write isolation failed');
  for(let i=0;i<3;i++) await rm(root+'/'+mode+'-'+i,{recursive:true});
}
const automatic=await materializeTrees([{source,destination:root+'/auto'}],{signal,policy:{mode:'auto'}});
if(automatic.copiedLogicalBytes!==0||automatic.clonedLogicalBytes!==32*1024**2) throw Error('auto did not actually clone');
const cross=await materializeTrees([{source,destination:'/cross/fallback'}],{signal,policy:{mode:'auto'}});
if(cross.fallbackReasons.EXDEV!==2||cross.copiedLogicalBytes!==32*1024**2||await digestDatasetRef('/cross/fallback')!==digest) throw Error('real cross-device fallback mismatch');
let rejected=false; try {await materializeTrees([{source,destination:'/cross/required'}],{signal,policy:{mode:'require-clone'}})} catch(e) {if(e.code!=='EXDEV') throw e;rejected=true}
if(!rejected) throw Error('cross-device require-clone unexpectedly succeeded');
await writeFile('/cross/fallback/data','cross mutation'); if(await digestDatasetRef(source)!==digest||await digestDatasetRef(root+'/auto')!==digest) throw Error('cross-device isolation failed');
await writeFile(source+'/data','source mutation'); if(await digestDatasetRef(root+'/auto')!==digest) throw Error('source changed clone');
console.log(JSON.stringify({protocol:'gear-clone-filesystem-canary@1',filesystem:'XFS reflink=1',node:process.version,digest,reports,automatic,cross,physicalDeltaBytes:delta,peakObservedBytes,allocationSamples,cloneToCopyPhysicalRatio:delta['require-clone']/delta.copy,writeIsolation:true,crossDeviceRequireCloneRejected:true,measurement:'statfs available bytes on an exclusively owned 1 GiB loopback filesystem; three 32 MiB projections per mode; final delta after sync; peak sampled every 5 ms and after each projection, may miss shorter transients; metadata included'},null,2));
`
try {
  const helperImage = await run(['image', 'inspect', process.env.GEAR_CANARY_FS_IMAGE ?? 'mirror.gcr.io/library/docker:27-dind', '--format', '{{.Id}}'])
  const nodeImage = await run(['image', 'inspect', process.env.GEAR_CANARY_NODE_IMAGE ?? 'node:22.23.0-bookworm-slim', '--format', '{{.Id}}'])
  await run(['run', '-d', '--privileged', '--name', helper, '--entrypoint', 'sh', helperImage, '-c', 'while :; do sleep 3600; done'])
  await run(['create', '--name', seed, nodeImage, '/bin/true'])
  await run(['exec', helper, 'mkdir', '-p', '/node', '/fixture'])
  const exporter = spawn(docker, ['export', seed], { stdio: ['ignore', 'pipe', 'pipe'] })
  const importer = spawn(docker, ['exec', '-i', helper, 'tar', '-C', '/node', '-xf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
  let errors = ''; exporter.stderr.on('data', c => { errors = (errors + c).slice(-8192) }); importer.stderr.on('data', c => { errors = (errors + c).slice(-8192) })
  exporter.stdout.pipe(importer.stdin); importer.stdin.on('error', () => exporter.kill())
  const timer = setTimeout(() => { exporter.kill('SIGKILL'); importer.kill('SIGKILL') }, 240_000)
  const wait = child => new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(errors)))})
  const pending = [wait(exporter),wait(importer)]
  try { await Promise.all(pending) } catch(error) { exporter.kill('SIGKILL'); importer.kill('SIGKILL'); await Promise.allSettled(pending); throw error } finally { clearTimeout(timer) }
  await run(['exec', helper, 'sh', '-ceu', 'truncate -s 1G /owned-xfs.img; mkfs.xfs -m reflink=1 /owned-xfs.img; mount -o loop /owned-xfs.img /fixture; mkdir -p /node/fixture /node/cross; mount --bind /fixture /node/fixture; mount -t tmpfs -o size=128m tmpfs /node/cross'])
  for (const [target, contents] of [['materialize.mjs', await readFile(new URL('../lib/state/materialize-tree.js', import.meta.url))], ['dataset.mjs', await readFile(new URL('../lib/state/dataset.js', import.meta.url))], ['canary.mjs', program]]) {
    await run(['exec', '-i', helper, 'sh', '-c', `cat > /node/${target}`], contents)
  }
  const result = JSON.parse(await run(['exec', helper, 'chroot', '/node', '/usr/local/bin/node', '/canary.mjs']))
  await writeFile(join(directory,'result.json'), JSON.stringify({...result,helperImage,nodeImage},null,2))
  console.log(JSON.stringify({directory,...result}))
  if(result.physicalDeltaBytes.copy<=0||result.cloneToCopyPhysicalRatio>0.2) throw Error('isolated physical clone delta exceeded 20% gate; measurements retained in result.json')
} catch(error) {
  await writeFile(join(directory,'failure.txt'),String(error)); throw error
} finally {
  await run(['exec', helper, 'sh', '-c', 'umount /node/cross; umount /node/fixture; umount /fixture']).catch(()=>{})
  for (const name of [seed,helper]) await run(['rm','-f','-v',name]).catch(()=>{})
  console.error('Canary artifacts: '+directory)
}
