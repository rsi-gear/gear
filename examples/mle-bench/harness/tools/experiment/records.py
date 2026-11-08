def validate_note(note):
    if not isinstance(note, dict) or set(note) - {'text', 'next', 'correctionOf', 'extensions'}:
        raise ValueError('notes cannot set runtime facts')
    if not isinstance(note.get('text'), str) or len(note['text']) > 4000:
        raise ValueError('short note text required')
    return note
