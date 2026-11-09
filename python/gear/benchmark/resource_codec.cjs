// Resource identity belongs to Hitch. This bridge deliberately uses its public
// SDK instead of reimplementing resource locks, trees or dataset hash domains.
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
async function main() {
  const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
  const executable = process.env.GEAR_HITCH_EXECUTABLE || 'hitch'
  let resolved
  for (const directory of executable.includes(path.sep) ? [''] : (process.env.PATH || '').split(path.delimiter)) {
    try { resolved = await fs.realpath(path.resolve(directory, executable)); break } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!resolved) throw new Error('Install Hitch with its public resources SDK or set GEAR_HITCH_EXECUTABLE')
  let root = path.dirname(resolved), metadata
  for (;;) {
    try { metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (metadata?.name === 'agent-hitch') break
    if (path.dirname(root) === root) throw new Error('Hitch executable must belong to an installed agent-hitch package')
    root = path.dirname(root)
  }
  const open = async namespace => {
    const entry = metadata.exports?.[namespace]
    if (typeof entry !== 'string' || !path.resolve(root, entry).startsWith(root + path.sep)) throw new Error('Hitch lacks the required public SDK')
    return import(pathToFileURL(path.resolve(root, entry)).href)
  }
  const controller = await open('./controller-runtime')
  if (typeof controller.observeControllerRuntime !== 'function') throw new Error('Hitch lacks controller runtime observation')
  const expected = process.env.GEAR_HITCH_CONTROLLER_RUNTIME_ID
  if (expected !== undefined && !/^sha256:[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid bound Hitch controller runtime identity')
  const before = await controller.observeControllerRuntime(root)
  if (typeof before.runtime_id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(before.runtime_id) || (expected && before.runtime_id !== expected)) throw new Error('Resource SDK differs from the bound Hitch controller runtime')
  const namespace = input.operation === 'candidate-inputs' ? './parameters' : './resources'
  const sdk = await open(namespace)
  const names = { verify: 'verifyResourceDatasetSource', derive: 'deriveResourceDatasetSource', 'candidate-inputs': 'prepareParameterCandidateInputs' }
  const fn = sdk[names[input.operation]]
  if (typeof fn !== 'function') throw new Error('Upgrade Hitch to the task contract resource SDK')
  const args = input.operation === 'candidate-inputs'
    ? [input.directory, input.candidateInputPath]
    : [input.directory, input.manifest, input.taskIds]
  const result = await fn(...args)
  const after = await controller.observeControllerRuntime(root)
  if (after.runtime_id !== before.runtime_id) throw new Error('Hitch resource SDK changed during the operation')
  process.stdout.write(JSON.stringify(result ?? null))
}
main().catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1 })
