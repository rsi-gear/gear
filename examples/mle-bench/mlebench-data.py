"""Freeze one research train/validation split; never re-split the benchmark test."""
import argparse
import csv
import hashlib
import json
import math
import random
from pathlib import Path


def records(path):
    with Path(path).open(newline='', encoding='utf-8-sig') as stream:
        reader = csv.DictReader(stream)
        fields = reader.fieldnames
        if not fields or len(set(fields)) != len(fields):
            raise ValueError('invalid CSV columns')
        for row in reader:
            if None in row or any(v is None for v in row.values()):
                raise ValueError('invalid CSV row')
            yield fields, row


def profile(path, idc, targets=(), metric=None):
    ids, seen, groups, fields = [], set(), {}, None
    for fields, row in records(path):
        if idc not in fields or any(t not in fields for t in targets):
            raise ValueError('missing ID/target columns')
        key = row[idc]
        if not key or key in seen:
            raise ValueError('IDs must be unique within each split')
        seen.add(key); ids.append(key)
        if targets:
            if metric in ('accuracy', 'auc-roc'):
                groups.setdefault(row[targets[0]], []).append(len(ids) - 1)
            else:
                for t in targets:
                    value = float(row[t])
                    if not math.isfinite(value) or value < 0:
                        raise ValueError('nonnegative finite regression targets required')
    if not ids:
        raise ValueError('empty split')
    return fields, ids, groups


def prepare(metadata, out):
    public, answers = Path(metadata['public']), Path(metadata['answers'])
    first_fields, _ = next(records(metadata['sampleSubmission']))
    idc, targets = first_fields[0], first_fields[1:]
    metric = metadata['metric']
    if not targets or metric in ('accuracy', 'auc-roc') and len(targets) != 1:
        raise ValueError('unsupported submission target shape')
    fields, train_ids, groups = profile(public / 'train.csv', idc, targets, metric)
    qfields, query_ids, _ = profile(public / 'test.csv', idc)
    _, sample_ids, _ = profile(metadata['sampleSubmission'], idc)
    _, answer_ids, _ = profile(answers, idc, targets, metric)
    if qfields != [f for f in fields if f not in targets] or set(query_ids) != set(sample_ids) or set(query_ids) != set(answer_ids):
        raise ValueError('public/test, sample and private answers are incompatible')
    if metric == 'mean-column-wise-rmsle' and (query_ids != sample_ids or query_ids != answer_ids):
        raise ValueError('the positional NOMAD grader requires test/sample/answer row order to agree')
    for role, ids in [('train', train_ids), ('test', query_ids)]:
        directory, expected_ids = public / role, set(ids)
        if metadata.get('competitionId') == 'nomad2018-predict-transparent-conductors':
            found = {p.parent.name for p in directory.glob('*/geometry.xyz')}
            if found != expected_ids:
                raise ValueError('NOMAD geometry files must cover exactly the IDs in each split')
        if directory.exists() and any(not p.is_dir() or p.name not in expected_ids for p in directory.iterdir()):
            raise ValueError('row asset scope differs from public CSV IDs')
    # Scope is (split, ID). NOMAD intentionally reuses IDs across train/test.
    labels = sorted(groups)
    if metric in ('accuracy', 'auc-roc') and len(labels) != 2:
        raise ValueError('binary labels required by this runtime profile')
    if metric == 'auc-roc' and labels != ['0', '1']:
        raise ValueError('the pinned AUC profile expects 0/1 labels')
    validation = metadata['validation']
    rng, assignments = random.Random(validation['seed']), [0] * len(train_ids)
    for indices in groups.values() if groups else [list(range(len(train_ids)))]:
        if len(indices) < 2:
            raise ValueError('at least two visible rows per stratum required')
        rng.shuffle(indices)
        count = max(1, min(len(indices) - 1, math.floor(len(indices) * validation['fraction'] + .5)))
        for index in indices[:count]:
            assignments[index] = 1
    prediction = {'kind': 'tabular', 'idColumn': idc, 'targetColumns': targets, 'metric': metric, 'labels': labels}
    # Private answers stay in the verifier-only directory. Extra feature columns
    # in the native MLE-bench private/test.csv are not exposed to Target.
    (out / 'private').mkdir(parents=True, exist_ok=True)
    with (out / 'private/expected.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=[idc, *targets], lineterminator='\n'); writer.writeheader()
        for _, row in records(answers):
            writer.writerow({k: row[k] for k in [idc, *targets]})
    plan = {'protocol': 'analysis-holdout-plan@1', 'seed': validation['seed'], 'metric': metric,
        'trainDigest': metadata['trainDigest'], 'validationFraction': validation['fraction'], 'assignments': assignments}
    (out / 'validation.json').write_text(json.dumps(plan))
    result = {'prediction': prediction, 'predictIds': sample_ids, 'refitIds': sample_ids,
        'rows': {'train': len(train_ids), 'predict': len(query_ids), 'refitTrain': len(train_ids), 'refitPredict': len(query_ids)}}
    (out / 'prepared.json').write_text(json.dumps(result))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--metadata', required=True); parser.add_argument('--out', required=True)
    args = parser.parse_args(); prepare(json.loads(Path(args.metadata).read_text()), Path(args.out))
