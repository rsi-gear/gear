"""Prepare all labeled rows for round CV; query rows have no local labels."""
import argparse
import csv
import json
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
    if a.existing_competition:
        raise ValueError('round CV does not accept an old held-out split; supply the full training CSV')
    if any(sum(r[label] == value for r in rows) < 5 for value in labels):
        raise ValueError('at least five labeled rows per class required')
    out = Path(a.out)
    save(out / 'development/train.csv', fields, rows)
    save(out / 'development/predict.csv', qfields, query)
    save(out / 'refit/train.csv', fields, rows)
    save(out / 'refit/predict.csv', qfields, query)
    (out / 'validation.json').write_text(json.dumps({'seed': a.seed}))
    (out / 'prepared.json').write_text(json.dumps({'prediction': {'idColumn': idc, 'targetColumn': label, 'kind': 'binary-label', 'allowedLabels': labels},
        'predictIds': qids, 'refitIds': qids, 'rows': {'train': len(rows), 'predict': len(query), 'refitTrain': len(rows), 'refitPredict': len(query)}}))


if __name__ == '__main__':
    main()
