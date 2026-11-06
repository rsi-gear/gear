"""Native prepare(raw, public, private); deterministic 80/20 stratified split."""
import csv
import random


def prepare(raw, public, private):
    with (raw / 'train.csv').open(newline='', encoding='utf-8-sig') as stream:
        reader = csv.DictReader(stream); fields = reader.fieldnames; rows = list(reader)
    if fields is None or 'PassengerId' not in fields or 'Survived' not in fields:
        raise ValueError('Titanic train.csv schema required')
    if len({r['PassengerId'] for r in rows}) != len(rows) or {r['Survived'] for r in rows} != {'0', '1'}:
        raise ValueError('unique IDs and binary labels required')
    rng, heldout = random.Random(0), set()
    for label in ['0', '1']:
        ids = [r['PassengerId'] for r in rows if r['Survived'] == label]
        rng.shuffle(ids); heldout.update(ids[:max(1, round(len(ids) * .2))])
    train = [r for r in rows if r['PassengerId'] not in heldout]
    test = [r for r in rows if r['PassengerId'] in heldout]

    def save(path, columns, values):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('w', newline='') as stream:
            writer = csv.DictWriter(stream, fieldnames=columns, lineterminator='\n')
            writer.writeheader(); writer.writerows({k: r[k] for k in columns} for r in values)
    save(public / 'train.csv', fields, train)
    save(public / 'test.csv', [f for f in fields if f != 'Survived'], test)
    save(private / 'test.csv', fields, test)
    save(private / 'gold_submission.csv', ['PassengerId', 'Survived'], test)
    save(public / 'sample_submission.csv', ['PassengerId', 'Survived'], [{**r, 'Survived': '0'} for r in test])
