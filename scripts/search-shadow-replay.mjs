#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { replaySearchCase } from '../lib/search/shadow.js'
const [baseline, candidate, output, ...extra] = process.argv.slice(2)
if (!baseline || !candidate || !output || extra.length) throw Error('Usage: node scripts/search-shadow-replay.mjs BASELINE_CACHE CANDIDATE_CACHE NEW_OUTPUT_JSON')
if ([baseline, candidate].some(path => resolve(path) === resolve(output))) throw Error('Output must differ from both read-only inputs')
const report = await replaySearchCase(baseline, candidate)
// Exclusive creation also rejects symlinks, existing artifacts, and any other source path.
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ output: resolve(output), advisory: report.advisory, sourceBytesUnchanged: report.sourceBytesUnchanged,
  baselineOutcome: report.comparison.baselineOutcome, candidateOutcome: report.comparison.candidateOutcome,
  improvedTasks: report.comparison.outcomeImprovedTaskIds.length, regressedTasks: report.comparison.outcomeRegressedTaskIds.length }))
