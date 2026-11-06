// Harbor manifest v1 specifies JavaScript JSON and localeCompare directory ordering.
// This codec is transport infrastructure; no evaluation or algorithm decisions live here.
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const sha = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex')
const canonical = (value) => Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object'
    ? '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
    : JSON.stringify(value)
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const tasks = input.tasks.map(({ id, files }) => {
  const tree = new Map()
  for (const file of files) {
    const parts = file.path.split('/')
    let current = tree
    for (const part of parts.slice(0, -1)) {
      if (!current.has(part)) current.set(part, new Map())
      current = current.get(part)
    }
    current.set(parts.at(-1), { path: file.path, mode: file.executable ? 'executable' : 'file', sha256: file.digest.slice(7) })
  }
  const rows = []
  const visit = (directory) => {
    for (const [, item] of [...directory].sort(([a], [b]) => a.localeCompare(b))) {
      if (item instanceof Map) visit(item)
      else rows.push(item)
    }
  }
  visit(tree)
  return { task_id: id, task_digest: sha(JSON.stringify(rows)) }
}).sort((a, b) => a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0)
const body = { ...input.manifest, tasks }
delete body.dataset_digest
process.stdout.write(JSON.stringify({ ...body, dataset_digest: sha(canonical(body)) }))
