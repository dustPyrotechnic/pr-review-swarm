import { describe, expect, it } from 'vitest';
import { arbitrate, type VerifiedCandidate } from './arbiter.js';
import { validate } from './schema-validator.js';
import type { CandidateFinding } from './expert-runner.js';

function makeFinding(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: 'cf-1',
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
    ...overrides,
  };
}

describe('arbitrate', () => {
  it('produces a schema-valid Finding for a single confirmed candidate', () => {
    const candidates: VerifiedCandidate[] = [
      {
        finding: makeFinding(),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'confirmed' },
      },
    ];

    const result = arbitrate(candidates);

    expect(result.findings).toHaveLength(1);
    const validation = validate('https://pr-review-swarm/schemas/finding.schema.json', result.findings[0]);
    expect(validation.valid).toBe(true);
  });

  it('merges two candidates pointing at the same path+line+category into one finding', () => {
    const candidates: VerifiedCandidate[] = [
      {
        finding: makeFinding({ id: 'cf-1', title: 'first description' }),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'confirmed' },
      },
      {
        finding: makeFinding({ id: 'cf-2', title: 'second description, same issue' }),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'confirmed' },
      },
    ];

    const result = arbitrate(candidates);

    expect(result.findings).toHaveLength(1);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'cf-2', outcome: 'merged_into', mergedIntoId: 'cf-1' }),
    );
  });

  it('excludes a candidate that failed deterministic validation from findings', () => {
    const candidates: VerifiedCandidate[] = [
      {
        finding: makeFinding({ id: 'cf-fail' }),
        deterministicStatus: 'failed',
        deterministicReason: 'line not part of any changed hunk',
      },
    ];

    const result = arbitrate(candidates);

    expect(result.findings).toHaveLength(0);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'cf-fail', outcome: 'rejected_deterministic' }),
    );
  });

  it('excludes a candidate the verifier rejected from findings', () => {
    const candidates: VerifiedCandidate[] = [
      {
        finding: makeFinding({ id: 'cf-rejected' }),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'rejected', notes: 'existing guard already handles this' },
      },
    ];

    const result = arbitrate(candidates);

    expect(result.findings).toHaveLength(0);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'cf-rejected', outcome: 'rejected_verifier' }),
    );
  });

  it('never lets a rejected or failed candidate id appear anywhere in the findings output', () => {
    const candidates: VerifiedCandidate[] = [
      { finding: makeFinding({ id: 'cf-ok' }), deterministicStatus: 'passed', verifierConclusion: { status: 'confirmed' } },
      { finding: makeFinding({ id: 'cf-fail', line: 20 }), deterministicStatus: 'failed' },
      {
        finding: makeFinding({ id: 'cf-rejected', line: 30 }),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'rejected' },
      },
    ];

    const result = arbitrate(candidates);

    const findingIds = result.findings.map((f) => f.id);
    expect(findingIds).toEqual(['cf-ok']);
  });
});
