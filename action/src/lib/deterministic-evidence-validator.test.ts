import { describe, expect, it } from 'vitest';
import { validateDeterministicEvidence } from './deterministic-evidence-validator.js';
import type { DiffHunk } from './diff-parser.js';
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

describe('validateDeterministicEvidence', () => {
  it('passes when the line is a newly added line within a hunk (rule 1)', () => {
    const hunks: DiffHunk[] = [
      {
        oldStart: 8,
        oldLines: 1,
        newStart: 8,
        newLines: 3,
        lines: [
          { type: 'context', oldLine: 8, newLine: 8, content: 'unchanged' },
          { type: 'add', newLine: 9, content: 'new line' },
          { type: 'add', newLine: 10, content: 'target line' },
        ],
      },
    ];

    const result = validateDeterministicEvidence(makeFinding({ line: 10, side: 'RIGHT' }), 'src/foo.ts', hunks);

    expect(result.status).toBe('passed');
  });

  it('passes when the line is unchanged context but sits within a hunk that also modified nearby lines (rule 2)', () => {
    const hunks: DiffHunk[] = [
      {
        oldStart: 8,
        oldLines: 3,
        newStart: 8,
        newLines: 3,
        lines: [
          { type: 'del', oldLine: 8, content: 'removed line' },
          { type: 'add', newLine: 8, content: 'replacement line' },
          { type: 'context', oldLine: 9, newLine: 9, content: 'unchanged, but in the same hunk' },
        ],
      },
    ];

    const result = validateDeterministicEvidence(makeFinding({ line: 9, side: 'RIGHT' }), 'src/foo.ts', hunks);

    expect(result.status).toBe('passed');
  });

  it('fails when the file was touched elsewhere but this line is outside every hunk range', () => {
    const hunks: DiffHunk[] = [
      {
        oldStart: 100,
        oldLines: 1,
        newStart: 100,
        newLines: 2,
        lines: [
          { type: 'context', oldLine: 100, newLine: 100, content: 'unrelated' },
          { type: 'add', newLine: 101, content: 'unrelated addition' },
        ],
      },
    ];

    const result = validateDeterministicEvidence(makeFinding({ line: 10, side: 'RIGHT' }), 'src/foo.ts', hunks);

    expect(result.status).toBe('failed');
    expect(result.reason).toBeTruthy();
  });

  it('fails when there are no hunks for the file at all', () => {
    const result = validateDeterministicEvidence(makeFinding({ line: 10, side: 'RIGHT' }), 'src/foo.ts', []);

    expect(result.status).toBe('failed');
  });

  it('defers cross-file causal claims to the verifier without evaluating line rules', () => {
    const result = validateDeterministicEvidence(
      makeFinding({ line: 10, side: 'RIGHT', cross_file_causal_claim: true }),
      'src/foo.ts',
      [],
    );

    expect(result.status).toBe('deferred_to_verifier');
  });

  it('fails when the finding path does not match the file the hunks belong to', () => {
    const hunks: DiffHunk[] = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [{ type: 'add', newLine: 1, content: 'x' }],
      },
    ];

    const result = validateDeterministicEvidence(makeFinding({ path: 'src/other.ts' }), 'src/foo.ts', hunks);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/path/i);
  });
});
