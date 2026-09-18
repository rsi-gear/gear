import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertComponentRef } from '../evolution/components.js';
import { digestJson } from '../state/digest.js';
const BRIDGE_PATH = fileURLToPath(new URL('../../assets/llm-verifier-bridge.py', import.meta.url));
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const RUNTIME_PROBE = String.raw `
import hashlib, json, pathlib, platform
import llm_verifier
root = pathlib.Path(llm_verifier.__file__).resolve().parent
digest = hashlib.sha256()
for path in sorted(root.rglob("*.py")):
    relative = path.relative_to(root).as_posix().encode("utf-8")
    content = path.read_bytes()
    digest.update(str(len(relative)).encode("ascii") + b"\0" + relative + b"\0")
    digest.update(str(len(content)).encode("ascii") + b"\0" + content + b"\0")
print(json.dumps({
    "pythonVersion": platform.python_version(),
    "packageVersion": llm_verifier.__version__,
    "packageIntegrity": "sha256:" + digest.hexdigest(),
}, separators=(",", ":"), sort_keys=True))
`;
function record(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new TypeError(`${label} must be an object`);
    return value;
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new TypeError(`${label} must be a positive safe integer`);
    return value;
}
function nonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(`${label} must be a non-negative safe integer`);
    return value;
}
function finite(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new TypeError(`${label} must be finite`);
    return value;
}
function parseRuntimeIdentity(value) {
    const runtime = record(value, 'llm-verifier runtime');
    if (typeof runtime.pythonVersion !== 'string' || runtime.pythonVersion.length === 0
        || typeof runtime.packageVersion !== 'string' || runtime.packageVersion.length === 0
        || typeof runtime.packageIntegrity !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(runtime.packageIntegrity)) {
        throw new TypeError('llm-verifier runtime identity is invalid');
    }
    return {
        pythonVersion: runtime.pythonVersion,
        packageVersion: runtime.packageVersion,
        packageIntegrity: runtime.packageIntegrity,
    };
}
function parseConfig(ref) {
    assertComponentRef(ref, 'candidate-assessor');
    const config = record(ref.config, 'llm-verifier assessor config');
    const runtime = parseRuntimeIdentity(config.runtime);
    const criteria = record(config.criteria, 'llm-verifier criteria');
    if (typeof config.pythonExecutable !== 'string' || !isAbsolute(config.pythonExecutable)) {
        throw new TypeError('llm-verifier pythonExecutable must be an absolute path');
    }
    if (typeof config.model !== 'string' || config.model.length === 0)
        throw new TypeError('llm-verifier model is required');
    if (Object.keys(criteria).length === 0
        || Object.values(criteria).some(value => typeof value !== 'string' || value.length === 0)) {
        throw new TypeError('llm-verifier criteria must contain non-empty descriptions');
    }
    if (!Array.isArray(config.passEnv) || config.passEnv.some(value => typeof value !== 'string' || !ENV_NAME.test(value))) {
        throw new TypeError('llm-verifier passEnv contains an invalid environment variable name');
    }
    if (config.groundTruthNote !== undefined && typeof config.groundTruthNote !== 'string') {
        throw new TypeError('llm-verifier groundTruthNote must be a string');
    }
    return {
        pythonExecutable: config.pythonExecutable,
        runtime,
        model: config.model,
        criteria: criteria,
        ...(config.groundTruthNote === undefined ? {} : { groundTruthNote: config.groundTruthNote }),
        nEvaluations: positiveInteger(config.nEvaluations, 'llm-verifier nEvaluations'),
        pivots: positiveInteger(config.pivots, 'llm-verifier pivots'),
        seed: nonNegativeInteger(config.seed, 'llm-verifier seed'),
        maxWorkers: positiveInteger(config.maxWorkers, 'llm-verifier maxWorkers'),
        maxOutputBytes: positiveInteger(config.maxOutputBytes, 'llm-verifier maxOutputBytes'),
        maxTrajectoryEvents: positiveInteger(config.maxTrajectoryEvents, 'llm-verifier maxTrajectoryEvents'),
        maxTrajectoryChars: positiveInteger(config.maxTrajectoryChars, 'llm-verifier maxTrajectoryChars'),
        passEnv: [...config.passEnv],
    };
}
function selectionEnvironment(names) {
    const env = {
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONUTF8: '1',
        LC_ALL: 'C',
    };
    for (const name of names) {
        const value = process.env[name];
        if (value === undefined)
            throw new Error(`llm-verifier environment variable is not set: ${name}`);
        env[name] = value;
    }
    return env;
}
function redactEnvironmentValues(text, names) {
    let redacted = text;
    for (const name of names) {
        const value = process.env[name];
        if (value !== undefined && value.length > 0)
            redacted = redacted.split(value).join('[REDACTED]');
    }
    return redacted;
}
function runProcess(executable, args, input, signal, maxOutputBytes, env) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: dirname(BRIDGE_PATH),
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let overflow;
        let forceKill;
        const terminate = () => {
            child.kill('SIGTERM');
            forceKill ??= setTimeout(() => child.kill('SIGKILL'), 5_000);
            forceKill.unref();
        };
        const append = (stream, current, chunk) => {
            const next = current + chunk;
            if (Buffer.byteLength(next) > maxOutputBytes) {
                overflow = stream;
                terminate();
                return next.slice(0, maxOutputBytes);
            }
            return next;
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout = append('stdout', stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = append('stderr', stderr, chunk); });
        const abort = () => { terminate(); };
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', error => {
            if (forceKill !== undefined)
                clearTimeout(forceKill);
            signal.removeEventListener('abort', abort);
            reject(error);
        });
        child.once('exit', code => {
            if (forceKill !== undefined)
                clearTimeout(forceKill);
            signal.removeEventListener('abort', abort);
            if (signal.aborted)
                return reject(signal.reason);
            if (overflow !== undefined)
                return reject(new Error(`llm-verifier ${overflow} exceeded ${maxOutputBytes} bytes`));
            resolve({ stdout, stderr, exitCode: code ?? -1 });
        });
        child.stdin.once('error', error => {
            if (error.code !== 'EPIPE')
                reject(error);
        });
        child.stdin.end(input);
    });
}
export async function resolveLlmVerifierRuntime(pythonExecutable, signal = AbortSignal.timeout(30_000)) {
    if (!isAbsolute(pythonExecutable))
        throw new TypeError('llm-verifier pythonExecutable must be absolute');
    const result = await runProcess(pythonExecutable, ['-c', RUNTIME_PROBE], '', signal, 64 * 1024, { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', LC_ALL: 'C' });
    if (result.exitCode !== 0)
        throw new Error(`failed to inspect llm-verifier runtime: ${result.stderr.slice(-4000)}`);
    return parseRuntimeIdentity(JSON.parse(result.stdout));
}
function contentText(value) {
    if (!Array.isArray(value))
        return '';
    return value.flatMap(block => {
        if (typeof block !== 'object' || block === null || Array.isArray(block))
            return [];
        const item = block;
        if ((item.type === 'text' || item.type === 'reasoning') && item.text !== undefined)
            return [projectedText(item.text)];
        if (item.type === 'tool-call')
            return [JSON.stringify(item)];
        return [];
    }).join('\n');
}
function projectedText(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return JSON.stringify(value) ?? String(value);
    const item = value;
    if (typeof item.truncated === 'boolean' && typeof item.preview === 'string') {
        return `${item.preview}${typeof item.tail === 'string' ? `\n[...excerpted...]\n${item.tail}` : ''}`;
    }
    return JSON.stringify(value);
}
function renderTrajectory(analysis, maxChars) {
    const surfaceMessages = new Map(analysis.surface.nodes.map(node => [node.seq, node.message]));
    const problem = analysis.surface.nodes.flatMap(node => {
        if (node.eventType !== 'user/message')
            return [];
        const data = typeof node.message === 'object' && node.message !== null && !Array.isArray(node.message)
            ? node.message
            : undefined;
        if (data === undefined)
            return [projectedText(node.message)];
        if (typeof data.truncated === 'boolean' && typeof data.preview === 'string')
            return [projectedText(data)];
        return [contentText(data.content)];
    }).find(value => value.trim().length > 0);
    if (problem === undefined)
        throw new Error(`trajectory ${analysis.runId} has no task user message`);
    const sections = [];
    for (const event of analysis.events) {
        if (typeof event !== 'object' || event === null || Array.isArray(event))
            continue;
        const item = event;
        const type = item.type;
        if (type === 'assistant/message') {
            const data = typeof item.data === 'object' && item.data !== null ? item.data : {};
            const message = Number.isSafeInteger(data.surface_node_seq)
                ? surfaceMessages.get(data.surface_node_seq)
                : undefined;
            const messageRecord = typeof message === 'object' && message !== null && !Array.isArray(message)
                ? message
                : undefined;
            const text = messageRecord === undefined
                ? projectedText(message)
                : typeof messageRecord.truncated === 'boolean' && typeof messageRecord.preview === 'string'
                    ? projectedText(messageRecord)
                    : contentText(messageRecord.content);
            if (text.length > 0)
                sections.push(`ASSISTANT\n${text}`);
        }
        else if (type === 'tool/result') {
            const data = typeof item.data === 'object' && item.data !== null ? item.data : {};
            const message = Number.isSafeInteger(data.surface_node_seq)
                ? surfaceMessages.get(data.surface_node_seq)
                : undefined;
            sections.push(`TOOL/RESULT\n${projectedText(message ?? data)}`);
        }
        else if (type === 'tool/call' || type === 'tool/code-dispatch' || type === 'tool/code-dispatch-start') {
            sections.push(`${String(type).toUpperCase()}\n${projectedText(item.data ?? null)}`);
        }
    }
    const trace = sections.join('\n\n');
    if (trace.length === 0)
        throw new Error(`trajectory ${analysis.runId} has no assessable agent events`);
    if (problem.length > maxChars || trace.length > maxChars) {
        throw new Error(`trajectory ${analysis.runId} exceeds llm-verifier maxTrajectoryChars`);
    }
    return { problem, trace, digest: digestJson({ canonicalSha256: analysis.source.canonicalSha256, problem, trace }) };
}
function exactCandidateKeys(value, candidateIds, label) {
    const keys = Object.keys(value).sort();
    const expected = [...candidateIds].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected))
        throw new Error(`${label} candidate identity mismatch`);
}
function parseBridgeResult(value, candidateIds) {
    const result = record(value, 'llm-verifier bridge result');
    if (result.schema_version !== 1 || !Array.isArray(result.cells))
        throw new Error('invalid llm-verifier bridge result schema');
    const cells = result.cells.map((cellValue, index) => {
        const cell = record(cellValue, `llm-verifier cells[${index}]`);
        if (typeof cell.task_name !== 'string' || cell.task_name.length === 0)
            throw new Error('llm-verifier task name is invalid');
        const attempt = positiveInteger(cell.attempt, 'llm-verifier attempt');
        const scores = record(cell.scores, 'llm-verifier scores');
        exactCandidateKeys(scores, candidateIds, 'llm-verifier scores');
        const parsedScores = Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, finite(score, `llm-verifier score ${id}`)]));
        if (Object.values(parsedScores).some(score => score < 0 || score > 1))
            throw new Error('llm-verifier score is outside [0, 1]');
        if (!Array.isArray(cell.ranking_candidate_ids)
            || JSON.stringify([...cell.ranking_candidate_ids].sort()) !== JSON.stringify([...candidateIds].sort())) {
            throw new Error('llm-verifier ranking is not a candidate permutation');
        }
        if (typeof cell.winner_candidate_id !== 'string' || cell.ranking_candidate_ids[0] !== cell.winner_candidate_id) {
            throw new Error('llm-verifier winner/ranking mismatch');
        }
        if (!Array.isArray(cell.criteria) || cell.criteria.some(item => typeof item !== 'string' || item.length === 0)) {
            throw new Error('llm-verifier criteria evidence is invalid');
        }
        return {
            task_name: cell.task_name,
            attempt,
            candidate_ids: [...candidateIds],
            scores: parsedScores,
            ranking_candidate_ids: [...cell.ranking_candidate_ids],
            winner_candidate_id: cell.winner_candidate_id,
            n_comparisons: nonNegativeInteger(cell.n_comparisons, 'llm-verifier comparisons'),
            criteria: [...cell.criteria],
        };
    });
    const usageValue = record(result.usage, 'llm-verifier usage');
    const usage = {
        modelRequests: nonNegativeInteger(usageValue.model_requests, 'llm-verifier model requests'),
        inputTokens: nonNegativeInteger(usageValue.input_tokens, 'llm-verifier input tokens'),
        outputTokens: nonNegativeInteger(usageValue.output_tokens, 'llm-verifier output tokens'),
        cachedInputTokens: nonNegativeInteger(usageValue.cached_input_tokens, 'llm-verifier cached input tokens'),
        reasoningTokens: nonNegativeInteger(usageValue.reasoning_tokens, 'llm-verifier reasoning tokens'),
    };
    return { cells, usage };
}
export class LlmVerifierCandidateAssessor {
    ref;
    config;
    constructor(ref) {
        this.ref = ref;
        this.config = parseConfig(ref);
    }
    async assess(request, context, signal) {
        signal.throwIfAborted();
        if (context.trajectoryReader === undefined)
            throw new Error('llm-verifier assessor requires a trajectory reader');
        const candidates = [...request.candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
        if (candidates.length === 0)
            throw new Error('llm-verifier assessor requires candidates');
        const candidateIds = candidates.map(candidate => candidate.candidateId);
        const trialMaps = candidates.map(candidate => {
            const trials = new Map();
            for (const trial of candidate.seedEvaluation.trials) {
                if (trial.status !== 'completed' || trial.runId === undefined) {
                    throw new Error(`llm-verifier candidate ${candidate.candidateId} has an unreadable trial`);
                }
                const key = JSON.stringify([trial.taskName, trial.attempt ?? 1]);
                if (trials.has(key))
                    throw new Error(`llm-verifier candidate ${candidate.candidateId} has duplicate trial cell ${key}`);
                trials.set(key, trial);
            }
            return trials;
        });
        const cellKeys = [...trialMaps[0].keys()]
            .filter(key => trialMaps.slice(1).every(trials => trials.has(key)))
            .sort();
        if (cellKeys.length === 0)
            throw new Error('llm-verifier candidates have no common valid paired rollout cells');
        const bridgeCells = [];
        const evidenceCells = [];
        for (const key of cellKeys) {
            const candidateTraces = [];
            let sharedProblem;
            let sharedProblemDigest;
            let taskName = '';
            let attempt = 0;
            const evidenceCandidates = [];
            for (let index = 0; index < candidates.length; index += 1) {
                const candidate = candidates[index];
                const trial = trialMaps[index].get(key);
                taskName = trial.taskName;
                attempt = trial.attempt ?? 1;
                const analysis = await context.trajectoryReader.inspectTrajectoryAnalysis(trial.runId, signal);
                const semanticItemCount = analysis.surface.nodes.length + analysis.events.length + analysis.chunkSummaries.length;
                if (semanticItemCount > this.config.maxTrajectoryEvents) {
                    throw new Error(`trajectory ${trial.runId} exceeds llm-verifier maxTrajectoryEvents after bounded projection`);
                }
                const rendered = renderTrajectory(analysis, this.config.maxTrajectoryChars);
                const problemDigest = digestJson(rendered.problem);
                if (sharedProblemDigest !== undefined && sharedProblemDigest !== problemDigest) {
                    throw new Error(`llm-verifier task prompt mismatch for ${taskName} attempt ${attempt}`);
                }
                sharedProblem = rendered.problem;
                sharedProblemDigest = problemDigest;
                candidateTraces.push({ candidate_id: candidate.candidateId, trace: rendered.trace });
                evidenceCandidates.push({
                    candidateId: candidate.candidateId,
                    runId: trial.runId,
                    trajectoryDigest: rendered.digest,
                });
            }
            bridgeCells.push({ task_name: taskName, attempt, problem: sharedProblem, candidates: candidateTraces });
            evidenceCells.push({
                taskName,
                attempt,
                problemDigest: sharedProblemDigest,
                candidates: evidenceCandidates,
            });
        }
        const bridgeRequest = {
            schema_version: 1,
            config: {
                model: this.config.model,
                criteria: this.config.criteria,
                ...(this.config.groundTruthNote === undefined ? {} : { ground_truth_note: this.config.groundTruthNote }),
                n_evaluations: this.config.nEvaluations,
                pivots: this.config.pivots,
                seed: this.config.seed,
                max_workers: this.config.maxWorkers,
            },
            cells: bridgeCells,
        };
        const processResult = await runProcess(this.config.pythonExecutable, [BRIDGE_PATH], JSON.stringify(bridgeRequest), signal, this.config.maxOutputBytes, selectionEnvironment(this.config.passEnv));
        if (processResult.exitCode !== 0) {
            throw new Error(`llm-verifier assessor failed: ${redactEnvironmentValues(processResult.stderr.slice(-4000), this.config.passEnv)}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(processResult.stdout);
        }
        catch (error) {
            throw new Error(`llm-verifier assessor emitted invalid JSON: ${String(error)}`);
        }
        const bridge = parseBridgeResult(parsed, candidateIds);
        if (bridge.cells.length !== evidenceCells.length)
            throw new Error('llm-verifier bridge omitted task cells');
        const totals = Object.fromEntries(candidateIds.map(candidateId => [candidateId, 0]));
        for (let index = 0; index < bridge.cells.length; index += 1) {
            const cell = bridge.cells[index];
            const expected = evidenceCells[index];
            if (cell.task_name !== expected.taskName || cell.attempt !== expected.attempt) {
                throw new Error('llm-verifier bridge reordered or changed task cell identity');
            }
            for (const candidateId of candidateIds)
                totals[candidateId] = totals[candidateId] + cell.scores[candidateId];
            expected.scores = cell.scores;
            expected.rankingCandidateIds = cell.ranking_candidate_ids;
            expected.winnerCandidateId = cell.winner_candidate_id;
            expected.comparisons = cell.n_comparisons;
            expected.criteria = cell.criteria;
        }
        const divisor = bridge.cells.length;
        if (divisor === 0)
            throw new Error('llm-verifier assessor received no task cells');
        const meanScores = Object.fromEntries(candidateIds.map(candidateId => [candidateId, totals[candidateId] / divisor]));
        const rankingCandidateIds = [...candidateIds].sort((left, right) => meanScores[right] - meanScores[left] || left.localeCompare(right));
        const candidateMetrics = Object.fromEntries(candidates.map(candidate => [
            candidate.candidateId,
            {
                ...structuredClone(candidate.metrics),
                quality: meanScores[candidate.candidateId],
                descriptors: {
                    ...candidate.metrics.descriptors,
                    llmVerifierScore: meanScores[candidate.candidateId],
                },
            },
        ]));
        return {
            candidateMetrics,
            rankingCandidateIds,
            reason: `ranked ${candidateIds.length} candidates across ${divisor} seed task/repetition cells with llm-verifier`,
            evidence: {
                kind: 'llm-verifier',
                model: this.config.model,
                criteriaDigest: digestJson(this.config.criteria),
                cells: evidenceCells,
            },
            usage: bridge.usage,
        };
    }
}
export function llmVerifierImplementation() {
    const moduleBytes = readFileSync(fileURLToPath(import.meta.url));
    const bridgeBytes = readFileSync(BRIDGE_PATH);
    const manifestBytes = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    return {
        package: manifest.name,
        version: manifest.version,
        integrity: `sha256:${createHash('sha256')
            .update(moduleBytes)
            .update('\0')
            .update(bridgeBytes)
            .update('\0')
            .update(manifestBytes)
            .digest('hex')}`,
    };
}
//# sourceMappingURL=llm-verifier.js.map