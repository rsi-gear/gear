import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { verifierFixture } from './verifier-evidence.mjs'

/** Executable protocol double for the daemon's ordered eval-control v2 contract. */
export function runOrderedHitchFixture(runtimeIdentity) {
  const args = process.argv.slice(2), root = args[1], command = args[2], action = args[3]
  const file = join(root, 'remote.json')
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  state.controls ??= {}; state.jobsById ??= {}; state.commands ??= []
  state.commands.push({ action: command === 'eval' ? action : command, args })
  const save = () => writeFileSync(file, JSON.stringify(state))
  const emit = value => { save(); process.stdout.write(JSON.stringify(value)) }
  const fail = () => { save(); process.exit(1) }
  const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 32)
  const option = name => args[args.indexOf(name) + 1]
  const repeated = name => args.flatMap((arg, index) => arg === name ? [args[index + 1]] : [])
  const trial = job => ({ task_id: 'a', attempt: 1, run_id: 'run_' + hash(job.eval_id), observation_status: 'valid', reward: state.reward ?? 0,
    ...(state.verifier ? { trial_id: 'trial_' + hash(job.eval_id), verifier_result_ref: 'verifier/result.json', scores: { normalization: 'standard', total_score: state.reward ?? 0, process_score: 0.5 } } : {}),
    ...(state.quality === undefined ? {} : { process_quality: state.quality }) })
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
  const digest = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex')
  const controller = { schema_version: '2', package_version: '0.2.9', node_version: 'v22.0.0', runtime_id: state.controllerId ?? digest('controller'),
    source: { kind: 'unavailable', commit: null, dirty: null } }
  const worker = { provider: 'local-docker', worker_id: 'local', collision_domain_id: 'fixture-engine', health: 'healthy' }
  const environment = { schema_version: '2', host_platform: 'darwin-arm64',
    harbor: { status: 'available', version: '0.21.0', executable_digest: state.harborDigest ?? digest('harbor') },
    docker: { status: 'available', version: '28.1.0', executable_digest: digest('docker'), engine_id: state.engineId ?? 'fixture-engine', os: 'linux', architecture: 'aarch64' },
    buildx: { status: 'unavailable', version: null }, sandbox: { status: 'unverified' } }
  const artifactFor = job => ({ artifact_id: job.artifactId ?? digest('prepared-target'), artifact_integrity: digest('dependencies-and-files'),
    entrypoint_integrity: digest('launcher'), harness_id: job.request.harness_ref.split('@')[0], revision_identity: runtimeIdentity,
    platform: 'linux-arm64', node_version: 'v22.23.0', source_type: 'npm', storage: 'harbor-artifact-cache-v2' })
  const instance = state.daemonInstance ?? 'a'.repeat(32)
  const control = () => {
    const path = args[args.indexOf(action === 'submit' ? '--control-file' : '--file') + 1]
    const intent = JSON.parse(readFileSync(path, 'utf8')), prior = state.controls[intent.key]
    if (intent.schema_version !== '2' || !['start', 'pause'].includes(intent.action) ||
      prior && (intent.subject_digest !== prior.subject_digest || intent.sequence < prior.sequence ||
        intent.sequence === prior.sequence && intent.action !== prior.action)) fail()
    const value = { ...intent, eval_id: prior?.eval_id ?? 'eval_' + hash(intent.key) }
    state.controls[intent.key] = value
    return value
  }
  const reply = value => ({ ...value, submitted: !!state.jobsById[value.eval_id], pending_reruns: false })
  if (command === 'resolve') emit({ identity: runtimeIdentity })
  else if (command === 'capabilities') emit({ schema_version: '1', ordered_eval_control: '2', controller_runtime_observation: '2', local_execution_observation: '2', evaluation_environment_binding: '3', evaluation_preparation: '1', evaluation_artifact_pins: '1', ...(state.verifier ? { verifier_evidence: '1' } : {}) })
  else if (command === 'eval' && action === 'bind') emit({ schema_version: '1', provider: 'local-docker', nonce: 'b'.repeat(32), daemon_instance_id: instance, binding: { schema_version: '1', binding_id: state.environmentBinding ?? 'hmac-sha256:' + digest('resident-environment').slice(7), model: option('--model'), pass_env: [...new Set(repeated('--pass-env'))].sort(), expires_at_ms: null } })
  else if (command === 'daemon') emit({ status: 'running', instance_id: instance })
  else if (command === 'training' && action === 'runtime') emit(controller)
  else if (command === 'worker' && action === 'list') emit({ workers: [worker] })
  else if (command === 'worker' && action === 'observe') {
    const response = { schema_version: '2', nonce: option('--nonce'), provider: worker.provider, worker_id: worker.worker_id,
      collision_domain_id: worker.collision_domain_id, generation: null, daemon_instance_id: instance,
      daemon_runtime: { schema_version: '2', startup: controller, current: controller, unchanged: true }, environment, environment_digest: digest(environment) }
    for (const { path, value } of state.observationMutations ?? []) {
      let target = response
      for (const name of path.slice(0, -1)) target = target[name]
      target[path.at(-1)] = value
    }
    emit(response)
  }
  else if (command === 'verifier' && action === 'inspect') {
    if (state.verifierUnavailable) fail()
    const job = Object.values(state.jobsById).find(job => 'run_' + hash(job.eval_id) === args[4])
    if (!job) fail()
    const value = verifierFixture(trial(job), job.eval_id)
    if (state.verifierWrongRun) value.run_id = 'run_' + 'c'.repeat(32)
    if (state.verifierChanged) value.verifier.process.components[1].code = 'different-check'
    emit(value)
  }
  else if (action === 'control') {
    const value = control(), job = state.jobsById[value.eval_id]
    if (value.action === 'pause' && job) job.state = state.cancelPending ? 'cancelling' : 'cancelled'
    if (value.action === 'pause' && state.losePauseReply) { state.losePauseReply = false; fail() }
    emit(reply(value))
  } else if (action === 'submit') {
    const value = control()
    if (value.action !== 'start') fail()
    if (option('--environment-binding') !== (state.environmentBinding ?? 'hmac-sha256:' + digest('resident-environment').slice(7))) fail()
    const artifactPins = repeated('--artifact-pin').map(value => JSON.parse(value))
    if (!state.ignoreArtifactPins) {
      const artifact = artifactFor({ request: { harness_ref: option('--harness') }, artifactId: state.artifactIds?.[state.jobs ?? 0] ?? state.preparedArtifactId })
      const pin = Object.fromEntries(['platform', 'artifact_id', 'artifact_integrity', 'entrypoint_integrity'].map(key => [key, artifact[key]]))
      if (canonical(artifactPins) !== canonical([pin])) { state.pinRejections = (state.pinRejections ?? 0) + 1; fail() }
    }
    state.submissions = (state.submissions ?? 0) + 1
    if (!state.jobsById[value.eval_id]) {
      const request = { schema_version: '1', backend: 'harbor', dataset: option('--dataset'),
        harness_ref: option('--harness'), model: option('--model'), environment_binding: option('--environment-binding'), artifact_pins: artifactPins, attempts: Number(option('--attempts')),
        max_concurrent: Number(option('--max-concurrent')), infrastructure_retries: Number(option('--infrastructure-retries')),
        timeout_ms: Number(option('--timeout').replace(/ms$/, '')), setup_timeout_ms: Number(option('--setup-timeout')?.replace(/ms$/, '') ?? 1800000), agent_args: repeated('--agent-arg'), pass_env: repeated('--pass-env') }
      const job = { eval_id: value.eval_id, dataset: request.dataset, request, controller, artifactId: state.artifactIds?.[state.jobs ?? 0] ?? state.preparedArtifactId, provider: option('--provider'), state: 'succeeded' }
      state.jobsById[value.eval_id] = job; state.job = job; state.jobs = (state.jobs ?? 0) + 1
      if (state.loseSubmitReply) { state.loseSubmitReply = false; fail() }
    }
    emit(reply(value))
  } else if (action === 'inspect') {
    const job = state.jobsById[args[4]]
    if (!job) fail()
    const artifact = artifactFor(job), runtimeContract = { docker_platform: 'linux/arm64', artifact_platform: artifact.platform, node_version: artifact.node_version }
    const artifacts = { prepared_artifact: artifact, prepared_artifacts: [{ ...artifact, task_ids: ['a'], runtime_contract: runtimeContract }] }
    const inspection = { schema_version: '1', eval_id: job.eval_id, request: job.request, resolution: { identity: runtimeIdentity },
      plan: { dataset: job.dataset, candidate: { revision_identity: runtimeIdentity, model: job.request.model,
        harness_id: job.request.harness_ref.split('@')[0], harness_ref: job.request.harness_ref, requested_harness_ref: job.request.harness_ref },
        controller_runtime: { runtime_id: job.controller.runtime_id }, ...structuredClone(artifacts) },
      execution_plan: { provider: job.provider, membership: 'known', work_items: [{ schema_version: '1', work_id: 'work_' + hash(job.eval_id), eval_id: job.eval_id,
        backend: 'harbor', logical_attempt: 1, opaque_membership: false, task_ids: ['a'], provider: job.provider,
        artifact_id: artifact.artifact_id, runtime_contract: structuredClone(runtimeContract) }] },
      control: { eval_id: job.eval_id, state: job.state, active_leases: job.state === 'cancelling' ? ['live-lease'] : [] },
      result: job.state === 'cancelling' ? null : { schema_version: '1', eval_id: job.eval_id, dataset: job.dataset,
        status: job.state, ...structuredClone(artifacts), candidate: { revision_identity: runtimeIdentity, model: job.request.model,
          harness_id: job.request.harness_ref.split('@')[0], harness_ref: job.request.harness_ref, requested_harness_ref: job.request.harness_ref },
        trials: [trial(job)] } }
    if (state.failedResult) Object.assign(inspection.result, { status: 'failed', task_completed: true, failure_stage: 'running', error: { code: 'environment_image_evidence_unavailable', message: 'Immutable image observation unavailable' }, ...state.failedResult });
    for (const key of state.omittedResultFields ?? []) delete inspection.result[key];
    for (const { path, value } of state.inspectionMutations ?? []) {
      let target = inspection
      for (const name of path.slice(0, -1)) target = target[name]
      target[path.at(-1)] = value
    }
    emit(inspection)
  } else if (action === 'watch') emit({ status: 'succeeded' })
  else fail()
}
