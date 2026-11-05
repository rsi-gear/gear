"""Stateless per-row features; learned preprocessing belongs in the Pipeline."""
import pandas as pd


def features(frame):
    result = frame.copy()
    result['FamilySize'] = result['SibSp'].fillna(0) + result['Parch'].fillna(0) + 1
    result['IsAlone'] = (result['FamilySize'] == 1).astype(int)
    # No target, row identifiers, or data from another fold enters this mapping.
    columns = ['Pclass', 'Sex', 'Age', 'SibSp', 'Parch', 'Fare', 'Embarked', 'FamilySize', 'IsAlone']
    return result[columns]
