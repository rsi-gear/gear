import { cp, mkdir, readFile, writeFile, lstat, readdir, realpath } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, relative, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { command } from './common.mjs'
import { assert, digest, sha, sourcePath, seal } from './contracts.mjs'
import { atomicJson, json } from './store.mjs'
import { researchConfig } from './research-config.mjs'

export const upstreamRevision = '507f92e1138bb6e40dac5c6ee7a6758e6424bf97'
const graders = {
  'mlebench.competitions.nomad2018-predict-transparent-conductors.grade:grade': 'mean-column-wise-rmsle',
  'mlebench.competitions.tabular-playground-series-may-2022.grade:grade': 'auc-roc',
  'mlebench.competitions.titanic.grade:grade': 'accuracy',
}
export async function fileHash(path, algorithm = 'sha256') {
  const info = await lstat(path)
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'expected regular dataset file')
  const hash = createHash(algorithm)
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return (algorithm === 'sha256' ? 'sha256:' : '') + hash.digest('hex')
}
async function within(root, path) {
  const actual = await realpath(path), base = await realpath(root)
  assert(actual.startsWith(base + sep), 'MLE-bench path escapes its declared root')
  return actual
}
export async function treeManifest(directory) {
  const files = []
  const visit = async prefix => {
    for (const name of (await readdir(join(directory, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, absolute = join(directory, path), info = await lstat(absolute)
      sourcePath(path); assert(!info.isSymbolicLink(), 'symlinks are not dataset inputs')
      if (info.isDirectory()) await visit(path)
      else { assert(info.size <= 1024 ** 3, 'input file exceeds the 1 GiB runtime profile'); files.push({ path, digest: await fileHash(absolute), bytes: info.size }) }
    }
  }
  await visit(''); return files
}

export async function inspectMlebench({ repository, dataRoot, competition, fixture = false }) {
  repository = resolve(repository); dataRoot = resolve(dataRoot)
  assert(/^[a-z0-9][a-z0-9-]*$/.test(competition), 'invalid competition ID')
  const definition = await within(repository, join(repository, 'mlebench/competitions', competition)), configPath = join(definition, 'config.yaml')
  const config = yaml.load(await readFile(configPath, 'utf8'))
  assert(config.id === competition && config.competition_type === 'simple' && config.grader?.name === graders[config.grader?.grade_fn], 'unsupported grader; register and test its metric contract before execution')
  const description = await within(repository, resolve(repository, config.description)), descriptionText = await readFile(description, 'utf8')
  const publicDir = await within(dataRoot, join(dataRoot, competition, 'prepared/public'))
  const privateDir = await within(dataRoot, join(dataRoot, competition, 'prepared/private'))
  const answers = await within(privateDir, resolve(dataRoot, config.dataset.answers))
  const sampleSubmission = await within(publicDir, resolve(dataRoot, config.dataset.sample_submission))
  const goldSubmission = config.dataset.gold_submission ? await within(privateDir, resolve(dataRoot, config.dataset.gold_submission)) : answers
  const checksums = yaml.load(await readFile(join(definition, 'checksums.yaml'), 'utf8'))
  if (!fixture) for (const [role, directory] of [['public', publicDir], ['private', privateDir]]) {
    assert(checksums[role] && Object.keys(checksums[role]).length > 0, 'missing prepared-data checksums')
    const required = role === 'public' ? ['train.csv', 'test.csv', relative(directory, sampleSubmission)]
      : [relative(directory, answers), relative(directory, goldSubmission)]
    assert(required.every(path => Object.hasOwn(checksums[role], path)), 'checksums omit a required table')
    for (const [path, expected] of Object.entries(checksums[role])) {
      sourcePath(path); const actual = await within(directory, join(directory, path))
      assert(await fileHash(actual, 'md5') === expected, `MLE-bench checksum mismatch: ${role}/${path}`)
    }
  }
  const sourceRevision = await command('git', ['rev-parse', 'HEAD'], { cwd: repository })
  const sourceFiles = ['config.yaml', 'prepare.py', 'grade.py', 'checksums.yaml']
  const definitionFiles = await Promise.all(sourceFiles.map(async path => ({ path, digest: await fileHash(join(definition, path)) })))
  definitionFiles.push({ path: 'description.md', digest: sha(descriptionText) })
  // Recognized function names alone cannot authorize silently changed grading code.
  const trusted = JSON.parse(await readFile(new URL('../fixtures/mlebench-graders.json', import.meta.url)))
  assert(trusted.graders[config.grader.grade_fn] === definitionFiles.find(f => f.path === 'grade.py').digest, 'grader source differs from the certified MLE-bench metric')
  for (const [path, expected] of Object.entries(trusted.helpers)) {
    const actual = await fileHash(await within(repository, join(repository, path)))
    assert(actual === expected, 'MLE-bench grading helper changed; re-certify metric compatibility')
    definitionFiles.push({ path, digest: actual })
  }
  if (!fixture && competition !== 'titanic') for (const name of ['config.yaml', 'prepare.py', 'checksums.yaml'])
    assert(definitionFiles.find(f => f.path === name).digest === trusted.definitions[competition]?.[name], 'official preparation definition changed; cannot label this upstream data')
  const publicFiles = await treeManifest(publicDir)
  assert(publicFiles.some(f => f.path === 'train.csv') && publicFiles.some(f => f.path === 'test.csv'), 'tabular public train.csv/test.csv required')
  const descriptor = seal({ protocol: 'mlebench-import@1', competitionId: competition, sourceRevision,
    definitionDigest: digest(definitionFiles), publicTreeDigest: digest(publicFiles),
    privateAnswersDigest: await fileHash(answers), goldSubmissionDigest: await fileHash(goldSubmission),
    metric: config.grader.name, direction: config.grader.name === 'mean-column-wise-rmsle' ? 'minimize' : 'maximize',
    verification: fixture ? 'fixture' : competition === 'titanic' ? 'custom-checksums' : 'upstream-checksums',
    definitionFiles, publicFiles })
  return { descriptor, config, repository, definition, public: publicDir, answers, goldSubmission, sampleSubmission, description: descriptionText }
}

export async function importMlebench(options, out) {
  const imported = await inspectMlebench(options), d = imported.descriptor
  await mkdir(out, { recursive: true })
  await cp(imported.public, join(out, 'public'), { recursive: true, errorOnExist: true, force: false })
  await writeFile(join(out, 'public/description.md'), imported.description, { flag: 'wx' })
  const metadata = { competitionId: d.competitionId, public: join(out, 'public'), answers: imported.answers,
    sampleSubmission: join(out, 'public', relative(imported.public, imported.sampleSubmission)), metric: d.metric,
    trainDigest: d.publicFiles.find(f => f.path === 'train.csv').digest, validation: researchConfig(options.research).validation }
  await atomicJson(join(out, 'import-input.json'), metadata)
  await command(options.python ?? 'python3', [fileURLToPath(new URL('../mlebench-data.py', import.meta.url)),
    '--metadata', join(out, 'import-input.json'), '--out', out])
  const prepared = await json(join(out, 'prepared.json'))
  const assets = (await treeManifest(join(out, 'public'))).filter(f => !['train.csv', 'test.csv'].includes(f.path)).map(file => {
    const parts = file.path.split('/'), role = parts.length > 2 && ['train', 'test'].includes(parts[0]) ? parts[0] === 'train' ? 'train' : 'predict' : 'shared'
    return { ...file, role, rowId: role === 'shared' ? null : parts[1] }
  })
  const benchmark = { format: 'mle-bench', competitionId: d.competitionId, definitionDigest: d.definitionDigest,
    publicTreeDigest: d.publicTreeDigest, sourceRevision: d.sourceRevision, verification: d.verification }
  await atomicJson(join(out, 'mlebench.json'), imported.descriptor)
  return { ...prepared, publicFiles: assets, benchmark, description: imported.description, scope: 'mle-bench-public',
    train: join(out, 'public/train.csv'), predict: join(out, 'public/test.csv'), expected: join(out, 'private/expected.csv'), publicDirectory: join(out, 'public') }
}
