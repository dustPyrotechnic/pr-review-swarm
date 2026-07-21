import { describe, expect, it } from 'vitest';
import { computeFindingsDigest, computeReviewSetId, type ReviewSetIdInput } from './review-set-id.js';
import type { Finding } from './arbiter.js';
import type { SchemaIdentityTuple } from './identity-tuple.js';

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

const identityTuple: SchemaIdentityTuple = {
  head_repo: 'owner/repo',
  head_sha: 'abc123',
  base_repo: 'owner/repo',
  base_ref: 'main',
  base_sha: 'def456',
  merge_base_sha: 'ghi789',
};

function baseInput(findings: Finding[]): ReviewSetIdInput {
  return {
    identityTuple,
    engineRevision: 'engine-1',
    policyRevision: 'policy-1',
    model: 'deepseek-chat',
    schemaVersion: 'finding-v1',
    findings,
  };
}

describe('computeFindingsDigest', () => {
  it('is a deterministic function of the finding ids', () => {
    const findings = [makeFinding({ id: 'f-1' }), makeFinding({ id: 'f-2' })];
    expect(computeFindingsDigest(findings)).toBe(computeFindingsDigest(findings));
  });

  it('is order-independent (sorts ids before hashing)', () => {
    const a = [makeFinding({ id: 'f-1' }), makeFinding({ id: 'f-2' })];
    const b = [makeFinding({ id: 'f-2' }), makeFinding({ id: 'f-1' })];
    expect(computeFindingsDigest(a)).toBe(computeFindingsDigest(b));
  });

  it('changes when the finding id set changes', () => {
    const a = [makeFinding({ id: 'f-1' })];
    const b = [makeFinding({ id: 'f-2' })];
    expect(computeFindingsDigest(a)).not.toBe(computeFindingsDigest(b));
  });

  it('returns a 16-character lowercase hex string', () => {
    const digest = computeFindingsDigest([makeFinding()]);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns a stable digest for an empty finding set', () => {
    expect(computeFindingsDigest([])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('computeReviewSetId', () => {
  it('is a deterministic function of its input', () => {
    const input = baseInput([makeFinding()]);
    expect(computeReviewSetId(input)).toBe(computeReviewSetId(input));
  });

  it('changes when the findings content changes', () => {
    const a = computeReviewSetId(baseInput([makeFinding({ title: 'title A' })]));
    const b = computeReviewSetId(baseInput([makeFinding({ title: 'title B' })]));
    expect(a).not.toBe(b);
  });

  it('does not change when findings are only reordered', () => {
    const findings1 = [makeFinding({ id: 'f-1' }), makeFinding({ id: 'f-2' })];
    const findings2 = [makeFinding({ id: 'f-2' }), makeFinding({ id: 'f-1' })];
    expect(computeReviewSetId(baseInput(findings1))).toBe(computeReviewSetId(baseInput(findings2)));
  });

  it('changes when the identity tuple changes', () => {
    const a = computeReviewSetId(baseInput([makeFinding()]));
    const b = computeReviewSetId({
      ...baseInput([makeFinding()]),
      identityTuple: { ...identityTuple, head_sha: 'different-sha' },
    });
    expect(a).not.toBe(b);
  });

  it('changes when the engine revision changes', () => {
    const a = computeReviewSetId(baseInput([makeFinding()]));
    const b = computeReviewSetId({ ...baseInput([makeFinding()]), engineRevision: 'engine-2' });
    expect(a).not.toBe(b);
  });

  it('returns a 20-character lowercase hex string', () => {
    const id = computeReviewSetId(baseInput([makeFinding()]));
    expect(id).toMatch(/^[0-9a-f]{20}$/);
  });
});
