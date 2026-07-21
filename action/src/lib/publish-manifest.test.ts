import { describe, expect, it } from 'vitest';
import { planReviewBatches } from './publish-manifest.js';
import type { Finding } from './arbiter.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT',
    severity: 'high',
    confidence: 'high',
    category: 'correctness',
    title: 'title',
    evidence: 'evidence',
    impact: 'impact',
    suggestion: 'suggestion',
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    evidence_validation: { status: 'passed' },
    verifier_conclusion: { status: 'confirmed' },
    ...overrides,
  };
}

const limits = { maxFindingsPerReviewBatch: 20, maxReviewBodyChars: 60000 };

describe('planReviewBatches', () => {
  it('returns exactly one empty batch for zero findings', () => {
    const batches = planReviewBatches([], limits);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      batchIndex: 0,
      batchCount: 1,
      findings: [],
      event: 'COMMENT',
    });
  });

  it('puts everything in one batch when under the count limit', () => {
    const findings = [makeFinding({ id: 'f-1' }), makeFinding({ id: 'f-2' })];
    const batches = planReviewBatches(findings, limits);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.findings).toHaveLength(2);
    expect(batches[0]?.batchCount).toBe(1);
  });

  it('every batch has event COMMENT', () => {
    const findings = [makeFinding({ id: 'f-1' })];
    const batches = planReviewBatches(findings, limits);
    for (const batch of batches) {
      expect(batch.event).toBe('COMMENT');
    }
  });

  it('splits into multiple batches when the count limit is exceeded', () => {
    const findings = Array.from({ length: 25 }, (_, i) => makeFinding({ id: `f-${i}` }));
    const batches = planReviewBatches(findings, { ...limits, maxFindingsPerReviewBatch: 10 });
    expect(batches).toHaveLength(3);
    expect(batches[0]?.findings).toHaveLength(10);
    expect(batches[1]?.findings).toHaveLength(10);
    expect(batches[2]?.findings).toHaveLength(5);
    for (const batch of batches) {
      expect(batch.batchCount).toBe(3);
    }
  });

  it('assigns sequential batchIndex starting at 0', () => {
    const findings = Array.from({ length: 25 }, (_, i) => makeFinding({ id: `f-${i}` }));
    const batches = planReviewBatches(findings, { ...limits, maxFindingsPerReviewBatch: 10 });
    expect(batches.map((b) => b.batchIndex)).toEqual([0, 1, 2]);
  });

  it('splits when the body-char budget is exceeded even under the count limit', () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ id: `f-${i}`, evidence: 'x'.repeat(50) }),
    );
    const batches = planReviewBatches(findings, {
      maxFindingsPerReviewBatch: 20,
      maxReviewBodyChars: 120,
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.reduce((sum, b) => sum + b.findings.length, 0)).toBe(5);
  });

  it('sets each batch findingsDigest to the digest of that batch only', () => {
    const findings = Array.from({ length: 25 }, (_, i) => makeFinding({ id: `f-${i}` }));
    const batches = planReviewBatches(findings, { ...limits, maxFindingsPerReviewBatch: 10 });
    const digests = batches.map((b) => b.findingsDigest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('always includes at least one finding per batch when under the char budget, even for a single oversized finding', () => {
    const findings = [makeFinding({ id: 'f-huge', evidence: 'x'.repeat(1000) })];
    const batches = planReviewBatches(findings, { maxFindingsPerReviewBatch: 20, maxReviewBodyChars: 10 });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.findings).toHaveLength(1);
  });
});
