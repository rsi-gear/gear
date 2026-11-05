"""Deterministic CPU baseline. All learned transforms fit only on --train."""
import argparse
import json
from pathlib import Path

import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from features import features


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--train', required=True)
    parser.add_argument('--predict', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--seed', required=True, type=int)
    args = parser.parse_args()
    train, predict = pd.read_csv(args.train), pd.read_csv(args.predict)
    for frame in [train, predict]:
        if frame['PassengerId'].isna().any() or frame['PassengerId'].duplicated().any():
            raise ValueError('PassengerId must be present and unique')
    if 'Survived' in predict or not train['Survived'].isin([0, 1]).all():
        raise ValueError('invalid training labels or target leakage in prediction input')
    config = json.loads(Path(__file__).with_name('model.json').read_text())
    numeric = ['Age', 'SibSp', 'Parch', 'Fare', 'FamilySize', 'IsAlone']
    categorical = ['Pclass', 'Sex', 'Embarked']
    preprocessing = ColumnTransformer([
        ('numeric', Pipeline([('impute', SimpleImputer(strategy='median')), ('scale', StandardScaler())]), numeric),
        ('categorical', Pipeline([('impute', SimpleImputer(strategy='most_frequent')),
                                  ('encode', OneHotEncoder(handle_unknown='ignore'))]), categorical),
    ])
    model = Pipeline([('preprocessing', preprocessing), ('classifier', LogisticRegression(
        C=float(config['C']), max_iter=int(config['max_iter']), random_state=args.seed))])
    model.fit(features(train), train['Survived'])
    output = pd.DataFrame({'PassengerId': predict['PassengerId'], 'Survived': model.predict(features(predict)).astype(int)})
    output.to_csv(args.output, index=False)


if __name__ == '__main__':
    main()
