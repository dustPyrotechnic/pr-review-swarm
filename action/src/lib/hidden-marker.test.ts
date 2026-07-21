import { describe, expect, it } from 'vitest';
import { decodeBatchMarker, encodeBatchMarker, isOwnedByThisBot } from './hidden-marker.js';

describe('encodeBatchMarker / decodeBatchMarker', () => {
  it('round-trips a batch marker', () => {
    const marker = { reviewSetId: 'abc123', batchIndex: 1, batchCount: 3, digest: 'deadbeef' };
    const encoded = encodeBatchMarker(marker);
    expect(decodeBatchMarker(encoded)).toEqual(marker);
  });

  it('finds the marker even when embedded in a larger review body', () => {
    const marker = { reviewSetId: 'xyz', batchIndex: 0, batchCount: 1, digest: 'cafebabe' };
    const body = `## Findings\n\nSome text here.\n\n${encodeBatchMarker(marker)}`;
    expect(decodeBatchMarker(body)).toEqual(marker);
  });

  it('returns undefined for a body with no marker', () => {
    expect(decodeBatchMarker('just a plain review body')).toBeUndefined();
  });

  it('returns undefined for a malformed marker (missing field)', () => {
    const malformed = '<!-- pr-review-swarm:review_set_id=abc;batch=1/3 -->';
    expect(decodeBatchMarker(malformed)).toBeUndefined();
  });

  it('returns undefined for null body', () => {
    expect(decodeBatchMarker(null)).toBeUndefined();
  });

  it('does not throw on a similarly-formatted but foreign marker', () => {
    const foreign = '<!-- some-other-bot:review_set_id=abc;batch=1/3;digest=xyz -->';
    expect(decodeBatchMarker(foreign)).toBeUndefined();
  });
});

describe('isOwnedByThisBot', () => {
  it('is true when the review body has a valid batch marker', () => {
    const marker = { reviewSetId: 'abc', batchIndex: 0, batchCount: 1, digest: 'deadbeef' };
    expect(isOwnedByThisBot({ body: encodeBatchMarker(marker) })).toBe(true);
  });

  it('is false when the review body has no marker', () => {
    expect(isOwnedByThisBot({ body: 'looks like a human review' })).toBe(false);
  });

  it('is false for a null body', () => {
    expect(isOwnedByThisBot({ body: null })).toBe(false);
  });
});
