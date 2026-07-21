import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPublishResult } from './publish.js';
import { validate } from '../lib/schema-validator.js';
import type { CoverageManifest } from './prepare.js';
import type { Finding } from '../lib/arbiter.js';
import type { IdentityTuple } from '../lib/identity-tuple.js';

const identityTuple: IdentityTuple = {
  headRepo: 'octo/head-repo',
  headSha: 'headsha123',
  baseRepo: 'octo/repo',
  baseRef: 'main',
  baseSha: 'basesha456',
  mergeBaseSha: 'mergebasesha789',
};

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

const baseInput = {
  currentIdentityTuple: identityTuple,
  expectedIdentityTuple: identityTuple,
  coverageManifest: makeCoverageManifest(),
  anyRequiredStageFailed: false,
  reviewSetId: 'review-set-1',
};

describe('buildPublishResult', () => {
  it('produces a schema-valid verdict summary for the pass case', () => {
    const result = buildPublishResult({ ...baseInput, findings: [] });

    expect(result.verdictSummary.verdict).toBe('pass');
    expect(result.verdictSummary.final_review_event).toBe('none');
    const validation = validate('https://pr-review-swarm/schemas/verdict.schema.json', result.verdictSummary);
    expect(validation.valid).toBe(true);
  });

  it('reports changes_requested when there are findings, but never sets a real review event in Phase 1', () => {
    const result = buildPublishResult({ ...baseInput, findings: [makeFinding('cf-1')] });

    expect(result.verdictSummary.verdict).toBe('changes_requested');
    expect(result.verdictSummary.final_findings_count).toBe(1);
    expect(result.verdictSummary.final_review_event).toBe('none');
  });

  it('reports incomplete with reasons when coverage was not complete', () => {
    const result = buildPublishResult({
      ...baseInput,
      coverageManifest: makeCoverageManifest({ shards_complete: false }),
      findings: [],
    });

    expect(result.verdictSummary.verdict).toBe('incomplete');
    expect(result.verdictSummary.incomplete_reasons).toContain('shards_incomplete');
  });

  it('reports stale_cancelled when the re-fetched identity tuple no longer matches the locked one', () => {
    const result = buildPublishResult({
      ...baseInput,
      currentIdentityTuple: { ...identityTuple, headSha: 'a-new-push-happened' },
      findings: [makeFinding('cf-1')],
    });

    expect(result.verdictSummary.verdict).toBe('stale_cancelled');
    expect(result.verdictSummary.final_findings_count).toBe(0);
    expect(result.verdictSummary.final_review_event).toBe('none');
  });

  it('includes the verdict and finding count in the markdown summary', () => {
    const result = buildPublishResult({ ...baseInput, findings: [makeFinding('cf-1')] });

    expect(result.markdownSummary).toContain('changes_requested');
    expect(result.markdownSummary).toContain('src/foo.ts');
  });
});

describe('publish.ts Phase 1 write-lock', () => {
  it('never references any GitHub review/comment write API method', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'publish.ts'),
      'utf-8',
    );
    const forbidden = [
      'createReview',
      'submitReview',
      'createReviewComment',
      'issues.createComment',
      'issues.updateComment',
      'pulls.createReview',
    ];
    for (const term of forbidden) {
      expect(source).not.toContain(term);
    }
  });
});
