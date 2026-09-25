export const choose = {
  describe() {
    return {
      id: 'choose',
      scope: 'campaign',
      inputSchema: { type: 'object', properties: { options: { type: 'array', items: { type: 'string' } } }, required: ['options'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false },
    };
  },
  invoke(value) {
    return { choice: value.options[0] };
  },
};
