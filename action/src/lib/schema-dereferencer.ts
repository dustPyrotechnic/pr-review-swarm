// DeepSeek's tool-calling `parameters` field is sent as-is to the model; it
// cannot resolve our schemas' $id-based $ref (there is no real HTTP fetch of
// https://pr-review-swarm/schemas/...). Any schema handed to the model must
// have its $refs inlined first, or the model has no idea what shape the
// referenced type should be.
export function dereferenceSchema(schema: object, refs: Record<string, object>): object {
  if (Array.isArray(schema)) {
    return schema.map((item) =>
      typeof item === 'object' && item !== null ? dereferenceSchema(item, refs) : item,
    ) as unknown as object;
  }

  const entries = Object.entries(schema as Record<string, unknown>);
  const refEntry = entries.find(([key]) => key === '$ref');
  if (refEntry && typeof refEntry[1] === 'string') {
    const target = refs[refEntry[1]];
    if (!target) {
      throw new Error(`schema-dereferencer: no schema registered for $ref "${refEntry[1]}"`);
    }
    return dereferenceSchema(target, refs);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    result[key] = typeof value === 'object' && value !== null ? dereferenceSchema(value, refs) : value;
  }
  return result;
}
