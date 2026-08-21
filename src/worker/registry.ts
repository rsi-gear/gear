import type { HarnessBuilder } from '../harness/builder.js'
import type { RefineService } from '../refine/service.js'
import type { RefineStateStore } from '../state/store.js'
import { TargetWorkerManager, type TargetWorkerLaunch } from './manager.js'

export type CurrentTargetWorkerLaunch = Omit<TargetWorkerLaunch, 'targetHarnessRef' | 'targetManifestDigest'>

export class TargetWorkerRegistry {
  private readonly managers = new Map<string, TargetWorkerManager>()

  constructor(
    private readonly refine: RefineService,
    private readonly store: RefineStateStore,
    private readonly builder: HarnessBuilder,
  ) {}

  async createCurrent(launch: CurrentTargetWorkerLaunch): Promise<TargetWorkerManager> {
    const champion = await this.store.readChampion()
    if (champion === undefined) throw new Error('no champion is initialized for a new target worker')
    return this.create({
      ...launch,
      targetHarnessRef: champion.ref,
      targetManifestDigest: champion.manifestDigest,
    })
  }

  async create(launch: TargetWorkerLaunch): Promise<TargetWorkerManager> {
    if (this.managers.has(launch.workerId)) throw new Error(`target worker already exists: ${launch.workerId}`)
    const allowed = await this.isAcceptedRef(launch.targetHarnessRef)
    if (!allowed) throw new Error(`target worker ref is neither champion nor an accepted historical commit: ${launch.targetHarnessRef}`)
    const manifest = await this.builder.readManifest(launch.targetHarnessRef)
    if (manifest.digest !== launch.targetManifestDigest) throw new Error('target worker manifest digest does not match its Git commit')
    const manager = new TargetWorkerManager(launch, this.refine, this.store)
    this.managers.set(launch.workerId, manager)
    try {
      await manager.start()
      return manager
    } catch (error) {
      this.managers.delete(launch.workerId)
      await manager.dispose().catch(() => {})
      throw error
    }
  }

  get(workerId: string): TargetWorkerManager | undefined {
    return this.managers.get(workerId)
  }

  async remove(workerId: string): Promise<void> {
    const manager = this.managers.get(workerId)
    if (manager === undefined) return
    this.managers.delete(workerId)
    await manager.dispose()
  }

  async dispose(): Promise<void> {
    const managers = [...this.managers.values()]
    this.managers.clear()
    await Promise.all(managers.map(manager => manager.dispose()))
  }

  private async isAcceptedRef(ref: string): Promise<boolean> {
    if ((await this.store.readChampion())?.ref === ref) return true
    return (await this.store.listRounds()).some(round => round.status === 'accepted'
      && round.decision === 'accepted' && round.candidateRef === ref)
  }
}
