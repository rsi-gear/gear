// Synthetic, reduced-size data. The config/preparer/grader bytes are upstream.
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { command } from '../../kaggle-titanic/common.mjs'
export const competitions = ['nomad2018-predict-transparent-conductors', 'tabular-playground-series-may-2022']
export async function fixture(root, competition) {
  const repository = join(root, 'repository'), dataRoot = join(root, 'data')
  await mkdir(join(repository, 'mlebench/competitions'), { recursive: true })
  await cp(new URL(`../fixtures/mlebench/${competition}`, import.meta.url), join(repository, 'mlebench/competitions', competition), { recursive: true })
  await cp(new URL('../fixtures/mlebench/helpers', import.meta.url), repository, { recursive: true })
  await command('git', ['init', '-q'], { cwd: repository })
  await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '--no-gpg-sign', '-qm', 'Fixture definition'], { cwd: repository })
  const publicDir = join(dataRoot, competition, 'prepared/public'), privateDir = join(dataRoot, competition, 'prepared/private')
  await mkdir(publicDir, { recursive: true }); await mkdir(privateDir, { recursive: true })
  const nomad = competition === competitions[0]
  const targets = nomad ? ['formation_energy_ev_natom', 'bandgap_energy_ev'] : ['target']
  const features = nomad ? ['spacegroup', 'number_of_total_atoms', 'percent_atom_al', 'percent_atom_ga', 'percent_atom_in',
    'lattice_vector_1_ang', 'lattice_vector_2_ang', 'lattice_vector_3_ang', 'lattice_angle_alpha_degree', 'lattice_angle_beta_degree', 'lattice_angle_gamma_degree']
    : Array.from({ length: 31 }, (_, i) => `f_${String(i).padStart(2, '0')}`)
  const featureValues = i => features.map((_, j) => !nomad && j === 27 ? 'ABBA' : (i + j) % 7)
  const labels = i => nomad ? [i / 10, i / 3] : [i % 2]
  const train = Array.from({ length: 20 }, (_, i) => [nomad ? i + 1 : i, ...featureValues(i), ...labels(i)])
  // Separate namespaces: NOMAD training and query IDs intentionally overlap.
  const test = Array.from({ length: 4 }, (_, i) => [nomad ? i + 1 : 20 + i, ...featureValues(i)])
  const answers = test.map((row, i) => [...row, ...labels(i + 1)])
  const csv = (columns, rows) => [columns.join(','), ...rows.map(r => r.join(',')), ''].join('\n')
  await writeFile(join(publicDir, 'train.csv'), csv(['id', ...features, ...targets], train))
  await writeFile(join(publicDir, 'test.csv'), csv(['id', ...features], test))
  await writeFile(join(publicDir, 'sample_submission.csv'), csv(['id', ...targets], test.map(r => [r[0], ...targets.map(() => .5)])))
  await writeFile(join(privateDir, 'test.csv'), csv(['id', ...features, ...targets], answers))
  if (!nomad) await writeFile(join(privateDir, 'gold_submission.csv'), csv(['id', ...targets], answers.map(r => [r[0], r.at(-1)])))
  if (nomad) for (const [role, rows] of [['train', train], ['test', test]]) for (const row of rows) {
    const path = join(publicDir, role, String(row[0])); await mkdir(path, { recursive: true })
    await writeFile(join(path, 'geometry.xyz'), `${role}-${row[0]}\natom 0 0 0 Al\n`)
  }
  return { repository, dataRoot, competition, fixture: true, publicDir, privateDir }
}
