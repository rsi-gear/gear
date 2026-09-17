import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const registry = 'https://registry.npmjs.org/'
const numeric = '(?:0|[1-9][0-9]*)'
const prereleaseIdentifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const versionPattern = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?$`, 'u')

export function releaseMetadata(pkg, lock) {
  if (pkg.name !== 'rsi-gear' || pkg.private === true || !versionPattern.test(pkg.version ?? '')) {
    throw new Error('Expected a public rsi-gear package with a canonical release version')
  }
  if (pkg.repository?.url !== 'git+https://github.com/rsi-gear/gear.git') {
    throw new Error('repository.url must match rsi-gear/gear for npm trusted publishing')
  }
  for (const entry of [lock, lock.packages?.['']]) {
    if (entry?.name !== pkg.name || entry?.version !== pkg.version) {
      throw new Error('package.json and package-lock.json must have matching names and versions')
    }
  }
  return { name: pkg.name, version: pkg.version, tag: pkg.version.includes('-') ? 'next' : 'latest' }
}

export async function planRelease(pkg, lock, request = fetch) {
  const metadata = releaseMetadata(pkg, lock)
  const url = `${registry}${encodeURIComponent(metadata.name)}/${encodeURIComponent(metadata.version)}`
  const response = await request(url, { signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) return { ...metadata, publish: true }
  if (!response.ok) throw new Error(`npm version lookup failed: HTTP ${response.status}`)
  const published = await response.json()
  if (published.name !== metadata.name || published.version !== metadata.version) {
    throw new Error('npm returned unexpected package metadata')
  }
  return { ...metadata, publish: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const plan = await planRelease(pkg, lock)
  const summary = plan.publish
    ? `Publish ${plan.name}@${plan.version} with npm tag ${plan.tag}.`
    : `Skip: ${plan.name}@${plan.version} is already published. Bump the version for a new release.`
  console.log(summary)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${plan.publish}\ntag=${plan.tag}\nversion=${plan.version}\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
}
