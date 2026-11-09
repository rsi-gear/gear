/** Per-call resource SDK binding; never changes the process environment. */
export interface HitchResourceSdkBinding {
  executable: string
  controllerRuntimeId?: string
}
export const resourceSdkEnvironment = (binding: HitchResourceSdkBinding): NodeJS.ProcessEnv => ({
  GEAR_HITCH_EXECUTABLE: binding.executable,
  GEAR_HITCH_CONTROLLER_RUNTIME_ID: binding.controllerRuntimeId,
})
