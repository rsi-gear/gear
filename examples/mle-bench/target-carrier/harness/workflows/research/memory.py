def summarize_memory(state):
    return {'experiments': [{'id': e['experimentId'], 'source': e['sourceDigest'],
                            'status': e['execution']['status'],
                            'metric': e['execution'].get('metric', 'accuracy'),
                            'score': e['execution'].get('pooledScore', e['execution'].get('pooledAccuracy')),
                            'utility': e['execution'].get('pooledUtility', e['execution'].get('pooledAccuracy')),
                            'hypothesis': e['claim']['hypothesis'], 'conclusion': e['interpretation']['conclusion']}
                           for e in state['history'][-30:]],
            'olderExperiments': max(0, len(state['history']) - 30)}
