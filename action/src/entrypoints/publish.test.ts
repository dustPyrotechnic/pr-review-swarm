import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildPublishResult, executePublish } from './publish.js';
import { validate } from '../lib/schema-validator.js';
import { encodeBatchMarker } from '../lib/hidden-marker.js';
import { computeFindingsDigest } from '../lib/review-set-id.js';
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
    // Phase 2: every non-stale run publishes at least an empty COMMENT batch.
    expect(result.verdictSummary.final_review_event).toBe('COMMENT');
    const validation = validate('https://pr-review-swarm/schemas/verdict.schema.json', result.verdictSummary);
    expect(validation.valid).toBe(true);
  });

  it('reports changes_requested when there are findings, with final_review_event fixed to COMMENT (Phase 2 never emits REQUEST_CHANGES/APPROVE)', () => {
    const result = buildPublishResult({ ...baseInput, findings: [makeFinding('cf-1')] });

    expect(result.verdictSummary.verdict).toBe('changes_requested');
    expect(result.verdictSummary.final_findings_count).toBe(1);
    expect(result.verdictSummary.final_review_event).toBe('COMMENT');
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

describe('publish.ts Phase 2 event-lock', () => {
  it('never assigns event/final_review_event to REQUEST_CHANGES or APPROVE — Phase 2 only ever publishes COMMENT', () => {
    // The VerdictSummary/schema type union legitimately spells out
    // REQUEST_CHANGES/APPROVE as future-valid values (Phase 3 will add real
    // branches), so this lock strips the `interface VerdictSummary` type
    // declaration line before scanning the remaining runtime code for actual
    // assignments of those literals.
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'publish.ts'),
      'utf-8',
    );
    const runtimeSource = source
      .split('\n')
      .filter((line) => !line.includes("'APPROVE' | 'REQUEST_CHANGES'"))
      .join('\n');

    expect(runtimeSource).not.toContain('REQUEST_CHANGES');
    expect(runtimeSource).not.toContain("'APPROVE'");
    expect(runtimeSource).not.toContain('"APPROVE"');
  });
});

const engineCtx = {
  engineRevision: 'engine-1',
  policyRevision: 'policy-1',
  model: 'deepseek-chat',
  schemaVersion: 'finding-v1',
};

const reviewBatchLimits = { maxFindingsPerReviewBatch: 20, maxReviewBodyChars: 60000 };

function makeMockOctokit(overrides: {
  listReviews?: Array<{ id: number; body: string | null }>;
  listReviewComments?: Array<{ id: number; pull_request_review_id: number }>;
} = {}) {
  return {
    rest: {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({ data: overrides.listReviews ?? [] }),
        createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }),
        updateReview: vi.fn().mockResolvedValue({ data: {} }),
        listReviewComments: vi.fn().mockResolvedValue({ data: overrides.listReviewComments ?? [] }),
        updateReviewComment: vi.fn().mockResolvedValue({ data: {} }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }),
        updateComment: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  };
}

describe('executePublish', () => {
  it('does not call any GitHub write API when the identity tuple is stale', async () => {
    const octokit = makeMockOctokit();
    const result = await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: { ...identityTuple, headSha: 'a-new-push-happened' },
      expectedIdentityTuple: identityTuple,
      findings: [makeFinding('cf-1')],
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    expect(result.verdictSummary.verdict).toBe('stale_cancelled');
    expect(octokit.rest.pulls.listReviews).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('publishes a single COMMENT batch and upserts the summary comment when everything fits', async () => {
    const octokit = makeMockOctokit();
    const result = await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings: [makeFinding('cf-1')],
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'octo', repo: 'repo', pull_number: 42, event: 'COMMENT', commit_id: 'headsha123' }),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(result.verdictSummary.final_review_event).toBe('COMMENT');
  });

  it('splits into multiple createReview calls when the batch count limit is exceeded', async () => {
    const octokit = makeMockOctokit();
    const findings = Array.from({ length: 25 }, (_, i) => makeFinding(`cf-${i}`));
    await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings,
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits: { ...reviewBatchLimits, maxFindingsPerReviewBatch: 10 },
      ...engineCtx,
    });

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(3);
  });

  it('skips a batch that was already published with a matching findings_digest (in-run reconciliation)', async () => {
    const findings = [makeFinding('cf-1')];
    const digest = computeFindingsDigest(findings);
    // We don't know reviewSetId ahead of time in the test, so instead assert
    // via a second run: publish once, then re-run against the review it
    // "already published" (simulated by injecting a matching marker below).
    const octokit = makeMockOctokit();
    const first = await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings,
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });
    const reviewSetId = first.verdictSummary.review_set_id;

    octokit.rest.pulls.listReviews = vi.fn().mockResolvedValue({
      data: [{ id: 555, body: encodeBatchMarker({ reviewSetId, batchIndex: 0, batchCount: 1, digest }) }],
    });
    octokit.rest.pulls.createReview = vi.fn().mockResolvedValue({ data: { id: 2 } });

    await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings,
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('reports incomplete and stops publishing when an already-published batch has a mismatched digest', async () => {
    const findings = [makeFinding('cf-1')];
    const octokit = makeMockOctokit();
    const first = await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings,
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });
    const reviewSetId = first.verdictSummary.review_set_id;

    octokit.rest.pulls.listReviews = vi.fn().mockResolvedValue({
      data: [
        { id: 555, body: encodeBatchMarker({ reviewSetId, batchIndex: 0, batchCount: 1, digest: 'wrong-digest' }) },
      ],
    });
    octokit.rest.pulls.createReview = vi.fn().mockResolvedValue({ data: { id: 2 } });

    const result = await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings,
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    expect(result.verdictSummary.verdict).toBe('incomplete');
    expect(result.verdictSummary.incomplete_reasons).toContain('digest_mismatch');
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('appends a superseded notice to reviews and their comments from an older review_set_id', async () => {
    const octokit = makeMockOctokit({
      listReviews: [{ id: 777, body: encodeBatchMarker({ reviewSetId: 'old-set', batchIndex: 0, batchCount: 1, digest: 'abc' }) }],
      listReviewComments: [{ id: 888, pull_request_review_id: 777 }],
    });

    await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings: [makeFinding('cf-1')],
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    expect(octokit.rest.pulls.updateReview).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'octo', repo: 'repo', pull_number: 42, review_id: 777 }),
    );
    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'octo', repo: 'repo', comment_id: 888 }),
    );
  });
});
