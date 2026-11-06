"""Register explicit Kaggle deployment inputs separately from the benchmark."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepared_data', Path(__file__).with_name('mlebench-data.py'))
data = importlib.util.module_from_spec(spec); spec.loader.exec_module(data)
parser = argparse.ArgumentParser(); parser.add_argument('--directory', required=True)
root = Path(parser.parse_args().directory)
schema = json.loads((root / 'prediction.json').read_text())
fields, train, _ = data.profile(root / 'train.csv', schema['idColumn'], schema['targetColumns'], schema['metric'])
qfields, query, _ = data.profile(root / 'predict.csv', schema['idColumn'])
if qfields != [f for f in fields if f not in schema['targetColumns']]:
    raise ValueError('deployment feature columns do not match')
print(json.dumps({'trainRows': len(train), 'predictIds': query}))
