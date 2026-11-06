def next_action(state):
    history = state['history']
    if state['phase'] == 'select':
        candidates = state['eligibleExperiments']
        if not candidates:
            return {'action': 'select', 'solutionDigest': None}
        def quality(experiment):
            result = experiment['execution']
            return result.get('pooledUtility', result.get('pooledAccuracy'))
        best = max(quality(e) for e in candidates)
        tied = [e for e in candidates if best - quality(e) <= state['policy']['comparisonPrecision']]
        current = state['currentSolutionDigest']
        chosen = next((e for e in tied if e['sourceDigest'] == current), None) if state['policy']['preferCurrentOnTie'] else None
        chosen = chosen or sorted(tied, key=lambda e: e['experimentId'])[0]
        return {'action': 'select', 'solutionDigest': chosen['sourceDigest']}
    if not history:
        return {'action': 'draft', 'parentExperimentId': None}
    last = history[-1]
    if last['execution']['status'] in ('generation_failed', 'candidate_failed'):
        return {'action': 'debug', 'parentExperimentId': last['experimentId']}
    current = next((e for e in reversed(history) if e['sourceDigest'] == state['currentSolutionDigest']), last)
    return {'action': 'improve', 'parentExperimentId': current['experimentId']}
