"""Prepare a binary CSV task without task-specific feature or model logic."""
import argparse
import csv
import json
import random
from pathlib import Path


def load(path):
    with path.open(newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        return reader.fieldnames, list(reader)


def save(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator='\n')
        w.writeheader()
        w.writerows({k: r[k] for k in fields} for r in rows)


def main():
    p = argparse.ArgumentParser()
    for k in ('train', 'predict', 'id-column', 'target-column', 'out'):
        p.add_argument('--' + k, required=True)
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--existing-competition')
    a = p.parse_args()
    fields, rows = load(Path(a.train)); qfields, query = load(Path(a.predict))
    idc, label = a.id_column, a.target_column
    if not fields or idc not in fields or label not in fields or qfields != [k for k in fields if k != label]:
        raise ValueError('incompatible train/predict CSV schema')
    labels = sorted({r[label] for r in rows})
    ids = [r[idc] for r in rows]; qids = [r[idc] for r in query]
    if len(labels) != 2 or len(set(ids)) != len(ids) or len(set(qids)) != len(qids) or set(ids) & set(qids):
        raise ValueError('binary labels and disjoint unique nonempty IDs required')
    if any(not r[idc] or None in r or any(v is None for v in r.values()) for r in rows + query):
        raise ValueError('invalid CSV row')
    rng = random.Random(a.seed)
    if a.existing_competition:
        old = json.loads(Path(a.existing_competition).read_text())
        split = next(t for t in old['tasks'] if t['partition'] == 'held-out')
        train_ids, query_ids = set(split['train_ids']), set(split['predict_ids'])
        if train_ids & query_ids or train_ids | query_ids != set(ids):
            raise ValueError('existing split is not this dataset')
    else:
        query_ids = set()
        for value in labels:
            group = [r[idc] for r in rows if r[label] == value]; rng.shuffle(group)
            query_ids.update(group[:max(1, round(len(group) * .2))])
        train_ids = set(ids) - query_ids
    train, holdout = [r for r in rows if r[idc] in train_ids], [r for r in rows if r[idc] in query_ids]
    folds = [[] for _ in range(5)]
    for value in labels:
        group = [r[idc] for r in train if r[label] == value]; rng.shuffle(group)
        if len(group) < 5:
            raise ValueError('at least five visible rows per label required')
        for i, key in enumerate(group):
            folds[i % 5].append(key)
    plan = {'protocol': 'analysis-validation-plan@1', 'seed': a.seed, 'metric': 'pooled-oof-accuracy', 'folds': [
        {'trainIds': [r[idc] for r in train if r[idc] not in f], 'validationIds': [r[idc] for r in train if r[idc] in f]} for f in folds]}
    out = Path(a.out)
    save(out / 'development/train.csv', fields, train)
    save(out / 'development/predict.csv', qfields, holdout)
    save(out / 'private/expected.csv', [idc, label], holdout)
    save(out / 'refit/train.csv', fields, rows)
    save(out / 'refit/predict.csv', qfields, query)
    (out / 'validation.json').write_text(json.dumps(plan))
    (out / 'prepared.json').write_text(json.dumps({'prediction': {'idColumn': idc, 'targetColumn': label, 'kind': 'binary-label', 'allowedLabels': labels},
        'predictIds': [r[idc] for r in holdout], 'refitIds': qids, 'rows': {'train': len(train), 'predict': len(holdout), 'refitTrain': len(rows), 'refitPredict': len(query)}}))


if __name__ == '__main__':
    main()
