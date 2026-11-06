import { parseCsv, validateSubmission } from './common.mjs'
import { assert } from './contracts.mjs'

export function validateTabularSubmission(bytes, task) {
  const s = task.prediction
  if (s.kind !== 'tabular') return validateSubmission(bytes, { id_column: s.idColumn, target_column: s.targetColumn,
    expected_ids: task.predictIds, rows: task.predictIds.length, allowed_labels: s.allowedLabels })
  const [columns, ...rows] = parseCsv(bytes.toString('utf8').replace(/^\uFEFF/, ''))
  assert(JSON.stringify(columns) === JSON.stringify([s.idColumn, ...s.targetColumns]), 'submission columns differ')
  assert(rows.length === task.predictIds.length, 'submission row count differs')
  rows.forEach((row, i) => {
    assert(row.length === columns.length && row[0] === task.predictIds[i], 'submission must use canonical sample/test ID order')
    for (const value of row.slice(1)) assert(s.metric === 'accuracy' ? s.labels.includes(value)
      : value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && (s.metric !== 'auc-roc' || Number(value) <= 1), 'invalid prediction value')
  })
  return { rows: rows.length }
}
