import { describe, expect, it } from 'vitest';
import { computeVerdict, computeFinalReviewEvent } from './verdict.js';
import type { CoverageManifest } from '../entrypoints/prepare.js';
import type { Finding } from './arbiter.js';

function makeCoverageManifest(overrides: Partial<CoverageManifest> = {}): CoverageManifest {
  return {
    files: [],
    shards_complete: true,
    hard_limit_hit: false,
    pulls_files_pagination_truncated: false,
    missing_patch_files: [],
    token_usage: { prompt_tokens: 0, completion_tokens: 0 },
    ...overrides,
  };
}

function makeFinding(id: string): Finding {
  return {
    id,
    path: 'src/foo.ts',
    line: 1,
    side: 'RIGHT',
    severity: 'high',
    confidence: 'high',
    category: 'correctness',
    title: 't',
    evidence: 'e',
    impact: 'i',
    suggestion: 's',
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    evidence_validation: { status: 'passed' },
    verifier_conclusion: { status: 'confirmed' },
  };
}

const completeInput = {
  coverageManifest: makeCoverageManifest(),
  anyRequiredStageFailed: false,
};

describe('computeVerdict', () => {
  it('returns pass when everything is complete and there are no findings', () => {
    const result = computeVerdict({ ...completeInput, finalFindings: [] });
    expect(result.verdict).toBe('pass');
    expect(result.incompleteReasons).toEqual([]);
  });

  it('returns changes_requested when everything is complete and there is at least one finding', () => {
    const result = computeVerdict({ ...completeInput, finalFindings: [makeFinding('cf-1')] });
    expect(result.verdict).toBe('changes_requested');
  });

  it('returns incomplete when coverageManifest.hard_limit_hit is true, even with zero findings', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ hard_limit_hit: true }),
      finalFindings: [],
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('hard_limit_hit');
  });

  it('returns incomplete when anyRequiredStageFailed is true', () => {
    const result = computeVerdict({ ...completeInput, anyRequiredStageFailed: true, finalFindings: [] });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('any_required_stage_failed');
  });

  it('returns incomplete when shards_complete is false', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ shards_complete: false }),
      finalFindings: [],
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('shards_incomplete');
  });

  it('returns incomplete when pulls_files_pagination_truncated is true', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ pulls_files_pagination_truncated: true }),
      finalFindings: [],
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('pulls_files_pagination_truncated');
  });

  it('returns incomplete when there are missing_patch_files', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ missing_patch_files: ['src/huge.ts'] }),
      finalFindings: [],
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('missing_patch_files');
  });

  it('still reports incomplete (never pass) even when there happen to be findings but coverage is incomplete', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ hard_limit_hit: true }),
      finalFindings: [makeFinding('cf-1')],
    });
    expect(result.verdict).toBe('incomplete');
  });

  it('collects multiple incomplete reasons at once', () => {
    const result = computeVerdict({
      coverageManifest: makeCoverageManifest({
        shards_complete: false,
        missing_patch_files: ['a.ts'],
        hard_limit_hit: true,
      }),
      anyRequiredStageFailed: false,
      finalFindings: [],
    });
    expect(result.incompleteReasons).toEqual(
      expect.arrayContaining(['hard_limit_hit', 'shards_incomplete', 'missing_patch_files']),
    );
  });
});

describe('computeFinalReviewEvent', () => {
  it('returns COMMENT (never APPROVE) for a pass verdict — the bot never gives final merge confirmation, a human always does', () => {
    expect(computeFinalReviewEvent('pass', 0)).toBe('COMMENT');
  });

  it('returns REQUEST_CHANGES for a changes_requested verdict', () => {
    expect(computeFinalReviewEvent('changes_requested', 3)).toBe('REQUEST_CHANGES');
  });

  it('returns REQUEST_CHANGES for an incomplete verdict that still has verified findings', () => {
    expect(computeFinalReviewEvent('incomplete', 1)).toBe('REQUEST_CHANGES');
  });

  it('returns none for an incomplete verdict with zero findings — nothing to request changes on', () => {
    expect(computeFinalReviewEvent('incomplete', 0)).toBe('none');
  });

  it.each(['pass', 'changes_requested', 'incomplete'] as const)(
    'never returns APPROVE for verdict=%s at any findings count — the bot never submits an approving Review',
    (verdict) => {
      for (const count of [0, 1, 5]) {
        expect(computeFinalReviewEvent(verdict, count)).not.toBe('APPROVE');
      }
    },
  );
});
