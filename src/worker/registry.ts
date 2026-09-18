import type { HarnessBuilder } from '../harness/builder.js'
import type { RefineService } from '../refine/service.js'
import { TargetWorkerManager, type TargetWorkerLaunch } from './manager.js'

export type CurrentTargetWorkerLaunch = Omit<TargetWorkerLaunch, 'targetHarnessRef' | 'targetManifestDigest'>

export class TargetWorkerRegistry {
  private readonly managers = new Map<string, TargetWorkerManager>()

  constructor(
    private readonly refine: RefineService,
    private readonly builder: HarnessBuilder,
  ) {}

  async createCurrent(launch: CurrentTargetWorkerLaunch): Promise<TargetWorkerManager> {
    const published = await this.refine.registry.readPublished()
    if (published === undefined) throw new Error('no workspace-wide published harness is available')
    if (published.sourceEvolutionId === undefined) {
      throw new Error('published harness has no native source evolution; republish it from an active evolution before launching current')
    }
    return this.launch(published.sourceEvolutionId, {
      ...launch,
      targetHarnessRef: published.ref,
      targetManifestDigest: published.manifestDigest,
    })
  }

  async createForEvolution(evolutionId: string, launch: CurrentTargetWorkerLaunch): Promise<TargetWorkerManager> {
    const store = this.refine.registry.stateStore(evolutionId)
    const champion = await store.readChampion()
    if (champion === undefined) throw new Error('no champion is initialized for a new target worker')
    return this.create(evolutionId, {
      ...launch,
      targetHarnessRef: champion.ref,
      targetManifestDigest: champion.manifestDigest,
    })
  }

  async create(evolutionId: string, launch: TargetWorkerLaunch): Promise<TargetWorkerManager> {
    const store = this.refine.registry.stateStore(evolutionId)
    const allowed = await this.isAcceptedRef(store, launch.targetHarnessRef)
    if (!allowed) throw new Error(`target worker ref is neither champion nor an accepted historical commit: ${launch.targetHarnessRef}`)
    return this.launch(evolutionId, launch)
  }

  private async launch(evolutionId: string, launch: TargetWorkerLaunch): Promise<TargetWorkerManager> {
    const key = this.key(evolutionId, launch.workerId)
    if (this.managers.has(key)) throw new Error(`target worker already exists in evolution ${evolutionId}: ${launch.workerId}`)
    const store = this.refine.registry.stateStore(evolutionId)
    const manifest = await this.builder.readManifest(launch.targetHarnessRef)
    if (manifest.digest !== launch.targetManifestDigest) throw new Error('target worker manifest digest does not match its Git commit')
    const manager = new TargetWorkerManager(launch, this.refine, store, evolutionId)
    this.managers.set(key, manager)
    try {
      await manager.start()
      return manager
    } catch (error) {
      this.managers.delete(key)
      await manager.dispose().catch(() => {})
      throw error
    }
  }

  get(evolutionId: string, workerId: string): TargetWorkerManager | undefined {
    return this.managers.get(this.key(evolutionId, workerId))
  }

  async remove(evolutionId: string, workerId: string): Promise<void> {
    const key = this.key(evolutionId, workerId)
    const manager = this.managers.get(key)
    if (manager === undefined) return
    this.managers.delete(key)
    await manager.dispose()
  }

  async dispose(): Promise<void> {
    const managers = [...this.managers.values()]
    this.managers.clear()
    await Promise.all(managers.map(manager => manager.dispose()))
  }

  private async isAcceptedRef(store: import('../state/store.js').RefineStateStore, ref: string): Promise<boolean> {
    if ((await store.readChampion())?.ref === ref) return true
    return (await store.listRounds()).some(round => round.status === 'accepted'
      && round.decision === 'accepted'
      && round.candidatePool.some(candidate => candidate.sealedVersion?.commitOid === ref))
  }

  private key(evolutionId: string, workerId: string): string { return `${evolutionId}\u0000${workerId}` }
}
