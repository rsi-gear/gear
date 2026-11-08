import { isAbsolute } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { ArtifactReaderDescriptor } from '../../domain/trajectory.js'
import type { ArtifactReader } from '../../ports/trajectory.js'
import { HITCH_TRAJECTORY, HitchArtifactReader } from '../hitch/trajectory.js'

/** Closed registry: trial locators never choose a program, configuration or host path. */
export function bindArtifactReader(
  descriptor: Omit<ArtifactReaderDescriptor, 'implementation_identity'> & {
    implementation_identity?: string
  },
): ArtifactReader {
  const config = descriptor.configuration as { executable?: unknown; root?: unknown } | null
  if (
    descriptor.format !== HITCH_TRAJECTORY ||
    !config ||
    typeof config.executable !== 'string' ||
    typeof config.root !== 'string' ||
    !isAbsolute(config.executable) ||
    !isAbsolute(config.root) ||
    Object.keys(config).some((key) => !['executable', 'root'].includes(key))
  )
    throw new GearError('artifact-reader-unavailable', 'No supported frozen artifact reader is configured')
  const reader = new HitchArtifactReader(config.executable, config.root)
  if (
    descriptor.implementation_identity !== undefined &&
    canonicalDigest(reader.descriptor) !== canonicalDigest(descriptor)
  )
    throw new GearError('artifact-reader-changed', 'Artifact reader implementation changed since admission')
  return reader
}

/** Persisted admissions must retain the implementation identity frozen at connection. */
export function artifactReader(descriptor: ArtifactReaderDescriptor): ArtifactReader {
  if (typeof descriptor.implementation_identity !== 'string')
    throw new GearError('artifact-reader-changed', 'Frozen artifact reader identity is missing')
  return bindArtifactReader(descriptor)
}
