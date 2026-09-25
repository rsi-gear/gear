import json
from pathlib import Path
import unittest

from gear_algorithm.author import SEARCH_CONFIG_SCHEMA, WIRE_VERSION_V2, algorithm, replay
from gear_algorithm.protocol import assert_schema, validate_schema
from gear_algorithm.errors import ValidationError


class AuthorSchemaBoundsTests(unittest.TestCase):
    def test_shared_bound_vectors(self):
        vectors = json.loads((Path(__file__).resolve().parents[3] / 'tests/fixtures/author-schema-bound-vectors.json').read_text())
        for row in vectors:
            with self.subTest(row=row['name']):
                if row['valid']:
                    validate_schema(row['schema'], row['value'])
                else:
                    with self.assertRaises(ValidationError):
                        assert_schema(row['schema'])
                        validate_schema(row['schema'], row['value'])

    def test_huge_bound_reports_validation_error(self):
        with self.assertRaises(ValidationError):
            assert_schema({'type': 'number', 'minimum': 10**1000})

    def test_search_config_rejected_before_effect(self):
        @algorithm(config_schema=SEARCH_CONFIG_SCHEMA)
        async def sample(ctx):
            return await ctx.operation('custom.effect', {})
        agent = {'schemaVersion': 1, 'kind': 'harness-agent',
                 'bindingSetRef': {'kind': 'binding-set', 'digest': 'a'*64, 'schemaId': 'binding.set.v1'},
                 'executionProfileDigest': 'b'*64}
        input_value = {'initialAgent': agent, 'data': {}, 'capabilities': {'version': 'gear.author.capabilities.v1',
                       'lockDigest': 'c'*64, 'roles': {}, 'operationLimits': {}, 'execution': {}}}
        for config in ({'rounds': 0, 'taskCount': 2, 'proposalCount': 1, 'seed': 0},
                       {'rounds': 1, 'taskCount': 0, 'proposalCount': 1, 'seed': 0},
                       {'rounds': 1, 'taskCount': 2, 'proposalCount': 0, 'seed': 0},
                       {'rounds': 1, 'taskCount': 2, 'proposalCount': 1, 'seed': 2**53}):
            with self.subTest(config=config), self.assertRaises(ValidationError):
                replay(sample, {'version': WIRE_VERSION_V2, 'input': {**input_value, 'config': config}, 'history': []})
        valid = replay(sample, {'version': WIRE_VERSION_V2, 'input': {**input_value, 'config': {
            'rounds': 1, 'taskCount': 2, 'proposalCount': 1, 'seed': -1}}, 'history': []})
        self.assertEqual(valid['frontier'][0]['kind'], 'custom.effect')


if __name__ == '__main__':
    unittest.main()
