"""Fixed search scheduler with frozen round CV and legacy holdout replay."""
import csv
import hashlib
import io
import json
import math
import random
import time
from pathlib import Path


def folds(rows, schema, validation, seed):
    count, kind = validation['folds'], validation['kind']
    ids = [r[schema['idColumn']] for r in rows]
    rng = random.Random(seed)
    buckets = [[] for _ in range(count)]
    if kind == 'time':
        # ISO dates/numeric columns sort correctly; reject missing ordering values.
        column = validation['column']
        values = [r[column] for r in rows]
        if any(v == '' for v in values):
            raise ValueError('time validation requires nonmissing ordering values')
        try:
            ordering = {v: float(v) for v in values}
        except ValueError:
            ordering = {v: v for v in values}
        times = sorted(set(values), key=ordering.get)
        if len(times) < count + 1:
            raise ValueError('too few distinct times')
        blocks = [times[i * len(times) // (count+1):(i+1) * len(times) // (count+1)] for i in range(count+1)]
        return [([r[schema['idColumn']] for r in rows if r[column] in set(sum(blocks[:i], []))],
                 [r[schema['idColumn']] for r in rows if r[column] in set(blocks[i])]) for i in range(1, count+1)]
    groups = {}
    for row in rows:
        key = row[validation['column']] if kind == 'group' else row[schema['targetColumns'][0]] if kind == 'stratified' else 'all'
        groups.setdefault(key, []).append(row[schema['idColumn']])
    if kind == 'group':
        if len(groups) < count:
            raise ValueError('too few independent groups')
        items = list(groups.values()); rng.shuffle(items); items.sort(key=len, reverse=True)
        for group in items:
            min(buckets, key=len).extend(group)
    else:
        position = 0
        for group in groups.values():
            rng.shuffle(group)
            for key in group:
                buckets[position % count].append(key); position += 1
    if any(not b for b in buckets):
        raise ValueError('empty training validation fold')
    return [([k for k in ids if k not in set(b)], b) for b in buckets]


def invoke(worker, job, files, inputs, config, cpu, wall):
    fixed = dict(files)
    if '_gear_pipeline.py' in fixed:
        raise ValueError('reserved runtime source name')
    fixed['_gear_pipeline.py'] = Path(__file__).with_name('pipeline_runner.py').read_bytes()
    spec = {'config': config, 'entrypoint': '/work/source/' + job['entrypoint'],
            'prediction': job['prediction'], 'expectedParameters': job.get('resolvedPipeline', {}).get('actualParameters'), 'maxFitCalls': job.get('maxFitCalls', 1000)}
    inputs = {**inputs, 'pipeline.json': json.dumps(spec).encode()}
    result = worker.run_python(fixed, inputs, '_gear_pipeline.py', [], wall, cpu)
    receipt = json.loads(result['outputs']['pipeline-fit.json']) if 'pipeline-fit.json' in result['outputs'] else None
    if result['exitCode'] == 0 and not result['limit']:
        if receipt is None:
            raise ValueError('missing fit receipt')
        if receipt['config'] != config or receipt['parametersBefore'] != receipt['parametersAfter'] or receipt['fits'] != 1 or receipt['searchCalls'] != 0:
            raise ValueError('fit receipt differs from frozen pipeline')
    result['fitReceipt'] = receipt
    return result


def research(worker, job, files, train_bytes):
    schema, plan = job['prediction'], job['searchPlan']
    frozen = job['validationPlan']
    round_cv = frozen.get('protocol') == 'analysis-round-cv-plan@1'
    cv = None
    if round_cv:
        if (frozen.get('folds') != 5 or frozen.get('shuffle') is not True
                or frozen.get('splitter') != 'python-random-stratified-round-robin@1'
                or frozen.get('kind') not in ('stratified', 'kfold')
                or frozen.get('metric') != schema['metric']
                or frozen.get('trainDigest') != 'sha256:' + hashlib.sha256(train_bytes).hexdigest()
                or type(frozen.get('seed')) is not int or not 0 <= frozen['seed'] <= 2**32-1):
            raise ValueError('invalid or changed round CV plan')
        declared = plan['validation']
        if (declared.get('folds') != 5 or declared.get('kind') != frozen['kind']
                or declared.get('shuffle') is False or declared.get('seed', frozen['seed']) != frozen['seed']
                or declared.get('column') or plan.get('refitReserve') != 1
                or plan['maxFits'] < 5 * len(plan['variants']) + 1):
            raise ValueError('search must use the frozen five folds and reserve the final refit')
        _, rows = worker.read_csv(train_bytes)
        by_id = {r[schema['idColumn']]: r for r in rows}
        if len(rows) != len(by_id) or len(rows) < 5:
            raise ValueError('round CV requires unique IDs and at least five rows')
        training, validation = list(by_id), []
        splits = folds(rows, schema, frozen, frozen['seed'])
        assignment = {key: index for index, (_, query) in enumerate(splits) for key in query}
        if len(assignment) != len(rows) or sum(len(query) for _, query in splits) != len(rows):
            raise ValueError('CV must predict every training row exactly once')
        cv = {'rowIds': training, 'foldAssignments': [assignment[key] for key in training]}
    else:
        by_id, training, validation, _ = worker.holdout_scope(train_bytes, schema, frozen)
        splits = folds([by_id[k] for k in training], schema, plan['validation'], plan['seed'])
    fields = list(next(iter(by_id.values())))
    started, cpu, fit_count, fit_attempts, call_count = time.monotonic(), 0., 0, 0, 0
    variants, logs = [], []
    max_calls = plan.get('maxFitCalls', plan['maxFits'] * 100)
    def fit(config, train_ids, predict_ids):
        nonlocal cpu, fit_count, fit_attempts, call_count
        if fit_attempts >= plan['maxFits'] - (1 if round_cv else 0) or call_count >= max_calls:
            raise ValueError('fit budget exhausted')
        fit_attempts += 1
        inputs = worker.public_assets(job, set(train_ids), set(predict_ids), cv=True)
        inputs.update({'train.csv': worker.write_csv(fields, [by_id[k] for k in train_ids]),
                       'predict.csv': worker.write_csv([f for f in fields if f not in schema['targetColumns']], [by_id[k] for k in predict_ids])})
        result = invoke(worker, {**job, 'maxFitCalls': max_calls-call_count}, files, inputs, config,
                        job['cpuSeconds']-cpu, job['wallSeconds']-(time.monotonic()-started))
        cpu += result['cpuSeconds']; logs.append(result['logs'])
        receipt = result['fitReceipt']
        fit_count += receipt.get('fits', 0) if receipt else 1
        call_count += receipt['fitCalls'] if receipt else max_calls-call_count
        if result['exitCode'] or result['limit'] or receipt is None:
            raise ValueError('pipeline fit failed; component calls conservatively charged on missing receipt')
        predicted = worker.scoring.predictions(result['outputs']['predictions.csv'], schema, predict_ids)
        score = worker.scoring.score(schema, by_id, predicted, predict_ids)
        return score, predicted, receipt
    best_utility, best_predictions = None, None
    for variant in plan['variants']:
        before_cpu, before_fits, before_attempts = cpu, fit_count, fit_attempts
        item = {**variant, 'status': 'completed', 'folds': [], 'meanUtility': None}
        oof = {}
        try:
            for index, (train_ids, predict_ids) in enumerate(splits):
                score, predicted, receipt = fit(variant['config'], train_ids, predict_ids)
                oof.update(predicted)
                item['folds'].append({'fold': index, 'score': score, 'utility': worker.scoring.quality(schema['metric'], score),
                                      'rows': len(predict_ids), 'fit': receipt})
            item['meanUtility'] = sum(f['utility'] for f in item['folds']) / len(splits)
            item['meanScore'] = sum(f['score'] for f in item['folds']) / len(splits)
            item['stdScore'] = math.sqrt(sum((f['score']-item['meanScore'])**2 for f in item['folds']) / len(splits))
            if best_utility is None or item['meanUtility'] > best_utility:
                best_utility, best_predictions = item['meanUtility'], oof
        except (ValueError, KeyError, OverflowError, UnicodeError, csv.Error) as error:
            item['status'] = 'failed'; item['error'] = str(error)
        item.update(cpuSeconds=cpu-before_cpu, fits=fit_count-before_fits, fitAttempts=fit_attempts-before_attempts)
        variants.append(item)
    valid = [v for v in variants if v['status'] == 'completed']
    winner = max(valid, key=lambda v: v['meanUtility']) if valid else None
    result = {'status': 'candidate_failed', 'metric': schema['metric'], 'validationScore': None, 'validationUtility': None,
              'validationRows': len(validation), 'variants': variants, 'formalVariantId': winner['id'] if winner else None,
              'predictionsPath': None, 'logs': logs, 'formalFit': None}
    if round_cv:
        result.update(cv=cv, foldMetrics=[], meanScore=None, meanUtility=None, stdScore=None,
                      pooledScore=None, pooledUtility=None, oofPath=None)
        if winner:
            out = Path(job['outputDirectory']); out.mkdir(parents=True, exist_ok=True)
            pooled = worker.scoring.score(schema, by_id, best_predictions, training)
            result.update(status='completed', meanScore=winner['meanScore'], meanUtility=winner['meanUtility'],
                          stdScore=winner['stdScore'], pooledScore=pooled, pooledUtility=worker.scoring.quality(schema['metric'], pooled),
                          foldMetrics=[{k: f[k] for k in ('fold', 'rows', 'score', 'utility')} for f in winner['folds']],
                          oofPath=str(worker.write_oof(out, best_predictions)))
    elif winner:
        try:
            score, predictions, receipt = fit(winner['config'], training, validation)
            out = Path(job['outputDirectory']); out.mkdir(parents=True, exist_ok=True)
            result.update(status='completed', validationScore=score, validationUtility=worker.scoring.quality(schema['metric'], score),
                          predictionsPath=str(worker.write_predictions(out, predictions)), formalFit=receipt)
        except (ValueError, KeyError, OverflowError, UnicodeError, csv.Error) as error:
            logs.append({'validationError': str(error)})
    result.update(cpuSeconds=cpu, wallSeconds=time.monotonic()-started, fits=fit_count, fitAttempts=fit_attempts, fitCalls=call_count)
    return result
