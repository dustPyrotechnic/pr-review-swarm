import { describe, expect, it, vi } from 'vitest';
import {
  buildSummaryCommentBody,
  findStableMarkerId,
  upsertSummaryComment,
  type SummaryCommentContext,
} from './summary-comment.js';
import type { Finding } from '../lib/arbiter.js';
import type { VerdictSummary } from '../entrypoints/publish.js';

const ctx: SummaryCommentContext = {
  owner: 'octo',
  repo: 'repo',
  prNumber: 42,
  headSha: 'headsha123',
  baseSha: 'basesha456',
  engineRevision: 'engine-1',
  policyRevision: 'policy-1',
  model: 'deepseek-chat',
  schemaVersion: 'finding-v1',
  verdict: 'changes_requested',
  reviewSetId: 'review-set-1',
};

function makeFinding(id: string): Finding {
  return {
    id,
    path: 'src/foo.ts',
    line: 1,
    side: 'RIGHT',
    severity: 'high',
    confidence: 'high',
    category: 'correctness',
    title: 'title',
    evidence: 'e',
    impact: 'i',
    suggestion: 's',
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    evidence_validation: { status: 'passed' },
    verifier_conclusion: { status: 'confirmed' },
  };
}

const verdictSummary: VerdictSummary = {
  identity_tuple: {
    head_repo: 'octo/repo',
    head_sha: 'headsha123',
    base_repo: 'octo/repo',
    base_ref: 'main',
    base_sha: 'basesha456',
    merge_base_sha: 'mergebasesha789',
  },
  verdict: 'changes_requested',
  review_set_id: 'review-set-1',
  final_findings_count: 1,
  final_review_event: 'COMMENT',
};

describe('findStableMarkerId', () => {
  it('encodes repo/pr/bot/summary as a stable, content-free marker', () => {
    const marker = findStableMarkerId(ctx);
    expect(marker).toContain('marker=summary');
    expect(marker).toContain('repo=octo/repo');
    expect(marker).toContain('pr=42');
  });

  it('is identical across two different verdicts for the same PR', () => {
    const a = findStableMarkerId(ctx);
    const b = findStableMarkerId({ ...ctx, verdict: 'pass', headSha: 'different-sha' });
    expect(a).toBe(b);
  });
});

describe('buildSummaryCommentBody', () => {
  it('includes the stable marker so the comment can be found again', () => {
    const body = buildSummaryCommentBody(ctx, verdictSummary, [makeFinding('f-1')]);
    expect(body).toContain(findStableMarkerId(ctx));
  });

  it('includes the verdict and finding count', () => {
    const body = buildSummaryCommentBody(ctx, verdictSummary, [makeFinding('f-1'), makeFinding('f-2')]);
    expect(body).toContain('changes_requested');
    expect(body).toContain('2');
  });

  it('lists incomplete reasons when present', () => {
    const body = buildSummaryCommentBody(
      ctx,
      { ...verdictSummary, verdict: 'incomplete', incomplete_reasons: ['hard_limit_hit'] },
      [],
    );
    expect(body).toContain('hard_limit_hit');
  });
});

function makeMockOctokit(existingComments: Array<{ id: number; body: string }> = []) {
  return {
    rest: {
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: existingComments }),
        createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }),
        updateComment: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  };
}

describe('upsertSummaryComment', () => {
  it('creates a new comment when no existing comment has the stable marker', async () => {
    const octokit = makeMockOctokit([]);
    const result = await upsertSummaryComment(octokit as never, ctx, 'body text');

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'octo', repo: 'repo', issue_number: 42, body: 'body text' }),
    );
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(result).toEqual({ commentId: 999, action: 'created' });
  });

  it('updates the existing comment when the stable marker matches', async () => {
    const marker = findStableMarkerId(ctx);
    const octokit = makeMockOctokit([{ id: 555, body: `old body\n${marker}` }]);
    const result = await upsertSummaryComment(octokit as never, ctx, 'new body');

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'octo', repo: 'repo', comment_id: 555, body: 'new body' }),
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(result).toEqual({ commentId: 555, action: 'updated' });
  });

  it('ignores unrelated comments without the stable marker', async () => {
    const octokit = makeMockOctokit([{ id: 111, body: 'a human comment' }]);
    await upsertSummaryComment(octokit as never, ctx, 'body text');

    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
  });
});
