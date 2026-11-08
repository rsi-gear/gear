def summary(record):
    return {'id': record['identity']['experimentId'], 'goal': record['intent']['hypothesis'],
            'status': record['execution']['status'], 'variant': record['formal_evaluation']['variantId'],
            'score': record['formal_evaluation']['score'], 'decision': record['decision'],
            'cost': record['execution']['cost'], 'next': record['notes']['entries'][-1:]}
