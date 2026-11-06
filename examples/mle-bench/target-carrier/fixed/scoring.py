"""Fixed tabular metrics, matching the pinned MLE-bench graders on valid CSVs."""
import csv
import io
import math


def table(content):
    reader = csv.DictReader(io.StringIO(content.decode('utf-8-sig'), newline=''))
    fields = reader.fieldnames
    if not fields or len(set(fields)) != len(fields):
        raise ValueError('invalid CSV columns')
    rows = list(reader)
    if not rows or any(None in r or any(v is None for v in r.values()) for r in rows):
        raise ValueError('invalid CSV rows')
    return fields, rows


def predictions(content, schema, ids):
    fields, rows = table(content)
    if fields != [schema['idColumn'], *schema['targetColumns']]:
        raise ValueError('unexpected submission columns')
    expected, result = set(ids), {}
    for row in rows:
        key = row[schema['idColumn']]
        if not key or key in result or key not in expected:
            raise ValueError('invalid submission ID')
        values = [row[c] for c in schema['targetColumns']]
        if schema['metric'] == 'accuracy':
            if len(values) != 1 or values[0] not in schema['labels']:
                raise ValueError('invalid class label')
        else:
            values = [float(v) for v in values]
            if any(not math.isfinite(v) or v < 0 or schema['metric'] == 'auc-roc' and v > 1 for v in values):
                raise ValueError('nonfinite or out-of-domain prediction')
        result[key] = values
    if set(result) != expected:
        raise ValueError('missing prediction IDs')
    return result


def quality(metric, score):
    return 1 / (1 + score) if metric == 'mean-column-wise-rmsle' else score


def score(schema, truths, predicted, ids):
    ids = list(ids)
    targets = schema['targetColumns']
    metric = schema['metric']
    if metric == 'accuracy':
        return sum(str(truths[k][targets[0]]) == predicted[k][0] for k in ids) / len(ids)
    if metric == 'auc-roc':
        if len(targets) != 1 or len(schema['labels']) != 2:
            raise ValueError('AUC requires one binary target')
        positive = schema['labels'][1]
        ranked = sorted((predicted[k][0], str(truths[k][targets[0]]) == positive) for k in ids)
        positives = sum(p for _, p in ranked)
        negatives = len(ranked) - positives
        if not positives or not negatives:
            raise ValueError('AUC requires both classes')
        rank_sum, index = 0., 0
        while index < len(ranked):
            end = index + 1
            while end < len(ranked) and ranked[end][0] == ranked[index][0]:
                end += 1
            rank_sum += (index + 1 + end) / 2 * sum(p for _, p in ranked[index:end])
            index = end
        return (rank_sum - positives * (positives + 1) / 2) / (positives * negatives)
    if metric == 'mean-column-wise-rmsle':
        values = []
        for index, target in enumerate(targets):
            errors = []
            for key in ids:
                value = float(truths[key][target])
                if not math.isfinite(value) or value < 0:
                    raise ValueError('RMSLE requires finite nonnegative targets')
                errors.append((math.log1p(value) - math.log1p(predicted[key][index])) ** 2)
            values.append(math.sqrt(math.fsum(errors) / len(ids)))
        return math.fsum(values) / len(values)
    raise ValueError('unsupported metric')


def canonical_submission(content, schema, ids):
    """NOMAD's upstream grader is positional; export the sample/test row order."""
    parsed = predictions(content, schema, ids)
    output = io.StringIO(newline='')
    writer = csv.writer(output, lineterminator='\n')
    writer.writerow([schema['idColumn'], *schema['targetColumns']])
    writer.writerows([key, *parsed[key]] for key in ids)
    return output.getvalue().encode()
