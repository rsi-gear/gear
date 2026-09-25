#!/usr/bin/env node
/** Full-Campaign A0 author benchmark. Run after `npm run build`.
 *
 * The first process stops just after the final nonterminal intent commit. A
 * second controller process loads that exact Campaign and reaches terminal.
 * All samples use durable journal/CAS and the same counted fake providers.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const cwd = resolve(import.meta.dirname, '..');
const protocolPath = join(cwd, 'docs/experiments/author-a0-benchmark-protocol-20260926.json');
const protocol = JSON.parse(fs.readFileSync(protocolPath, 'utf8'));
const interpreter = process.env.GEAR_AUTHOR_BENCH_PYTHON ?? '/opt/homebrew/bin/python3.11';
const expected = { composite: { F: 12, O: 156 }, rho_shaped: { F: 19, O: 163 } };
const modes = ['low-level', 'typescript', 'python'];
const graphs = ['composite', 'rho_shaped'];
const readRoot = { path: null, bytes: 0 };

function sourceIdentity() {
  const sourceFiles = [];
  const visit = path => {
    for (const item of fs.readdirSync(join(cwd, path), { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isDirectory()) visit(child);
      else if (item.isFile() && /\.(?:ts|js|py)$/.test(item.name)) sourceFiles.push(child);
    }
  };
  for (const directory of ['src/algorithm', 'lib/algorithm', 'packages/python-sdk/src/gear_algorithm'])
    visit(directory);
  sourceFiles.push('scripts/benchmark-author-a0.mjs', 'scripts/benchmark-author-a0-supervisor.py',
    'packages/python-sdk/tests/fixtures/author_benchmark.py',
    'tests/fixtures/algorithm-author-benchmark.mjs',
    'docs/experiments/author-a0-benchmark-protocol-20260926.json',
    'package.json', 'package-lock.json', 'packages/python-sdk/pyproject.toml');
  const sha256 = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  const sourceFileSha256 = Object.fromEntries(sourceFiles.sort().map(path => [path, sha256(join(cwd, path))]));
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const gitDirtyPaths = execFileSync('git', ['status', '--porcelain=v1', '-uall'],
    { cwd, encoding: 'utf8' }).trimEnd().split('\n').filter(Boolean);
  return { gitHead, gitDirtyPaths, sourceFileSha256,
    protocolSha256: sourceFileSha256['docs/experiments/author-a0-benchmark-protocol-20260926.json'],
    nodeExecutable: fs.realpathSync(process.execPath), nodeExecutableSha256: sha256(fs.realpathSync(process.execPath)),
    pythonExecutable: fs.realpathSync(interpreter), pythonExecutableSha256: sha256(fs.realpathSync(interpreter)) };
}

function installReadCounter() {
  const original = fs.readFileSync;
  fs.readFileSync = function counted(path, ...rest) {
    const data = original.call(this, path, ...rest);
    const filename = typeof path === 'string' ? resolve(path) : null;
    if (filename && readRoot.path && (filename.startsWith(join(readRoot.path, 'artifacts') + '/')
      || filename.startsWith(join(readRoot.path, 'campaign') + '/'))) {
      readRoot.bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    }
    return data;
  };
  syncBuiltinESMExports();
}

const address = (graph, round, candidate, suffix) => {
  const parallel = graph === 'composite' ? 4 + 5 * round : 5 + 7 * round;
  return `r/s${parallel}/p${candidate}/s0/${suffix}`;
};
const localKey = path => `a.${path.replaceAll('/', '.')}`;
function journalStats(root) {
  const directory = join(root, 'campaign', 'journal');
  const records = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.json')) : [];
  return { journalRecords: records.length,
    journalBytes: records.reduce((size, name) => size + fs.statSync(join(directory, name)).size, 0) };
}
const op = (path, kind, input) => ({ localKey: localKey(path), kind, input, limits: {},
  startsBudgetClock: kind !== 'author.checkpoint' });
const roleOps = (graph, round) => Array.from({ length: 4 }, (_, candidate) =>
  op(address(graph, round, candidate, 's0'), 'author.role',
    { name: 'bench-role', input: { round, candidate } }));
const editOps = (graph, round, completed) => Array.from({ length: 4 }, (_, candidate) =>
  op(address(graph, round, candidate, 's1'), 'author.edit',
    { round, candidate, role: value(completed, address(graph, round, candidate, 's0')) }));
const rolloutOps = (graph, round, completed) => Array.from({ length: 4 }, (_, candidate) =>
  Array.from({ length: 10 }, (_, task) => op(address(graph, round, candidate, `s12/p${task}/s0`),
    'author.rollout', { round, candidate, task,
      revision: value(completed, address(graph, round, candidate, 's1')).revision }))).flat();
const measureOps = (graph, round, completed) => Array.from({ length: 4 }, (_, candidate) =>
  op(address(graph, round, candidate, 's13'), 'author.measure', { round, candidate,
    rollouts: Array.from({ length: 10 }, (_, task) => ({ ok: true,
      value: value(completed, address(graph, round, candidate, `s12/p${task}/s0`)) })) }));
function value(completed, path) {
  const outcome = completed[localKey(path)];
  if (!outcome || outcome.kind !== 'result') throw new Error(`Missing benchmark result at ${path}`);
  return outcome.value;
}
function measured(graph, round, completed) {
  return Array.from({ length: 4 }, (_, candidate) => ({ ok: true,
    value: value(completed, address(graph, round, candidate, 's13')) }));
}
function lowLevelAlgorithm(graph, sha256, apiVersion, bindingSchema) {
  const describe = () => ({ id: `a0-${graph}`, apiVersion,
    implementationDigest: sha256(`low-level-author-benchmark.${graph}.v1`),
    stateSchema: { type: 'object', additionalProperties: true },
    configSchema: { type: 'object', additionalProperties: true }, bindingSchema,
    requiredOperationKinds: ['author.role', 'author.edit', 'author.rollout', 'author.measure',
      ...(graph === 'rho_shaped' ? ['author.rank', 'author.checkpoint'] : [])] });
  const group = (state, stage, operations) => ({ nextState: { ...state, stage }, operations });
  const first = graph === 'rho_shaped'
    ? group({ round: 0 }, 'initial', [op('r/s0', 'author.measure', { initial: true })])
    : group({ round: 0 }, 'role', roleOps(graph, 0));
  return {
    describe,
    initialize: () => first,
    reduce: context => {
      const state = context.state;
      const round = state.round;
      const completed = context.completed;
      if (state.stage === 'initial') return group({ round }, 'role', roleOps(graph, round));
      if (state.stage === 'role') return group({ round }, 'edit', editOps(graph, round, completed));
      if (state.stage === 'edit') return group({ round }, 'rollout', rolloutOps(graph, round, completed));
      if (state.stage === 'rollout') return group({ round }, 'measure', measureOps(graph, round, completed));
      if (state.stage === 'measure') {
        if (graph === 'rho_shaped') {
          const path = `r/s${6 + 7 * round}`;
          return group({ round }, 'rank', [op(path, 'author.rank', { round,
            measurements: measured(graph, round, completed) })]);
        }
        return round === 2 ? { nextState: { round, stage: 'done' }, complete: true }
          : group({ round: round + 1 }, 'role', roleOps(graph, round + 1));
      }
      if (state.stage === 'rank') {
        const rank = value(completed, `r/s${6 + 7 * round}`);
        return group({ round }, 'checkpoint', [op(`r/s${7 + 7 * round}`, 'author.checkpoint',
          { name: 'population', value: { round, rank }, schema: 'author.archive.v1' })]);
      }
      if (state.stage === 'checkpoint') return round === 2
        ? { nextState: { round, stage: 'done' }, complete: true }
        : group({ round: round + 1 }, 'role', roleOps(graph, round + 1));
      throw new Error(`Unknown low-level benchmark stage ${state.stage}`);
    },
  };
}

function psRows(output) {
  const rows = new Map();
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)$/);
    if (!match) continue;
    const parts = match[4].split(':').map(Number);
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + part;
    rows.set(Number(match[1]), { parent: Number(match[2]), rss: Number(match[3]) * 1024,
      cpuMs: seconds * 1000 });
  }
  return rows;
}
function watchTree(rootPid) {
  let peakRssBytes = 0;
  const cpuByPid = new Map();
  let samples = 0;
  let active = true;
  let pending = false;
  const sample = () => {
    if (!active || pending) return;
    pending = true;
    execFile('ps', ['-axo', 'pid=,ppid=,rss=,time='], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      pending = false;
      if (error || !active) return;
      const rows = psRows(stdout);
      const descendants = new Set([rootPid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, row] of rows) if (!descendants.has(pid) && descendants.has(row.parent)) {
          descendants.add(pid); changed = true;
        }
      }
      let rss = 0;
      for (const pid of descendants) {
        const row = rows.get(pid);
        if (!row) continue;
        rss += row.rss;
        cpuByPid.set(pid, Math.max(cpuByPid.get(pid) ?? 0, row.cpuMs));
      }
      peakRssBytes = Math.max(peakRssBytes, rss);
      samples++;
    });
  };
  const timer = setInterval(sample, 25);
  sample();
  return () => { active = false; clearInterval(timer);
    return { peakRssBytes: samples ? peakRssBytes : null,
      cpuMsLowerBound: samples ? [...cpuByPid.values()].reduce((a, b) => a + b, 0) : null,
      samples, intervalMs: 25, quality: 'sampled lower bound; short-lived workers may be missed' };
  };
}

async function runChild(args) {
  const [mode, graph, root, phase] = args;
  if (!modes.includes(mode) || !graphs.includes(graph) || !['before', 'after'].includes(phase))
    throw new Error('Invalid benchmark child arguments');
  if (!fs.existsSync(interpreter)) throw new Error(`Supported Python interpreter missing: ${interpreter}`);
  process.env.GEAR_ALGORITHM_LOCK_PYTHON = interpreter;
  readRoot.path = resolve(root);
  installReadCounter();
  const [{ sha256, FileArtifactStore }, { BindingStore }, { AlgorithmRuntime },
    { LocalDurableProvider }, { CampaignStore }, { ALGORITHM_API_VERSION },
    { AuthorAlgorithmAdapter }, { AuthorObserveProvider, AuthorCheckpointProvider },
    { AuthorProcessReplayPort }, { createPythonAuthorReplayPort }, { jsonDigest }] = await Promise.all([
    import('../lib/algorithm/artifacts.js'), import('../lib/algorithm/bindings.js'),
    import('../lib/algorithm/runtime/engine.js'), import('../lib/algorithm/runtime/providers.js'),
    import('../lib/algorithm/runtime/store.js'), import('../lib/algorithm/contracts.js'),
    import('../lib/algorithm/author/adapter.js'), import('../lib/algorithm/author/providers.js'),
    import('../lib/algorithm/author/process-port.js'), import('../lib/algorithm/author/python-port.js'),
    import('../lib/algorithm/schema.js'),
  ]);
  const startedAt = performance.now();
  let pythonPort;
  try {
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindings = new BindingStore(artifacts, { id: 'author-benchmark.bindings.v1', slots: {} });
  const bindingSchema = { id: 'author-benchmark.bindings.v1', slots: {} };
  const initialBindingSetRef = bindings.create({});
  const store = new CampaignStore(join(root, 'campaign'));
  const metrics = { F: 0, O_pure: 0, O_physical: 0, intents: [], workerReplayWallMs: 0 };
  let algorithm;
  if (mode === 'low-level') algorithm = lowLevelAlgorithm(graph, sha256, ALGORITHM_API_VERSION, bindingSchema);
  else {
    const port = mode === 'typescript'
      ? new AuthorProcessReplayPort(resolve(cwd, 'tests/fixtures/algorithm-author-benchmark.mjs'),
        graph, resolve(cwd, 'lib/algorithm/author/worker-entry.js'))
      : await createPythonAuthorReplayPort({ configDir: resolve(cwd, 'packages/python-sdk/tests/fixtures'),
        module: 'author_benchmark.py', export: graph, interpreter,
        sdkPath: resolve(cwd, 'packages/python-sdk/src'), timeoutMs: 30000 });
    if (mode === 'python') pythonPort = port;
    const replay = async request => {
      const before = performance.now();
      try { return await (mode === 'typescript' ? port.replay(request) : port(request)); }
      finally { metrics.workerReplayWallMs += performance.now() - before; }
    };
    algorithm = new AuthorAlgorithmAdapter({ id: `a0-${graph}`, implementationDigest: port.sourceDigest,
      hostIdentityDigest: port.hostDigest, bindingSchema, artifacts, bindings, replay,
      initialAgent: null, data: {}, maxFrontierWaves: 200 });
  }
  const instrumented = {
    describe: () => algorithm.describe(),
    initialize: async context => record(context, await algorithm.initialize(context)),
    reduce: async context => record(context, await algorithm.reduce(context)),
  };
  function record(context, decision) {
    const operations = decision.operations ?? [];
    if (operations.length || (decision.projections?.length ?? 0)) metrics.F++;
    for (const item of operations) {
      if (['author.rank', 'author.checkpoint', 'author.observe'].includes(item.kind)) metrics.O_pure++;
      else metrics.O_physical++;
      metrics.intents.push({ decisionIndex: context.decisionIndex, localKey: item.localKey,
        operationId: jsonDigest([`author-benchmark-${graph}`, context.decisionIndex, item.localKey]),
        kind: item.kind, input: item.input, limits: item.limits ?? {},
        startsBudgetClock: item.startsBudgetClock ?? true });
    }
    return decision;
  }
  const kinds = ['author.role', 'author.edit', 'author.rollout', 'author.measure',
    ...(graph === 'rho_shaped' ? ['author.rank'] : [])];
  const providers = kinds.map(kind => new LocalDurableProvider(join(root, 'providers', kind), {
    kind, implementationDigest: sha256(`author-a0-benchmark.${kind}.v1`), execution: 'trusted-local',
    supportsInspect: true, meteredDimensions: [], inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'any' },
  }, envelope => {
    if (kind !== 'author.rank') {
      const effectPath = join(root, 'effects', 'executions.jsonl');
      fs.mkdirSync(dirname(effectPath), { recursive: true });
      fs.appendFileSync(effectPath, `${JSON.stringify({ kind, operationId: envelope.operationId,
        localKey: envelope.localKey })}\n`);
    }
    const input = envelope.input;
    const value = kind === 'author.role' ? { prompt: `role-${input.input.round}-${input.input.candidate}` }
      : kind === 'author.edit' ? { revision: `rev-${input.round}-${input.candidate}` }
      : kind === 'author.rollout' ? { task: input.task, score: 0.4 }
      : kind === 'author.measure' ? { score: 0.4 }
      : { winner: 0 };
    return { outcome: { kind: 'result', value } };
  }));
  providers.push(new AuthorObserveProvider(), new AuthorCheckpointProvider(artifacts, bindings));
  const spec = { campaignId: `author-benchmark-${graph}`, config: {}, initialBindingSetRef, budget: {} };
  const runtime = new AlgorithmRuntime(root, instrumented, providers, spec, { artifacts, store });
  const startSnapshot = runtime.snapshot();
  let breakpoint = null;
  if (phase === 'before') {
    if (startSnapshot !== null) throw new Error('Before phase needs a fresh Campaign');
    while (metrics.F < expected[graph].F) {
      const status = await runtime.tick();
      if (status !== 'advanced') throw new Error(`Campaign stopped before final intent: ${status}`);
    }
    const state = runtime.snapshot();
    if (!state || state.phase !== 'running') throw new Error('Expected last nonterminal Campaign state');
    breakpoint = { decisionIndex: state.decisionIndex,
      historyEntries: mode === 'low-level' ? null : algorithm.readHistory(state).length,
      pendingOperations: Object.keys(state.operations).length, ...journalStats(root) };
  } else {
    if (startSnapshot === null || startSnapshot.phase !== 'running')
      throw new Error('After phase needs a previously committed nonterminal Campaign');
    breakpoint = { decisionIndex: startSnapshot.decisionIndex,
      historyEntries: mode === 'low-level' ? null : algorithm.readHistory(startSnapshot).length,
      pendingOperations: Object.keys(startSnapshot.operations).length, ...journalStats(root) };
    let firstStatus = 'advanced';
    let firstDecisionIndex = startSnapshot.decisionIndex;
    for (let attempt = 0; attempt < 100; attempt++) {
      firstStatus = await runtime.tick();
      const next = runtime.snapshot();
      firstDecisionIndex = next?.decisionIndex ?? firstDecisionIndex;
      if (firstDecisionIndex > startSnapshot.decisionIndex || next?.phase === 'complete') break;
      if (firstStatus !== 'advanced') throw new Error('Cold recovery stopped before the next committed decision');
    }
    if (firstDecisionIndex === startSnapshot.decisionIndex && runtime.snapshot()?.phase !== 'complete')
      throw new Error('Cold recovery did not reconstruct and commit the next decision');
    process.stdout.write(`${JSON.stringify({ event: 'cold-advanced', status: firstStatus,
      decisionIndex: firstDecisionIndex, breakpoint })}\n`);
    const status = await runtime.runUntilBlocked(1000);
    if (status !== 'complete') throw new Error(`Campaign did not complete after recovery: ${status}`);
  }
  const state = runtime.snapshot();
  const logicalReads = readRoot.bytes;
  const head = JSON.parse(fs.readFileSync(join(root, 'campaign', 'HEAD'), 'utf8'));
  const physicalRecordCount = ['author.role', 'author.edit', 'author.rollout', 'author.measure']
    .map(kind => join(root, 'providers', kind, 'operations'))
    .filter(path => fs.existsSync(path))
    .reduce((count, path) => count + fs.readdirSync(path).filter(name => name.endsWith('.json')).length, 0);
  const effectPath = join(root, 'effects', 'executions.jsonl');
  const physicalExecutions = fs.existsSync(effectPath)
    ? fs.readFileSync(effectPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const result = { event: 'result', mode, graph, phase, elapsedMs: performance.now() - startedAt,
    metrics, J: head.seq + 1, breakpoint, terminal: state?.phase === 'complete',
    physicalRecordCount, physicalExecutions,
    logicalArtifactAndJournalReadBytes: logicalReads,
    operationKeys: metrics.intents.map(item => item.localKey) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await pythonPort?.close(); }
}

function runPhase(mode, graph, root, phase) {
  return new Promise((resolveReady, rejectReady) => {
    const started = performance.now();
    const child = spawn(interpreter, [join(cwd, 'scripts/benchmark-author-a0-supervisor.py'),
      process.execPath, new URL(import.meta.url).pathname, '--child', mode, graph, root, phase],
      { cwd, env: { ...process.env, GEAR_AUTHOR_BENCH_PYTHON: interpreter }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    let coldRecoveryWallMs = null;
    let breakpoint = null;
    let processTreeCpuMs = null;
    const stopWatch = watchTree(child.pid);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      while (stdout.includes('\n')) {
        const end = stdout.indexOf('\n'); const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.event === 'cold-advanced') {
            coldRecoveryWallMs = performance.now() - started;
            breakpoint = event.breakpoint;
          } else if (event.event === 'result') child.result = event;
          else if (event.event === 'usage') processTreeCpuMs = event.processTreeCpuMs;
        } catch { stderr += `Invalid benchmark output: ${line}\n`; }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectReady);
    child.once('close', (code, signal) => {
      const tree = stopWatch();
      if (code !== 0 || !child.result || !Number.isFinite(processTreeCpuMs))
        rejectReady(new Error(`${mode}/${graph}/${phase} exited ${code ?? signal} without complete usage: ${stderr}`));
      else resolveReady({ ...child.result, phaseWallMs: performance.now() - started,
        processTreeCpuMs,
        ...(phase === 'after' ? { coldRecoveryWallMs, breakpoint } : {}), tree });
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
async function main() {
  if (!fs.existsSync(join(cwd, 'lib/algorithm/author/adapter.js')))
    throw new Error('Run `npm run build` before benchmark; compilation is outside the timed window');
  if (!fs.existsSync(interpreter)) throw new Error(`Python 3.11+ interpreter missing: ${interpreter}`);
  const smoke = process.argv.includes('--smoke');
  const samples = smoke ? 1 : protocol.measurement.samples;
  const warmups = smoke ? 0 : protocol.measurement.warmups;
  const { canonicalJson } = await import('../lib/algorithm/schema.js');
  const directory = fs.mkdtempSync(join(tmpdir(), 'gear-author-a0-benchmark-'));
  const measuredSourceIdentity = sourceIdentity();
  fs.writeFileSync(join(directory, 'source-identity.json'), JSON.stringify(measuredSourceIdentity, null, 2) + '\n');
  const rows = [];
  for (const graph of graphs) for (let iteration = -warmups; iteration < samples; iteration++) {
    const comparison = [];
    for (const mode of modes) {
      const root = join(directory, graph, `sample-${iteration}`, mode);
      fs.mkdirSync(root, { recursive: true });
      const start = performance.now();
      const before = await runPhase(mode, graph, root, 'before');
      const after = await runPhase(mode, graph, root, 'after');
      if (after.coldRecoveryWallMs === null || !after.terminal)
        throw new Error(`Cold recovery did not reach a durable terminal decision: ${graph}/${mode}`);
      const intents = [...before.metrics.intents, ...after.metrics.intents];
      const F = before.metrics.F + after.metrics.F;
      const O_pure = before.metrics.O_pure + after.metrics.O_pure;
      const O_physical = before.metrics.O_physical + after.metrics.O_physical;
      const row = { graph, mode, iteration, warmup: iteration < 0,
        F, O_pure, O_physical, O: O_pure + O_physical, J: after.J,
        wallMs: performance.now() - start,
        coldRecoveryWallMs: after.coldRecoveryWallMs,
        workerReplayWallMs: before.metrics.workerReplayWallMs + after.metrics.workerReplayWallMs,
        logicalArtifactAndJournalReadBytes: before.logicalArtifactAndJournalReadBytes + after.logicalArtifactAndJournalReadBytes,
        processTreeCpuMs: before.processTreeCpuMs + after.processTreeCpuMs,
        processTreePeakRssBytes: null,
        sampledTree: { before: before.tree, after: after.tree },
        breakpoint: after.breakpoint, intents, root };
      if (F !== expected[graph].F || row.O !== expected[graph].O)
        throw new Error(`Frozen graph count drift: ${graph}/${mode} got F=${F} O=${row.O}`);
      if (after.physicalRecordCount !== O_physical)
        throw new Error(`Physical operation charge drift: ${graph}/${mode} ${after.physicalRecordCount} vs ${O_physical}`);
      const effects = after.physicalExecutions;
      if (effects.length !== O_physical || new Set(effects.map(item => item.operationId)).size !== O_physical)
        throw new Error(`Duplicate/missing fake physical execution after recovery: ${graph}/${mode}`);
      comparison.push(row);
      rows.push(row);
    }
    const baseline = canonicalJson(comparison[0].intents);
    for (const row of comparison.slice(1)) if (canonicalJson(row.intents) !== baseline)
      throw new Error(`Physical graph/key drift: ${graph}/${row.mode} sample ${iteration}`);
    process.stderr.write(`Completed ${graph} iteration ${iteration}: same ${expected[graph].F} waves and ${expected[graph].O} operation intents\n`);
  }
  const summary = Object.fromEntries(graphs.flatMap(graph => modes.map(mode => {
    const samples = rows.filter(row => row.graph === graph && row.mode === mode && !row.warmup);
    return [`${graph}/${mode}`, {
      medianWallMs: median(samples.map(row => row.wallMs)),
      medianColdRecoveryWallMs: median(samples.map(row => row.coldRecoveryWallMs)),
      medianWorkerReplayWallMs: median(samples.map(row => row.workerReplayWallMs)),
      medianProcessTreeCpuMs: median(samples.map(row => row.processTreeCpuMs)),
      processTreePeakRssBytes: 'unverified: 25 ms ps sampling gives approximate lower bound',
    }];
  })));
  const thresholdChecks = Object.fromEntries(graphs.flatMap(graph => ['typescript', 'python'].map(mode => {
    const author = summary[`${graph}/${mode}`];
    const baseline = summary[`${graph}/low-level`];
    const extraWallPerFrontierMs = (author.medianWallMs - baseline.medianWallMs) / expected[graph].F;
    return [`${graph}/${mode}`, {
      extraWallPerFrontierMs,
      wallThresholdPassed: extraWallPerFrontierMs <= protocol.acceptance.extraMedianWallMsPerFrontierVsLowLevelAtMost,
      coldRecoveryThresholdPassed: author.medianColdRecoveryWallMs <= protocol.acceptance.medianColdRecoveryWallMsAtMost,
      rssThreshold: 'unverified: sampled lower bound cannot establish a maximum',
    }];
  })));
  const output = { schemaVersion: 1, protocolPath, protocolStatus: protocol.status,
    mode: smoke ? 'smoke' : 'frozen-benchmark', interpreter, directory,
    sourceIdentity: measuredSourceIdentity,
    sampleCount: samples, warmups, rawSamples: rows, summary, thresholdChecks,
    acceptance: { countsAndEffectKeys: 'verified', wallAndColdThresholds: smoke ? 'smoke only' : 'see thresholdChecks',
      processTreeCpu: 'verified with wait4 reaped descendants',
      processTreeRss: 'unverified: sampled lower bound',
      defaultProductFrontierLimit: 'not-selected' } };
  const outputPath = process.env.GEAR_AUTHOR_BENCH_OUTPUT ?? join(directory, 'results.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  process.stdout.write(`${outputPath}\n`);
}

if (process.argv[2] === '--child') runChild(process.argv.slice(3)).catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1;
});
else main().catch(error => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
