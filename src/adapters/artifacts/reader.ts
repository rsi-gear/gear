import { isAbsolute } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { ArtifactReaderDescriptor } from '../../domain/trajectory.js'
import type { ArtifactReader } from '../../ports/trajectory.js'
import { HITCH_TRAJECTORY, HitchArtifactReader } from '../hitch/trajectory.js'

/** Closed registry: trial locators never choose a program, configuration or host path. */
export function artifactReader(descriptor: ArtifactReaderDescriptor): ArtifactReader {
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
  if (canonicalDigest(reader.descriptor) !== canonicalDigest(descriptor))
    throw new GearError('artifact-reader-changed', 'Artifact reader implementation changed since admission')
  return reader
}
