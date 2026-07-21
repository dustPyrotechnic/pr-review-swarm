import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from './schema-validator.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../schemas/fixtures',
);

function loadFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, relativePath), 'utf-8'));
}

describe('validate', () => {
  it('accepts a valid candidate-finding', () => {
    const data = loadFixture('candidate-finding/valid-1.json');
    const result = validate(
      'https://pr-review-swarm/schemas/candidate-finding.schema.json',
      data,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a candidate-finding with an unknown field', () => {
    const data = loadFixture('candidate-finding/invalid-unknown-field.json');
    const result = validate(
      'https://pr-review-swarm/schemas/candidate-finding.schema.json',
      data,
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a candidate-finding with a bad side enum value', () => {
    const data = loadFixture('candidate-finding/invalid-bad-side-enum.json');
    const result = validate(
      'https://pr-review-swarm/schemas/candidate-finding.schema.json',
      data,
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a candidate-finding with line < 1', () => {
    const data = loadFixture('candidate-finding/invalid-line-zero.json');
    const result = validate(
      'https://pr-review-swarm/schemas/candidate-finding.schema.json',
      data,
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a candidate-finding with start_line but no start_side', () => {
    const data = loadFixture(
      'candidate-finding/invalid-start-line-without-start-side.json',
    );
    const result = validate(
      'https://pr-review-swarm/schemas/candidate-finding.schema.json',
      data,
    );
    expect(result.valid).toBe(false);
  });

  it('accepts an expert-output with exactly 30 candidate findings', () => {
    const data = loadFixture('expert-output/valid-maxitems-30.json');
    const result = validate('https://pr-review-swarm/schemas/expert-output.schema.json', data);
    expect(result.valid).toBe(true);
  });

  it('rejects an expert-output with 31 candidate findings (maxItems)', () => {
    const data = loadFixture('expert-output/invalid-maxitems-31.json');
    const result = validate('https://pr-review-swarm/schemas/expert-output.schema.json', data);
    expect(result.valid).toBe(false);
  });

  it('rejects an expert-output missing coverage_complete', () => {
    const data = loadFixture('expert-output/invalid-missing-coverage-complete.json');
    const result = validate('https://pr-review-swarm/schemas/expert-output.schema.json', data);
    expect(result.valid).toBe(false);
  });

  it('returns errors describing why validation failed', () => {
    const data = loadFixture('candidate-finding/invalid-bad-side-enum.json');
    const result = validate(
      'https://pr-review-swarm/schemas/candidate-finding.schema.json',
      data,
    );
    if (result.valid) throw new Error('expected invalid result');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('throws for an unknown schema id', () => {
    expect(() => validate('https://pr-review-swarm/schemas/does-not-exist.schema.json', {})).toThrow();
  });
});
