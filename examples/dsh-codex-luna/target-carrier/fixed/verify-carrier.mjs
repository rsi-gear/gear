import { access, readFile } from 'node:fs/promises'

await access(new URL('../apps/cli/lib/bin.js', import.meta.url))
await access(new URL('./target-loader.js', import.meta.url))
await access(new URL('./target-loader-shim.js', import.meta.url))
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (pkg.dependencies?.['@deepseek-ai/dsh'] !== '0.1.5-rc.3') {
  throw new Error('target carrier must pin @deepseek-ai/dsh@0.1.5-rc.3')
}
if (pkg.dependencies?.['@deepseek-ai/dsh-tools'] !== '0.1.5-rc.3') {
  throw new Error('target carrier must expose @deepseek-ai/dsh-tools@0.1.5-rc.3 for native tool authoring')
}
if (pkg.dependencies?.['@deepseek-ai/cordis-plugin-include'] !== '1.0.7') {
  throw new Error('target carrier must pin @deepseek-ai/cordis-plugin-include@1.0.7')
}
if (pkg.dependencies?.['dsh-codex'] !== '0.3.0' || pkg.dependencies?.['@earendil-works/pi-ai'] !== '0.85.1') {
  throw new Error('target carrier must pin dsh-codex@0.3.0 and pi-ai@0.85.1')
}
