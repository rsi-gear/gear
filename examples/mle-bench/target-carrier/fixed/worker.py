"""Fixed worker supervisor. Generated Python only runs in the credential-free chroot."""
import argparse
import csv
import io
import hashlib
import gzip
import json
import math
import os
from pathlib import Path
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from confinement import UID, confine, log_tail, preflight, regular, stop_children
import scoring


def read_csv(content):
    stream = io.StringIO(content.decode('utf-8-sig'), newline='')
    reader = csv.DictReader(stream)
    fields = reader.fieldnames
    if not fields or len(fields) != len(set(fields)):
        raise ValueError('invalid CSV header')
    rows = list(reader)
    if not rows or any(None in row or any(v is None for v in row.values()) for row in rows):
        raise ValueError('invalid CSV rows')
    return fields, rows


def write_csv(fields, rows):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows([{k: r[k] for k in fields} for r in rows])
    return stream.getvalue().encode()


def validate_predictions(content, schema, expected_ids):
    fields, rows = read_csv(content)
    if fields != [schema['idColumn'], schema['targetColumn']]:
        raise ValueError('unexpected prediction columns')
    predictions = {}
    for row in rows:
        key, value = row[schema['idColumn']], row[schema['targetColumn']]
        if key in predictions or key not in expected_ids or value not in schema['allowedLabels']:
            raise ValueError('invalid prediction ID or label')
        predictions[key] = value
    if set(predictions) != set(expected_ids):
        raise ValueError('incomplete predictions')
    return predictions


def run_python(files, inputs, entrypoint, argv, wall_seconds, cpu_seconds, max_output_bytes=64 * 1024 ** 2):
    preflight()
    if wall_seconds <= 0 or cpu_seconds < 1:
        raise ValueError('worker budget exhausted')
    runtime = Path('/opt/kaggle-runtime')
    work = runtime / 'work'
    work.mkdir(mode=0o755, exist_ok=True)
    logs = Path(tempfile.mkdtemp(prefix='analysis-logs-', dir='/run'))
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    try:
        for name in ('source', 'inputs', 'scratch'):
            (work / name).mkdir(mode=0o755)
        os.chown(work / 'scratch', UID, UID)
        for directory, mapping in [('source', files), ('inputs', inputs)]:
            for name, content in mapping.items():
                parts = name.split('/')
                if any(p in ('', '.', '..') for p in parts) or name.startswith('/'):
                    raise ValueError('unsafe worker input path')
                target = work / directory / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                target.chmod(0o444)
        python = next((p for p in ('/usr/local/bin/python3', '/usr/bin/python3') if (runtime / p[1:]).is_file()), None)
        if not python:
            raise RuntimeError('chroot Python missing')
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/work/scratch', 'TMPDIR': '/work/scratch',
               'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'OMP_NUM_THREADS': '1',
               'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}

        def restrict():
            limit = max(1, math.floor(cpu_seconds - .1))
            resource.setrlimit(resource.RLIMIT_CPU, (limit, limit))
            resource.setrlimit(resource.RLIMIT_AS, (4 * 1024 ** 3, 4 * 1024 ** 3))
            # No child processes: a worker's CPU allowance covers its whole
            # process (including threads), so fork cannot multiply the limit.
            confine(runtime)
            resource.setrlimit(resource.RLIMIT_NPROC, (1, 1))

        with (logs / 'stdout').open('wb') as stdout, (logs / 'stderr').open('wb') as stderr:
            child = subprocess.Popen([python, '-B', '/work/source/' + entrypoint, *argv],
                env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, close_fds=True,
                start_new_session=True, preexec_fn=restrict)
            limited = None
            try:
                while child.poll() is None:
                    if time.monotonic() - started > wall_seconds:
                        limited = 'wall_limit'
                        break
                    sizes = []
                    for path in (work / 'scratch').rglob('*'):
                        try:
                            sizes.append(path.lstat().st_size)
                        except FileNotFoundError:
                            # Training may remove/rename temporary files while
                            # the supervisor enumerates the scratch directory.
                            continue
                    if sum(sizes) > 1024 ** 3 or len(sizes) > 4096:
                        limited = 'disk_limit'
                        break
                    time.sleep(.02)
            finally:
                stop_children()
                child.wait(timeout=5)
        output = {}
        try:
            for p in sorted((work / 'scratch').rglob('*')):
                if p.is_dir() and not p.is_symlink():
                    continue
                output[str(p.relative_to(work / 'scratch'))] = regular(p)
                if sum(map(len, output.values())) > max_output_bytes:
                    raise ValueError('worker outputs exceeded limit')
        except (ValueError, OSError, RuntimeError):
            limited, output = 'invalid_outputs', {}
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        return {'exitCode': child.returncode, 'limit': limited,
                'cpuSeconds': after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime,
                'wallSeconds': time.monotonic() - started,
                'logs': {name: log_tail(logs / name) for name in ('stdout', 'stderr')}, 'outputs': output}
    finally:
        stop_children()
        for child in work.iterdir():
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
        shutil.rmtree(logs)


def evaluate(job, files, train_bytes, schema, plan):
    if plan.get('protocol') == 'analysis-holdout-plan@1':
        return evaluate_holdout(job, files, train_bytes, schema, plan)
    if schema.get('kind') == 'tabular':
        return evaluate_tabular(job, files, train_bytes, schema, plan)
    fields, rows = read_csv(train_bytes)
    id_col, label_col = schema['idColumn'], schema['targetColumn']
    by_id = {r[id_col]: r for r in rows}
    if len(by_id) != len(rows) or len(plan['folds']) != 5:
        raise ValueError('invalid training IDs or fold plan')
    all_validation = [key for fold in plan['folds'] for key in fold['validationIds']]
    if len(all_validation) != len(set(all_validation)) or set(all_validation) != set(by_id):
        raise ValueError('OOF folds must cover every training ID exactly once')
    oof, metrics, logs = {}, [], []
    cpu, started, status = 0., time.monotonic(), 'completed'
    for index, fold in enumerate(plan['folds']):
        if job['cpuSeconds'] - cpu < 1 or time.monotonic() - started >= job['wallSeconds']:
            status = 'candidate_failed'
            logs.append({'validationError': 'experiment budget exhausted'})
            break
        validation = set(fold['validationIds'])
        if set(fold['trainIds']) != set(by_id) - validation:
            raise ValueError('fold training scope mismatch')
        result = run_python(files, {
            'train.csv': write_csv(fields, [by_id[k] for k in fold['trainIds']]),
            'predict.csv': write_csv([f for f in fields if f != label_col], [by_id[k] for k in fold['validationIds']])},
            job['entrypoint'], ['--train', '/work/inputs/train.csv', '--predict', '/work/inputs/predict.csv',
            '--output', '/work/scratch/predictions.csv', '--seed', str(job['trainingSeed'])],
            job['wallSeconds'] - (time.monotonic() - started), job['cpuSeconds'] - cpu)
        cpu += result['cpuSeconds']
        logs.append(result['logs'])
        try:
            if result['exitCode'] != 0 or result['limit']:
                raise ValueError('candidate execution failed')
            predictions = validate_predictions(result['outputs']['predictions.csv'], schema, validation)
        except (ValueError, KeyError) as e:
            status = 'candidate_failed'
            logs.append({'validationError': str(e)})
            break
        correct = sum(predictions[k] == by_id[k][label_col] for k in validation)
        metrics.append({'fold': index, 'rows': len(validation), 'correct': correct, 'accuracy': correct / len(validation)})
        oof.update(predictions)
    return {'status': status, 'foldMetrics': metrics, 'pooledAccuracy': sum(m['correct'] for m in metrics) / len(rows) if status == 'completed' else None,
            'meanFoldAccuracy': sum(m['accuracy'] for m in metrics) / 5 if status == 'completed' else None,
            'oof': oof if status == 'completed' else None, 'cpuSeconds': cpu, 'wallSeconds': time.monotonic() - started, 'logs': logs}


def public_assets(job, train_ids, predict_ids, cv=False):
    result = {}
    root = Path(job.get('publicDirectory', '/data/public'))
    for item in job.get('publicFiles', []):
        name, role, key = item['path'], item['role'], item['rowId']
        if name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/')):
            raise ValueError('unsafe public file')
        target = name
        if role == 'train':
            if not name.startswith('train/' + key + '/'):
                raise ValueError('invalid training asset scope')
            if cv and key in predict_ids:
                target = 'test/' + name[len('train/'):]
            elif key not in train_ids:
                continue
        elif role == 'predict':
            if cv or key not in predict_ids:
                continue
            if not name.startswith('test/' + key + '/'):
                raise ValueError('invalid prediction asset scope')
        elif name == 'sample_submission.csv':
            continue  # full query IDs are not part of a fold invocation
        content = regular(root / name)
        if len(content) != item['bytes'] or 'sha256:' + hashlib.sha256(content).hexdigest() != item['digest']:
            raise ValueError('public asset changed')
        if target in result or target in ('train.csv', 'predict.csv'):
            raise ValueError('public asset conflicts with scoped CSV')
        result[target] = content
    return result


def holdout_scope(train_bytes, schema, plan):
    fields, rows = read_csv(train_bytes)
    assignments = plan['assignments']
    if (len(assignments) != len(rows) or any(type(a) is not int or a not in (0, 1) for a in assignments)
            or set(assignments) != {0, 1} or plan['trainDigest'] != 'sha256:' + hashlib.sha256(train_bytes).hexdigest()
            or plan['metric'] != schema['metric']):
        raise ValueError('invalid or changed holdout split')
    by_id = {r[schema['idColumn']]: r for r in rows}
    if len(by_id) != len(rows):
        raise ValueError('duplicate training IDs')
    training = [r[schema['idColumn']] for r, part in zip(rows, assignments) if part == 0]
    validation = [r[schema['idColumn']] for r, part in zip(rows, assignments) if part == 1]
    inputs = {'train.csv': write_csv(fields, [by_id[k] for k in training]),
              'predict.csv': write_csv([f for f in fields if f not in schema['targetColumns']], [by_id[k] for k in validation])}
    return by_id, training, validation, inputs


def evaluate_holdout(job, files, train_bytes, schema, plan):
    by_id, training, validation, inputs = holdout_scope(train_bytes, schema, plan)
    inputs.update(public_assets(job, set(training), set(validation), cv=True))
    result = run_python(files, inputs, job['entrypoint'], ['--train', '/work/inputs/train.csv', '--predict', '/work/inputs/predict.csv',
        '--output', '/work/scratch/predictions.csv', '--seed', str(job['trainingSeed'])], job['wallSeconds'], job['cpuSeconds'])
    value, predictions_path, status, logs = None, None, 'candidate_failed', [result['logs']]
    try:
        if result['exitCode'] or result['limit']:
            raise ValueError('candidate execution failed')
        predictions = scoring.predictions(result['outputs']['predictions.csv'], schema, validation)
        value = scoring.score(schema, by_id, predictions, validation)
        out = Path(job['outputDirectory']); out.mkdir(parents=True, exist_ok=True)
        predictions_path = str(write_predictions(out, predictions))
        status = 'completed'
    except (ValueError, KeyError, OverflowError, csv.Error) as error:
        value = None; logs.append({'validationError': str(error)})
    return {'status': status, 'metric': schema['metric'], 'validationRows': len(validation),
            'validationScore': value, 'validationUtility': scoring.quality(schema['metric'], value) if value is not None else None,
            'predictionsPath': predictions_path, 'cpuSeconds': result['cpuSeconds'], 'wallSeconds': result['wallSeconds'], 'logs': logs}


def evaluate_tabular(job, files, train_bytes, schema, plan):
    fields, rows = read_csv(train_bytes)
    by_id = {r[schema['idColumn']]: r for r in rows}
    ids, assignments = list(by_id), plan['foldAssignments']
    if len(ids) != len(rows) or len(assignments) != len(rows) or set(assignments) != set(range(5)):
        raise ValueError('invalid five-fold row assignments')
    if plan['trainDigest'] != 'sha256:' + hashlib.sha256(train_bytes).hexdigest():
        raise ValueError('fold row order or data changed')
    oof, metrics, logs, cpu, started = {}, [], [], 0., time.monotonic()
    status = 'completed'
    for fold in range(5):
        training = [k for k, f in zip(ids, assignments) if f != fold]
        validation = [k for k, f in zip(ids, assignments) if f == fold]
        if job['cpuSeconds'] - cpu < 1 or time.monotonic() - started >= job['wallSeconds']:
            status = 'candidate_failed'; logs.append({'validationError': 'experiment budget exhausted'}); break
        inputs = public_assets(job, set(training), set(validation), cv=True)
        inputs.update({'train.csv': write_csv(fields, [by_id[k] for k in training]),
            'predict.csv': write_csv([f for f in fields if f not in schema['targetColumns']], [by_id[k] for k in validation])})
        result = run_python(files, inputs, job['entrypoint'], ['--train', '/work/inputs/train.csv', '--predict', '/work/inputs/predict.csv',
            '--output', '/work/scratch/predictions.csv', '--seed', str(job['trainingSeed'])],
            job['wallSeconds'] - (time.monotonic() - started), job['cpuSeconds'] - cpu)
        cpu += result['cpuSeconds']; logs.append(result['logs'])
        try:
            if result['exitCode'] or result['limit']:
                raise ValueError('candidate execution failed')
            predicted = scoring.predictions(result['outputs']['predictions.csv'], schema, validation)
            value = scoring.score(schema, by_id, predicted, validation)
        except (ValueError, KeyError, OverflowError) as error:
            status = 'candidate_failed'; logs.append({'validationError': str(error)}); break
        metrics.append({'fold': fold, 'rows': len(validation), 'score': value, 'utility': scoring.quality(schema['metric'], value)})
        oof.update(predicted)
    value = scoring.score(schema, by_id, oof, ids) if status == 'completed' else None
    result = {'status': status, 'metric': schema['metric'], 'foldMetrics': metrics, 'pooledScore': value,
        'pooledUtility': scoring.quality(schema['metric'], value) if value is not None else None,
        'cpuSeconds': cpu, 'wallSeconds': time.monotonic() - started, 'logs': logs}
    if status == 'completed':
        out = Path(job['outputDirectory']); out.mkdir(parents=True, exist_ok=True)
        result['oofPath'] = str(write_oof(out, oof))
    return result


def write_predictions(out, predictions, name='validation-predictions.json.gz'):
    # May 2022 has 800k OOF rows. Deterministic gzip keeps the public artifact
    # within Hitch's 16 MiB file bound without discarding IDs or precision.
    raw = json.dumps(predictions, separators=(',', ':')).encode()
    if len(raw) > 64 * 1024 ** 2:
        raise ValueError('decoded OOF exceeds runtime limit')
    encoded = gzip.compress(raw, compresslevel=6, mtime=0)
    if len(encoded) > 16 * 1024 ** 2:
        raise ValueError('OOF artifact exceeds runtime file limit')
    path = Path(out) / name; path.write_bytes(encoded)
    return path


def write_oof(out, oof):
    return write_predictions(out, oof, 'oof.json.gz')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    args = parser.parse_args()
    job = json.loads(regular(args.job))
    files = {name: regular(path) for name, path in job['files'].items()}
    if job['operation'] == 'evaluate':
        result = evaluate(job, files, input_csv(job['train']), job['prediction'], job['validationPlan'])
    else:
        inputs = {name: input_csv(path) if name.endswith('.csv') else regular(path) for name, path in job['inputs'].items()}
        if job.get('validationPlan', {}).get('protocol') == 'analysis-holdout-plan@1':
            _, training, validation, inputs = holdout_scope(inputs['train.csv'], job['prediction'], job['validationPlan'])
            inputs.update(public_assets(job, set(training), set(validation), cv=True))
        elif job.get('prediction', {}).get('kind') == 'tabular':
            idc = job['prediction']['idColumn']
            inputs.update(public_assets(job, {r[idc] for r in read_csv(inputs['train.csv'])[1]}, {r[idc] for r in read_csv(inputs['predict.csv'])[1]}))
        result = run_python(files, inputs, job['entrypoint'], job['argv'], job['wallSeconds'], job['cpuSeconds'])
        output_dir = Path(job['outputDirectory'])
        output_dir.mkdir(parents=True, exist_ok=True)
        outputs = result.pop('outputs')
        if job['operation'] == 'predict' and result['exitCode'] == 0 and not result['limit']:
            try:
                outputs['predictions.csv'] = scoring.canonical_submission(outputs['predictions.csv'], job['prediction'], job['predictIds'])
            except (ValueError, KeyError, UnicodeError, csv.Error):
                outputs.pop('predictions.csv', None); result['exitCode'] = 1
        for name, content in outputs.items():
            destination = output_dir / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        result['outputFiles'] = list(outputs)
    print(json.dumps(result, ensure_ascii=False))


def input_csv(path):
    path = Path(path)
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_nlink != 1 or stat.st_size > 1024 ** 3:
        raise ValueError('invalid input CSV')
    return path.read_bytes()


if __name__ == '__main__':
    def cancelled(signum, _frame):
        stop_children()
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    main()
