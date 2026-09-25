import unittest

from gear_algorithm.author import AuthorError, WIRE_VERSION_V2, algorithm, replay


class AuthorEvaluationBoundsTests(unittest.TestCase):
    def test_rejects_oversized_selection_before_any_effect(self):
        task_view = {'kind': 'artifact', 'digest': 'b'*64, 'size': 10,
                     'mediaType': 'application/json', 'schemaId': 'task.view.v1'}
        selection = {'schemaVersion': 1, 'taskViewRef': task_view,
                     'selectedTaskIds': ['task-1', 'task-2'],
                     'cursor': {'viewDigest': task_view['digest'], 'nextIndex': 0}}
        agent = {'schemaVersion': 1, 'kind': 'harness-agent',
                 'bindingSetRef': {'kind': 'binding-set', 'digest': 'c'*64,
                                   'schemaId': 'binding.set.v1'},
                 'executionProfileDigest': 'd'*64}
        @algorithm
        async def sample(ctx):
            return await ctx.evaluate(ctx.initial_agent, tasks=selection)
        capabilities = {'version': 'gear.author.capabilities.v1', 'lockDigest': 'a'*64,
                        'roles': {}, 'operationLimits': {'execution.rollout': {'rollout.trials': 1}},
                        'execution': {'evaluation': {'schemaVersion': 1, 'repeatCount': 1,
                                                     'maxTrials': 1, 'recipePhase': 'author.evaluate',
                                                     'samplingDigest': 'sha256:'+'1'*64,
                                                     'environmentDigest': 'sha256:'+'2'*64}}}
        request = {'version': WIRE_VERSION_V2,
                   'input': {'initialAgent': agent, 'data': {}, 'config': {},
                             'capabilities': capabilities}, 'history': []}
        with self.assertRaisesRegex(AuthorError, 'finite trial bound'):
            replay(sample, request)


if __name__ == '__main__':
    unittest.main()
