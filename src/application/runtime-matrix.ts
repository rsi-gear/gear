/** Tested combinations; capabilities and actual executable identities remain authoritative. */
export const runtimeMatrix = {
  node: '^22.19.0 || >=24.0.0',
  python: '>=3.10',
  harborPython: '>=3.12',
  harbor: '0.21.0',
  harnesses: { dsh: 'deepseek@version:0.1.5-rc.3', pi: 'pi@version:0.84.1' },
  hitch: {
    ordered_eval_control: '2',
    controller_runtime_observation: '2',
    local_execution_observation: '2',
    evaluation_environment_binding: '3',
    evaluation_preparation: '1',
    evaluation_artifact_pins: '1',
  },
  baseImage: 'python:3.12-slim',
  platforms: ['darwin', 'linux'],
} as const
export function supportedNode(version: string): boolean {
  const [major, minor] = version.replace(/^v/u, '').split('.').map(Number)
  return major! >= 24 || (major === 22 && minor! >= 19)
}
