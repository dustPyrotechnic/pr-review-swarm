import { describe, expect, it, vi } from 'vitest';
import { determineConclusion, finalizeStatus } from './status-finalize.js';
import type { VerdictSummary } from './publish.js';

const identityTuple = {
  head_repo: 'octo/head-repo',
  head_sha: 'headsha123',
  base_repo: 'octo/repo',
  base_ref: 'main',
  base_sha: 'basesha456',
  merge_base_sha: 'mergebasesha789',
};

function makeVerdictSummary(overrides: Partial<VerdictSummary> = {}): VerdictSummary {
  return {
    identity_tuple: identityTuple,
    verdict: 'pass',
    review_set_id: 'review-set-1',
    final_findings_count: 0,
    final_review_event: 'none',
    ...overrides,
  };
}

describe('determineConclusion', () => {
  it('maps verdict "pass" to conclusion "success"', () => {
    expect(determineConclusion({ verdictSummary: makeVerdictSummary({ verdict: 'pass' }) })).toBe('success');
  });

  it('maps verdict "changes_requested" to conclusion "failure"', () => {
    expect(
      determineConclusion({ verdictSummary: makeVerdictSummary({ verdict: 'changes_requested' }) }),
    ).toBe('failure');
  });

  it('maps verdict "incomplete" to conclusion "action_required"', () => {
    expect(
      determineConclusion({ verdictSummary: makeVerdictSummary({ verdict: 'incomplete' }) }),
    ).toBe('action_required');
  });

  it('maps verdict "stale_cancelled" to conclusion "cancelled"', () => {
    expect(
      determineConclusion({ verdictSummary: makeVerdictSummary({ verdict: 'stale_cancelled' }) }),
    ).toBe('cancelled');
  });

  it('maps a missing verdict summary with a timeout failure to "timed_out"', () => {
    expect(determineConclusion({ upstreamFailureKind: 'timeout' })).toBe('timed_out');
  });

  it('maps a missing verdict summary with any other failure to "action_required"', () => {
    expect(determineConclusion({ upstreamFailureKind: 'other' })).toBe('action_required');
    expect(determineConclusion({})).toBe('action_required');
  });
});

describe('finalizeStatus', () => {
  it('patches the check run to the conclusion derived from the verdict summary', async () => {
    const octokit = { rest: { checks: { update: vi.fn().mockResolvedValue({ data: {} }) } } };

    await finalizeStatus(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      checkRunId: 111,
      verdictSummary: makeVerdictSummary({ verdict: 'changes_requested' }),
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octo',
        repo: 'repo',
        check_run_id: 111,
        status: 'completed',
        conclusion: 'failure',
      }),
    );
  });

  it('patches to timed_out when there is no verdict summary and the failure kind is timeout', async () => {
    const octokit = { rest: { checks: { update: vi.fn().mockResolvedValue({ data: {} }) } } };

    await finalizeStatus(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      checkRunId: 111,
      upstreamFailureKind: 'timeout',
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 111, conclusion: 'timed_out' }),
    );
  });
});
