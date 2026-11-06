import { DshHarnessAdapter } from '../adapters/dsh/harness.js'
import { PiHarnessAdapter } from '../adapters/pi/harness.js'
import type { HarnessAdapter } from '../ports/harness.js'

export function harnessAdapter(id: string): HarnessAdapter {
  if (id === 'dsh') return new DshHarnessAdapter()
  if (id === 'pi') return new PiHarnessAdapter()
  throw new TypeError(`Unsupported Target adapter: ${id}`)
}
