import { describe, expect, it, vi } from 'vitest';
import { executePublish } from '../../src/entrypoints/publish.js';
import type { CoverageManifest } from '../../src/entrypoints/prepare.js';
import type { Finding } from '../../src/lib/arbiter.js';
import type { IdentityTuple } from '../../src/lib/identity-tuple.js';

// design doc L300: "验证 REQUEST_CHANGES → 新 commit → APPROVE 完整生命周期"
// (updated: the bot never submits APPROVE — a human always gives final merge
// confirmation — so a clean fix commit clears REQUEST_CHANGES down to a
// neutral COMMENT, not an approving Review). This drives two real
// executePublish calls against one stateful in-memory GitHub double,
// simulating: first push has a bug (REQUEST_CHANGES), author fixes it in a
// second commit (clean -> COMMENT) — and asserts the first review gets
// properly superseded rather than left standing alongside the new one.

function makeCoverageManifest(): CoverageManifest {
  return {
    files: [],
    shards_complete: true,
    hard_limit_hit: false,
    pulls_files_pagination_truncated: false,
    missing_patch_files: [],
    token_usage: { prompt_tokens: 0, completion_tokens: 0 },
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
    title: 'bug',
    evidence: 'e',
    impact: 'i',
    suggestion: 's',
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    evidence_validation: { status: 'passed' },
    verifier_conclusion: { status: 'confirmed' },
  };
}

const DEFAULT_PATCH = ['@@ -1,2 +1,3 @@', ' context line', '+added line', ' context line 2'].join('\n');

function makeStatefulOctokit() {
  let nextReviewId = 1;
  const reviews: Array<{ id: number; state: string; body: string | null; commit_id: string }> = [];
  const reviewComments: Array<{ id: number; pull_request_review_id: number; body: string }> = [];

  return {
    _reviews: reviews,
    paginate: vi.fn(async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) => {
      const { data } = await fn(params);
      return data;
    }),
    rest: {
      pulls: {
        listReviews: vi.fn(async () => ({ data: reviews })),
        listFiles: vi.fn().mockResolvedValue({ data: [{ filename: 'src/foo.ts', patch: DEFAULT_PATCH }] }),
        createReview: vi.fn(async (params: { event: string; body: string; commit_id: string }) => {
          const id = nextReviewId++;
          const state =
            params.event === 'COMMENT' ? 'COMMENTED' : params.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
          reviews.push({ id, state, body: params.body, commit_id: params.commit_id });
          return { data: { id } };
        }),
        dismissReview: vi.fn(async (params: { review_id: number }) => {
          const review = reviews.find((r) => r.id === params.review_id);
          if (review) review.state = 'DISMISSED';
          return { data: {} };
        }),
        updateReview: vi.fn(async (params: { review_id: number; body: string }) => {
          const review = reviews.find((r) => r.id === params.review_id);
          if (review) review.body = params.body;
          return { data: {} };
        }),
        listReviewComments: vi.fn(async () => ({ data: reviewComments })),
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

const reviewBatchLimits = { maxFindingsPerReviewBatch: 20, maxReviewBodyChars: 60000 };
const engineCtx = {
  engineRevision: 'engine-1',
  policyRevision: 'policy-1',
  model: 'deepseek-chat',
  schemaVersion: 'finding-v1',
};

describe('REQUEST_CHANGES -> new commit -> clean (COMMENT) lifecycle', () => {
  it('supersedes the old REQUEST_CHANGES review (dismissed) once the fix commit comes back clean', async () => {
    const octokit = makeStatefulOctokit();

    const firstIdentity: IdentityTuple = {
      headRepo: 'octo/head-repo',
      headSha: 'sha-with-bug',
      baseRepo: 'octo/repo',
      baseRef: 'main',
      baseSha: 'basesha',
      mergeBaseSha: 'mergebasesha',
    };

    const firstResult = await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: firstIdentity,
      expectedIdentityTuple: firstIdentity,
      findings: [makeFinding('cf-1')],
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    expect(firstResult.verdictSummary.final_review_event).toBe('REQUEST_CHANGES');
    expect(octokit._reviews).toHaveLength(1);
    expect(octokit._reviews[0].state).toBe('CHANGES_REQUESTED');

    const secondIdentity: IdentityTuple = {
      ...firstIdentity,
      headSha: 'sha-with-fix',
    };

    const secondResult = await executePublish({
      octokit: octokit as never,
      owner: 'octo',
      repo: 'repo',
      prNumber: 42,
      currentIdentityTuple: secondIdentity,
      expectedIdentityTuple: secondIdentity,
      findings: [],
      coverageManifest: makeCoverageManifest(),
      anyRequiredStageFailed: false,
      reviewBatchLimits,
      ...engineCtx,
    });

    expect(secondResult.verdictSummary.final_review_event).toBe('COMMENT');
    expect(octokit.rest.pulls.dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: octokit._reviews[0].id }),
    );
    expect(octokit._reviews[0].state).toBe('DISMISSED');

    const activeReview = octokit._reviews.find((r) => r.commit_id === 'sha-with-fix');
    expect(activeReview?.state).toBe('COMMENTED');
  });
});
