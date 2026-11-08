"""Fit-only entry, shared by training folds, formal evaluation and final refit."""
import functools
import importlib.util
import json
import math
import sys
from pathlib import Path


def parameters(model):
    def normalize(value):
        if isinstance(value, float) and not math.isfinite(value):
            return {'number': 'NaN' if math.isnan(value) else 'Infinity' if value > 0 else '-Infinity'}
        if value is None or isinstance(value, (bool, str, int, float)):
            return value
        if isinstance(value, dict):
            return {str(k): normalize(v) for k, v in sorted(value.items())}
        if isinstance(value, (list, tuple)):
            return [normalize(v) for v in value]
        if isinstance(value, type) or callable(value):
            name = getattr(value, '__qualname__', '')
            if not name or '<lambda>' in name or '<locals>' in name:
                raise ValueError('parameter callables must be stable module-level symbols')
            return {'symbol': value.__module__ + '.' + name}
        if hasattr(value, 'tolist'):
            return normalize(value.tolist())
        if hasattr(value, 'get_params'):
            return {'class': type(value).__module__ + '.' + type(value).__qualname__,
                    'params': normalize(value.get_params(deep=False))}
        raise ValueError('pipeline parameters must be serializable, including custom transformers')
    return normalize(model)


def install_fit_guard(max_calls, progress=None):
    # This records component calls too (pipelines/ensembles can contain many fits).
    # CPU/wall confinement remains authoritative for arbitrary generated code.
    from sklearn.base import BaseEstimator
    import sklearn.model_selection as selection
    from sklearn.model_selection._search import BaseSearchCV
    state = {'allowed': False, 'calls': 0, 'events': []}

    def deny(*args, **kwargs):
        raise RuntimeError('search is only available through experiment.run')
    BaseSearchCV.fit = deny
    for name in ('cross_validate', 'cross_val_score', 'cross_val_predict', 'learning_curve', 'validation_curve'):
        setattr(selection, name, deny)

    def wrap(cls):
        for name in ('fit', 'fit_transform', 'partial_fit'):
            original = cls.__dict__.get(name)
            if not callable(original) or getattr(original, '_gear_guard', False):
                continue
            def guarded(self, *args, _original=original, _name=name, **kwargs):
                if not state['allowed']:
                    raise RuntimeError('fit outside the controlled training invocation')
                state['calls'] += 1
                if progress is not None:
                    progress['fitCalls'] = state['calls']
                if state['calls'] > max_calls:
                    raise RuntimeError('component fit-call budget exhausted')
                state['events'].append(type(self).__module__ + '.' + type(self).__name__ + '.' + _name)
                return _original(self, *args, **kwargs)
            guarded = functools.wraps(original)(guarded)
            guarded._gear_guard = True
            setattr(cls, name, guarded)
        for child in cls.__subclasses__():
            wrap(child)
    wrap(BaseEstimator)
    def guard_new_class(cls, **kwargs):
        super(BaseEstimator, cls).__init_subclass__(**kwargs)
        wrap(cls)
    BaseEstimator.__init_subclass__ = classmethod(guard_new_class)
    return state, lambda: wrap(BaseEstimator)


def fit_predict(spec, train, predict, output, progress=None):
    import pandas as pd
    # Load common modules before installing guards, then wrap custom classes too.
    import sklearn.pipeline, sklearn.compose, sklearn.preprocessing, sklearn.impute
    import sklearn.ensemble, sklearn.linear_model, sklearn.tree, sklearn.svm, sklearn.neighbors
    from sklearn.base import clone
    config = spec['config']
    progress = progress if progress is not None else {}
    progress.update(config=config, fits=0, fitCalls=0, searchCalls=0)
    state, refresh = install_fit_guard(spec['maxFitCalls'], progress)
    module_spec = importlib.util.spec_from_file_location('candidate_pipeline', spec['entrypoint'])
    module = importlib.util.module_from_spec(module_spec)
    sys.modules[module_spec.name] = module
    module_spec.loader.exec_module(module)
    refresh()
    frozen_config = json.dumps(config, sort_keys=True)
    model = module.build_pipeline(config)
    refresh()
    before = parameters(model)
    progress['parametersBefore'] = before
    if spec.get('expectedParameters') is not None:
        assert before == spec['expectedParameters'], 'factory differs from frozen actual parameters'
    # Probe construction without data: a config is a choice, not a search program.
    assert parameters(module.build_pipeline(json.loads(frozen_config))) == before, 'non-deterministic pipeline factory'
    model = clone(model)
    data, query = pd.read_csv(train), pd.read_csv(predict)
    schema = spec['prediction']
    targets = schema.get('targetColumns', [schema.get('targetColumn')])
    labels = data[targets[0]] if len(targets) == 1 else data[targets]
    features = data.drop(columns=targets)
    assert list(features.columns) == list(query.columns), 'train/predict schema differs'
    state['allowed'] = True
    progress['fits'] = 1
    try:
        model.fit(features, labels)
    finally:
        state['allowed'] = False
    after = parameters(model)
    assert before == after and json.dumps(config, sort_keys=True) == frozen_config, 'fit changed frozen configuration'
    mode = config['prediction']
    if mode['kind'] == 'probability':
        classes = list(model.classes_)
        positive = mode['positiveLabel']
        index = next(i for i, label in enumerate(classes) if str(label) == str(positive))
        values = model.predict_proba(query)[:, index]
        if 'threshold' in mode:
            assert len(classes) == 2, 'threshold requires binary classification'
            import numpy as np
            values = np.where(values >= mode['threshold'], classes[index], classes[1-index])
    else:
        values = model.predict(query)
    assert parameters(model) == before, 'prediction changed configuration'
    frame = pd.DataFrame(values, columns=targets)
    frame.insert(0, schema['idColumn'], query[schema['idColumn']].values)
    frame.to_csv(output, index=False)
    return {'config': config, 'parametersBefore': before, 'parametersAfter': after,
            'fits': 1, 'searchCalls': 0, 'fitCalls': state['calls'], 'fitEvents': state['events']}


if __name__ == '__main__':
    receipt = {}
    try:
        receipt = fit_predict(json.loads(Path('/work/inputs/pipeline.json').read_text()),
                              '/work/inputs/train.csv', '/work/inputs/predict.csv', '/work/scratch/predictions.csv', receipt)
    except BaseException as error:
        receipt['error'] = str(error)
        raise
    finally:
        Path('/work/scratch/pipeline-fit.json').write_text(json.dumps(receipt, sort_keys=True))
