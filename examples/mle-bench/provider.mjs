#!/usr/bin/env node
import { AnalysisOperationProvider } from './lib/operation-provider.mjs'
import { withOperatorCancellation } from './lib/deadline.mjs'
import { cli, isMain } from './lib/common.mjs'

export async function main() {
  let input = ''
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 64 * 1024 * 1024) throw new Error('provider input exceeds limit') }
  const { action, configuration, context, request } = JSON.parse(input)
  const provider = await AnalysisOperationProvider.open(configuration, context)
  let result
  if (action === 'describe') result = await provider.describe()
  else if (action === 'inspect') result = await provider.inspect(request)
  else if (action === 'cancel') result = await provider.cancel(request)
  else if (action === 'submit') result = await withOperatorCancellation(signal => provider.submit(request, signal))
  else throw new Error(`unsupported provider action: ${action}`)
  process.stdout.write(JSON.stringify(result))
}
if (isMain(import.meta.url)) cli(main)
