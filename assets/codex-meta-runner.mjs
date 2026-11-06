#!/usr/bin/env node
import { main } from '../lib/adapters/codex/runner.js'

main().catch(error => {
  // Native errors may embed private filesystem paths or credentials.
  process.stderr.write(`gear-meta-codex: ${typeof error?.code === 'string' ? error.code : 'operation-failed'}\n`)
  if (process.argv[2] === '--worker') process.exit(1)
  process.exitCode = 1
})
