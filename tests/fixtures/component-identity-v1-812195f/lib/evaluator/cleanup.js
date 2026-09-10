export function evaluationFailure(error) {
    return {
        code: typeof error?.code === 'string'
            ? error.code : 'evaluation_failed',
        message: error instanceof Error ? error.message : String(error),
    };
}
/** Keep the primary failure's code, message and evidence; report cleanup separately. */
export class EvaluationCleanupError extends Error {
    code;
    cleanupFailure;
    failedEvidence;
    constructor(error, cleanupError) {
        const failure = evaluationFailure(error);
        super(failure.message, { cause: error });
        this.name = 'EvaluationCleanupError';
        this.code = failure.code;
        this.cleanupFailure = evaluationFailure(cleanupError);
        const evidence = error?.failedEvidence;
        if (evidence !== undefined)
            this.failedEvidence = evidence;
    }
}
//# sourceMappingURL=cleanup.js.map