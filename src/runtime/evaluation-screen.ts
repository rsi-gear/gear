import type { Evidence, Json } from '../domain/algorithm-wire.js'
import type { OperationRequest, OperationReceipt } from '../ports/operations.js'

const GENERIC_PATTERNS: Array<[RegExp, string]> = [
  [
    /AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|api[_-]?key\s*=\s*["'][^"']{8,}/iu,
    'credential in candidate diff',
  ],
  [/\b(?:task|case|issue)[-_ ]?(?:id|name)\s*[:=]/iu, 'task-specific identifier in candidate diff'],
  [
    /\b(?:grader|verifier|judge|rubric)\b.*(?:read|detect|parse|match)/isu,
    'grader-specific logic in candidate diff',
  ],
]

function object(value: Json | undefined): { [key: string]: Json } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function rejectedReceipt(request: OperationRequest, candidateId: string, reason: string): OperationReceipt {
  const evidence: Evidence[] = request.slots.map(({ taskId, repetition }) => ({
    candidate_id: candidateId,
    task_id: taskId,
    repetition,
    score: null,
    status: 'environment_failed',
    scope: request.operation.scope,
    feedback: `RRSI critic rejected candidate before evaluation: ${reason}`,
  }))
  return {
    result: {
      operation_id: request.operationId,
      kind: request.operation.kind,
      status: 'complete',
      candidate_id: request.operation.candidate_id,
      data: { critic: { verdict: 'reject', reason } },
    },
    evidence,
    candidate: null,
    physicalAttempts: 0,
    usage: {
      model_requests: 0,
      tokens: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      dollars: 0,
    },
    provenance: { critic: { verdict: 'reject', reason } },
  }
}

export function screenEvaluation(request: OperationRequest): OperationReceipt | null {
  if (request.operation.kind !== 'evaluate_seed' || !request.operation.candidate_id) return null
  const payload = object(request.operation.payload)
  const rrsi = payload && object(payload.rrsi)
  if (!rrsi) return null
  const diffValue = rrsi.candidate_diff ?? rrsi.diff ?? payload?.candidate_diff ?? payload?.diff
  if (typeof diffValue !== 'string' || !diffValue.trim()) return null
  const match = GENERIC_PATTERNS.find(([pattern]) => pattern.test(diffValue))
  return match ? rejectedReceipt(request, request.operation.candidate_id, match[1]) : null
}

export async function evaluateWithCritic(
  request: OperationRequest,
  submit: (request: OperationRequest) => Promise<OperationReceipt>,
): Promise<OperationReceipt> {
  const rejected = screenEvaluation(request)
  return rejected ?? submit(request)
}
