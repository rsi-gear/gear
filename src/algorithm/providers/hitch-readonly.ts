import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { HitchCliEvaluator } from '../../evaluator/hitch-cli.js';
import type { EvaluationReservation, EvaluationSubmissionIntent } from '../../types.js';

const execute = promisify(execFile);
const EVAL_ID = /^eval_[0-9a-f]{32}$/u;

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid read-only Hitch response');
  return value as RecordValue;
}

/** Locate a previously accepted daemon submission without ever replaying `eval submit`. */
export async function findSubmittedHitchReservationReadOnly(evaluator: HitchCliEvaluator,
  intent: EvaluationSubmissionIntent): Promise<EvaluationReservation | undefined> {
  if (intent.provider !== 'hitch-cli' || !/^gear-eval-v1-[0-9a-f]{64}$/u.test(intent.idempotencyKey)) {
    throw new Error('Invalid Hitch submission intent for read-only lookup');
  }
  const rootArgs = evaluator.options.root ? ['--root', evaluator.options.root] : [];
  const deadline = Date.now() + 15_000;
  const run = async (args: string[]): Promise<RecordValue> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Hitch read-only lookup deadline exceeded');
    const { stdout } = await execute(evaluator.options.executable, [...rootArgs, ...args], {
      cwd: evaluator.repositoryPath, timeout: Math.min(remaining, 5_000), maxBuffer: 4 * 1024 * 1024,
    });
    return object(JSON.parse(stdout));
  };
  const listed = await run(['eval', 'list', '--json']);
  if (listed.schema_version !== '1' || !Array.isArray(listed.evals) || listed.evals.length > 256) {
    throw new Error('Invalid Hitch read-only evaluation list');
  }
  const expectedHash = `sha256:${createHash('sha256').update(intent.idempotencyKey).digest('hex')}`;
  let found: EvaluationReservation | undefined;
  for (const value of listed.evals) {
    const evalId = object(value).eval_id;
    if (typeof evalId !== 'string' || !EVAL_ID.test(evalId)) throw new Error('Invalid Hitch listed evaluation identity');
    const inspected = await run(['eval', 'inspect', evalId, '--json']);
    if (inspected.schema_version !== '1' || inspected.eval_id !== evalId) {
      throw new Error('Hitch read-only inspection identity mismatch');
    }
    if (inspected.submission == null) continue;
    const submission = object(inspected.submission);
    if (submission.schema_version !== '1' || submission.eval_id !== evalId) {
      throw new Error('Hitch read-only submission identity mismatch');
    }
    if (submission.idempotency_key_hash !== expectedHash) continue;
    if (found) throw new Error('Multiple Hitch submissions share an idempotency key');
    found = { provider: 'hitch-cli', evalId };
  }
  return found;
}
