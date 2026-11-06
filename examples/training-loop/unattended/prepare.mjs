#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { digestJson, parseModelTrainingSpec, parseModelVersion, parseNativeDeploymentProfile,
  ModelTrainingStore, validateIterationTrainingSchedule } from '../../../lib/training/index.js'
import { parseTrainingControllerConfig, trainingController } from '../../../lib/training/cli.js'

const usage = 'node examples/training-loop/unattended/prepare.mjs --controller BASE_CONTROLLER.json --spec BASE_SPEC.json --profile PROFILE.json --output DIRECTORY [--proposals PROPOSALS.json] [--max-rounds 5 --wall-seconds 28800 --max-rejected 2 --run-recoveries 1 --evaluation-attempts 2]'
const args = process.argv.slice(2), options = {}
if (args.includes('--help')) { process.stdout.write(usage + '\n'); process.exit(0) }
const flags = new Set(['controller', 'spec', 'profile', 'output', 'proposals', 'max-rounds', 'wall-seconds', 'max-rejected', 'run-recoveries', 'evaluation-attempts'])
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i]?.replace(/^--/, '')
  if (!flags.has(flag) || !args[i + 1] || options[flag]) throw new Error(usage)
  options[flag] = args[i + 1]
}
for (const flag of ['controller', 'spec', 'profile', 'output']) if (!options[flag]) throw new Error(usage)
const readJson = async path => JSON.parse(await readFile(resolve(path), 'utf8'))
const originalController = await readJson(options.controller)
const originalSpec = parseModelTrainingSpec(await readJson(options.spec))
if (originalController.schemaVersion !== 2 || originalSpec.schemaVersion !== 2) throw new Error('Use a v2 controller and frozen v2 model-training spec')
const profileInput = await readJson(options.profile)
// Only this derived digest may be authored automatically; runtime pins and GPU
// identities must already be observed and explicitly supplied by the operator.
if (profileInput.endpoint?.serviceConfig?.engine_digest === 'derive') profileInput.endpoint.serviceConfig.engine_digest = digestJson({
  environmentDigest: profileInput.runtimeLock.environmentDigest, engineArgs: profileInput.engineArgs,
})
const profile = parseNativeDeploymentProfile(profileInput)
const integer = (flag, fallback) => {
  const value = Number(options[flag] ?? fallback)
  if (!Number.isSafeInteger(value) || value < (flag === 'run-recoveries' ? 0 : 1)) throw new Error('Invalid ' + flag)
  return value
}
const { evaluationBindings: _external, managedNative: _oldManaged, ...baseController } = originalController
const controller = parseTrainingControllerConfig({ ...baseController, managedNative: profile })
const proposals = options.proposals ? await readJson(options.proposals) : [{ id: 'declared-base', sourceRef: originalSpec.trainer.hyperparametersRef }]
const spec = parseModelTrainingSpec({ ...originalSpec,
  endpointPreparation: { mode: 'managed-native', profileDigest: digestJson(profile) },
  iteration: { schemaVersion: 1, maxRounds: integer('max-rounds', 5), maxWallClockSeconds: integer('wall-seconds', 28800),
    maxConsecutiveRejected: integer('max-rejected', 2), onRejected: 'next-declared-proposal-or-stop',
    onInconclusive: 'bounded-repair-or-stop', autoPublish: false,
    recovery: { maxRunRecoveries: integer('run-recoveries', 1), maxEvaluationAttempts: integer('evaluation-attempts', 2) }, proposals },
  evaluation: { ...originalSpec.evaluation, common: { ...originalSpec.evaluation.common,
    runtimeDigest: digestJson(profile.endpoint.serviceConfig), protocolDigest: digestJson({ api: profile.endpoint.api }),
    samplingDigest: digestJson(profile.endpoint.generation) } },
})
const store = new ModelTrainingStore(controller.storeRoot)
await validateIterationTrainingSchedule(store, spec, parseModelVersion(await store.readJson(spec.initialModel)))
trainingController(controller, spec, store) // Constructor validation only; no submit, deployment or network call.
const output = resolve(options.output)
await mkdir(output, { recursive: true })
const files = { 'controller.json': controller, 'spec.json': spec, 'native-profile.json': profile,
  'node-profile.patch.json': { nativeDeploymentProfiles: { [profile.name]: profile } } }
for (const [name, value] of Object.entries(files)) await writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
process.stdout.write(JSON.stringify({ output, profileDigest: digestJson(profile), files: Object.keys(files),
  runtimeValidation: spec.trainer.runtimeLock.validation, started: false }, null, 2) + '\n')
