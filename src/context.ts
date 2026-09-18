import type { NotebookRuntime } from './notebook/runtime.js'
import type { RefineService } from './refine/service.js'
import type { TargetWorkerRegistry } from './worker/registry.js'
import type { ComponentRegistry } from './evolution/components.js'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context {
    refine: RefineService
    notebookRuntime: NotebookRuntime
    targetWorkers: TargetWorkerRegistry
    evolutionComponents: ComponentRegistry
  }
}

export {}
