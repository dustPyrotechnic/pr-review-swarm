import { describe, expect, it, vi } from 'vitest';
import { buildPublishResult, executePublish, resolveEngineRevision } from './publish.js';
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
  it('produces a schema-valid verdict summary for the pass case, with final_review_event APPROVE', () => {
    const result = buildPublishResult({ ...baseInput, findings: [] });

    expect(result.verdictSummary.verdict).toBe('pass');
    expect(result.verdictSummary.final_review_event).toBe('APPROVE');
    const validation = validate('https://pr-review-swarm/schemas/verdict.schema.json', result.verdictSummary);
    expect(validation.valid).toBe(true);
  });

  it('reports changes_requested with final_review_event REQUEST_CHANGES when there are findings', () => {
    const result = buildPublishResult({ ...baseInput, findings: [makeFinding('cf-1')] });

    expect(result.verdictSummary.verdict).toBe('changes_requested');
    expect(result.verdictSummary.final_findings_count).toBe(1);
    expect(result.verdictSummary.final_review_event).toBe('REQUEST_CHANGES');
  });

  it('reports incomplete with reasons when coverage was not complete, with REQUEST_CHANGES when findings survived', () => {
    const result = buildPublishResult({
      ...baseInput,
      coverageManifest: makeCoverageManifest({ shards_complete: false }),
      findings: [makeFinding('cf-1')],
    });

    expect(result.verdictSummary.verdict).toBe('incomplete');
    expect(result.verdictSummary.incomplete_reasons).toContain('shards_incomplete');
    expect(result.verdictSummary.final_review_event).toBe('REQUEST_CHANGES');
    expect(result.markdownSummary).toContain('⚠️ 本次审核未完整覆盖');
  });

  it('reports incomplete with final_review_event none when there are zero surviving findings', () => {
    const result = buildPublishResult({
      ...baseInput,
      coverageManifest: makeCoverageManifest({ shards_complete: false }),
      findings: [],
    });

    expect(result.verdictSummary.verdict).toBe('incomplete');
    expect(result.verdictSummary.final_review_event).toBe('none');
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

describe('resolveEngineRevision', () => {
  it('prefers GITHUB_ACTION_REF — the exact pinned SHA the consuming repo\'s `uses:` line resolved to', () => {
    const revision = resolveEngineRevision({
      GITHUB_ACTION_REF: 'abc1234',
      PR_REVIEW_SWARM_ENGINE_REVISION: 'should-not-be-used',
    });
    expect(revision).toBe('abc1234');
  });

  it('falls back to PR_REVIEW_SWARM_ENGINE_REVISION when GITHUB_ACTION_REF is unset', () => {
    const revision = resolveEngineRevision({ PR_REVIEW_SWARM_ENGINE_REVISION: 'manual-override' });
    expect(revision).toBe('manual-override');
  });

  it('falls back to unknown-engine-revision when neither is set', () => {
    expect(resolveEngineRevision({})).toBe('unknown-engine-revision');
  });

  it('ignores an empty-string GITHUB_ACTION_REF and falls through', () => {
    const revision = resolveEngineRevision({ GITHUB_ACTION_REF: '', PR_REVIEW_SWARM_ENGINE_REVISION: 'fallback' });
    expect(revision).toBe('fallback');
  });
});

const engineCtx = {
  engineRevision: 'engine-1',
  policyRevision: 'policy-1',
  model: 'deepseek-chat',
  schemaVersion: 'finding-v1',
};

const reviewBatchLimits = { maxFindingsPerReviewBatch: 20, maxReviewBodyChars: 60000 };

const DEFAULT_PATCH = ['@@ -1,2 +1,3 @@', ' context line', '+added line', ' context line 2'].join('\n');

function makeMockOctokit(overrides: {
  listReviews?: Array<{ id: number; body: string | null }>;
  listReviewComments?: Array<{ id: number; pull_request_review_id: number }>;
  files?: Array<{ filename: string; patch?: string }>;
} = {}) {
  const files = overrides.files ?? [{ filename: 'src/foo.ts', patch: DEFAULT_PATCH }];
  return {
    paginate: vi.fn(async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) => {
      const { data } = await fn(params);
      return data;
    }),
    rest: {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({ data: overrides.listReviews ?? [] }),
        listFiles: vi.fn().mockResolvedValue({ data: files }),
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

  it('publishes a single REQUEST_CHANGES batch and upserts the summary comment when there are findings', async () => {
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
      expect.objectContaining({ owner: 'octo', repo: 'repo', pull_number: 42, event: 'REQUEST_CHANGES', commit_id: 'headsha123' }),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(result.verdictSummary.final_review_event).toBe('REQUEST_CHANGES');
  });

  it('publishes an APPROVE batch and mentions the configured default_mention when the verdict is pass', async () => {
    const octokit = makeMockOctokit();
    const result = await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings: [],
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      defaultMention: 'dustPyrotechnic',
      ...engineCtx,
    });

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
    expect(result.verdictSummary.final_review_event).toBe('APPROVE');
    const summaryBody = octokit.rest.issues.createComment.mock.calls[0][0].body as string;
    expect(summaryBody).toContain('@dustPyrotechnic');
  });

  it('only updates the summary comment, without submitting a Review, when incomplete with zero findings', async () => {
    const octokit = makeMockOctokit();
    const result = await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings: [],
      coverageManifest: makeCoverageManifest({ shards_complete: false }),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    expect(result.verdictSummary.verdict).toBe('incomplete');
    expect(result.verdictSummary.final_review_event).toBe('none');
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const summaryBody = octokit.rest.issues.createComment.mock.calls[0][0].body as string;
    expect(summaryBody).toContain('⚠️ 本次审核未完整覆盖');
  });

  it('includes the incomplete banner in the Review body when incomplete but findings survived', async () => {
    const octokit = makeMockOctokit();
    await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings: [makeFinding('cf-1')],
      coverageManifest: makeCoverageManifest({ shards_complete: false }),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    const createReviewCall = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(createReviewCall.event).toBe('REQUEST_CHANGES');
    expect(createReviewCall.body).toContain('⚠️ 本次审核未完整覆盖');
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

  it('re-fetches the current diff and downgrades an unlocatable finding to the Review body instead of dropping it', async () => {
    const octokit = makeMockOctokit(); // default diff only covers src/foo.ts lines 1-3
    const locatable = makeFinding('cf-locatable'); // path src/foo.ts, line 1, RIGHT — in diff
    const unlocatable = { ...makeFinding('cf-unlocatable'), line: 999, title: 'unlocatable title' };

    await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: identityTuple,
      expectedIdentityTuple: identityTuple,
      findings: [locatable, unlocatable],
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'octo', repo: 'repo', pull_number: 42 }),
    );
    const createReviewCall = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(createReviewCall.comments).toHaveLength(1);
    expect(createReviewCall.comments[0].line).toBe(1);
    expect(createReviewCall.body).toContain('unlocatable title');
  });

  it('retries a transient createReview failure and still succeeds', async () => {
    const octokit = makeMockOctokit();
    const transientError = Object.assign(new Error('rate limited'), { status: 429 });
    octokit.rest.pulls.createReview = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ data: { id: 1 } });
    const retrySleep = vi.fn().mockResolvedValue(undefined);

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
      maxPublishRetries: 3,
      retrySleep,
      ...engineCtx,
    });

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(2);
    expect(retrySleep).toHaveBeenCalledTimes(1);
    expect(result.verdictSummary.verdict).toBe('changes_requested');
  });

  it('gives up and propagates the error after exhausting maxPublishRetries', async () => {
    const octokit = makeMockOctokit();
    const persistentError = Object.assign(new Error('still failing'), { status: 503 });
    octokit.rest.pulls.createReview = vi.fn().mockRejectedValue(persistentError);
    const retrySleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      executePublish({
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
        maxPublishRetries: 2,
        retrySleep,
        ...engineCtx,
      }),
    ).rejects.toBe(persistentError);

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry a non-retryable error (e.g. 422 validation failure)', async () => {
    const octokit = makeMockOctokit();
    const validationError = Object.assign(new Error('unprocessable'), { status: 422 });
    octokit.rest.pulls.createReview = vi.fn().mockRejectedValue(validationError);
    const retrySleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      executePublish({
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
        maxPublishRetries: 3,
        retrySleep,
        ...engineCtx,
      }),
    ).rejects.toBe(validationError);

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(retrySleep).not.toHaveBeenCalled();
  });
});
