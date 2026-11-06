import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(!process.env.GEAR_TEST_HITCH)('accepts Gear ready binding files through the companion Hitch CLI and compiled evaluation parser', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/check-training-endpoint-contract.mjs'], {
    env: process.env, encoding: 'utf8', timeout: 90_000,
  })
  expect(JSON.parse(stdout)).toMatchObject({ actualHitchCli: true, readyBindingFileAccepted: true, actualEvalSubmitAccepted: true, trainingToolChatToolsVerified: true, streamedToolRoundtripVerified: true,
    wrongModelDigestRejected: true, generationConflictRejected: true, publicConnectionRedacted: true })
}, 95_000)
