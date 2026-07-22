import { describe, expect, it } from 'vitest';
import { dereferenceSchema } from './schema-dereferencer.js';

describe('dereferenceSchema', () => {
  it('inlines a top-level $ref', () => {
    const target = { type: 'string', minLength: 1 };
    const result = dereferenceSchema({ $ref: 'foo' }, { foo: target });
    expect(result).toEqual(target);
  });

  it('inlines a nested $ref inside properties/items', () => {
    const item = { type: 'object', properties: { id: { type: 'string' } } };
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { $ref: 'item' } },
      },
    };

    const result = dereferenceSchema(schema, { item });

    expect(result).toEqual({
      type: 'object',
      properties: {
        list: { type: 'array', items: item },
      },
    });
  });

  it('leaves schemas without any $ref unchanged', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(dereferenceSchema(schema, {})).toEqual(schema);
  });

  it('throws when a $ref has no registered target', () => {
    expect(() => dereferenceSchema({ $ref: 'missing' }, {})).toThrow(
      /no schema registered for \$ref "missing"/,
    );
  });

  it('resolves a $ref that itself contains another $ref', () => {
    const inner = { type: 'string' };
    const middle = { $ref: 'inner' };
    const result = dereferenceSchema({ $ref: 'middle' }, { middle, inner });
    expect(result).toEqual(inner);
  });
});
