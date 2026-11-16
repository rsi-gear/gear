import type { ScreeningProjection } from '../../domain/operator-run.js'
import type { ScreeningProjector } from '../../ports/operator-effects.js'
import { PythonAlgorithmWorker, type PythonWorkerOptions } from './worker.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Never shares interpreter globals or writable scratch with the proposing algorithm. */
export class IndependentScreening implements ScreeningProjector {
  constructor(readonly options: PythonWorkerOptions) {}
  async screen(input: ScreeningProjection, signal: AbortSignal) {
    const scratch = await mkdtemp(join(this.options.scratch, 'invocation-'))
    const worker = new PythonAlgorithmWorker({ ...this.options, scratch, protocolVersion: 2 })
    try {
      await worker.start(signal)
      return await worker.screen(input, signal)
    } finally {
      await worker.dispose()
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
