def order(records, request):
    mode = request.get('order', 'oldest')
    if mode not in ('oldest', 'newest'):
        raise ValueError('unsupported order')
    ids = [r['identity']['experimentId'] for r in records]
    return ids[::-1] if mode == 'newest' else ids
