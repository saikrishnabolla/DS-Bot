export function defineTool(definition) {
  if (definition.parameters?.type === 'object') return definition
  const properties = {}
  const required = []
  for (const [name, original] of Object.entries(definition.parameters ?? {})) {
    const property = original && typeof original === 'object' ? { ...original } : {}
    if (property.required === true) required.push(name)
    delete property.required
    properties[name] = property
  }
  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      type: 'object',
      properties,
      ...(required.length === 0 ? {} : { required }),
      additionalProperties: false,
    },
  }
}
