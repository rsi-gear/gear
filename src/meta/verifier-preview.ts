import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { MetaFailureCard, VerifierFeedback, VerifierProcessEvidence } from '../types.js'

// Bound both item counts and serialized bytes: short strings can still expand
// when JSON-escaped, and component details can contain arbitrarily nested data.
const MAX_PREVIEW_BYTES = 8_000
const MAX_PREVIEW_ITEMS = 5

class PreviewBudget {
  private truncated = false

  text(value: string, bytes = 120): string {
    if (Buffer.byteLength(value) <= bytes) return value
    this.truncated = true
    return `${Buffer.from(value).subarray(0, bytes - 3).toString('utf8').replace(/\uFFFD+$/u, '')}…`
  }

  items<T, U>(values: readonly T[], project: (value: T) => U): U[] {
    if (values.length > MAX_PREVIEW_ITEMS) this.truncated = true
    return values.slice(0, MAX_PREVIEW_ITEMS).map(project)
  }

  details(value: Record<string, JsonValue>): {
    publicDetails?: typeof value
    publicDetailsPreview?: string
  } {
    const serialized = JSON.stringify(value)
    return Buffer.byteLength(serialized) <= 600
      ? { publicDetails: value }
      : { publicDetailsPreview: this.text(serialized, 600) }
  }

  finish<T extends { truncated?: true }>(preview: T, entries: unknown[] | undefined): T {
    // Include the truncation marker in the byte budget before dropping items.
    if (this.truncated) preview.truncated = true
    while (entries !== undefined && entries.length > 0
      && Buffer.byteLength(JSON.stringify(preview)) > MAX_PREVIEW_BYTES) {
      entries.pop()
      preview.truncated = true
    }
    return preview
  }
}

/** Input must already have private fields removed and secret values redacted. */
export function previewVerifierProcess(process: VerifierProcessEvidence): NonNullable<MetaFailureCard['verifier']['process']> {
  const budget = new PreviewBudget()
  const components = process.components === undefined ? undefined : budget.items(process.components, component => ({
    id: budget.text(component.id),
    category: budget.text(component.category),
    status: component.status,
    weight: component.weight,
    ...(component.code === undefined ? {} : { code: budget.text(component.code) }),
    ...(component.publicDetails === undefined ? {} : budget.details(component.publicDetails)),
    ...(component.trajectoryRefs === undefined ? {} : {
      trajectoryRefs: budget.items(component.trajectoryRefs, ref => ({ ...ref, runId: budget.text(ref.runId) })),
    }),
  }))
  const preview: NonNullable<MetaFailureCard['verifier']['process']> = {
    schemaVersion: process.schemaVersion,
    metric: budget.text(process.metric),
    score: process.score,
    detailStatus: process.detailStatus,
    ...(process.passed === undefined ? {} : { passed: process.passed }),
    ...(process.total === undefined ? {} : { total: process.total }),
    ...(process.excluded === undefined ? {} : { excluded: process.excluded }),
    ...(components === undefined ? {} : { components }),
  }
  return budget.finish(preview, components)
}

/** Input must already have private fields removed and secret values redacted. */
export function previewVerifierFeedback(feedback: VerifierFeedback): NonNullable<MetaFailureCard['verifier']['feedback']> {
  const budget = new PreviewBudget()
  const items = budget.items(feedback.items, item => ({
    code: budget.text(item.code),
    severity: item.severity,
    message: budget.text(item.message, 600),
    ...(item.componentIds === undefined ? {} : { componentIds: budget.items(item.componentIds, id => budget.text(id)) }),
    ...(item.trajectoryRefs === undefined ? {} : {
      trajectoryRefs: budget.items(item.trajectoryRefs, ref => ({ ...ref, runId: budget.text(ref.runId) })),
    }),
  }))
  return budget.finish({ schemaVersion: feedback.schemaVersion, items } as NonNullable<MetaFailureCard['verifier']['feedback']>, items)
}
