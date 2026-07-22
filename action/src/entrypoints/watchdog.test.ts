import { describe, expect, it, vi } from 'vitest';
import { runWatchdog, checkForPublishedFinalReview } from './watchdog.js';
import { encodeExternalId } from '../lib/check-run.js';
import { encodeBatchMarker } from '../lib/hidden-marker.js';

const NOW = new Date('2026-07-20T12:00:00Z').getTime();

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function makeExternalId(runId: string) {
  return encodeExternalId({
    owner: 'octo',
    repo: 'repo',
    prNumber: 1,
    headSha: 'headsha123',
    baseSha: 'basesha456',
    mergeBaseSha: 'mergebasesha789',
    runId,
    runAttempt: '1',
  });
}

function makeOctokit(options: {
  commits?: Array<{ sha: string }>;
  checkRuns?: Array<{ id: number; status: string; started_at?: string; external_id?: string }>;
  workflowRunStatus?: string;
  reviews?: Array<{ commit_id: string; state: string; body: string | null }>;
}) {
  const commits = options.commits ?? [{ sha: 'headsha123' }];
  const checkRuns = options.checkRuns ?? [];

  return {
    rest: {
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [{ number: 1, updated_at: isoMinutesAgo(1) }] }),
        listCommits: vi.fn().mockResolvedValue({ data: commits }),
        listReviews: vi.fn().mockResolvedValue({ data: options.reviews ?? [] }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { check_runs: checkRuns } }),
        update: vi.fn().mockResolvedValue({ data: {} }),
      },
      actions: {
        getWorkflowRun: vi.fn().mockResolvedValue({ data: { status: options.workflowRunStatus ?? 'completed' } }),
      },
    },
    paginate: vi.fn(async (fn: (params: unknown) => Promise<{ data: unknown }>, params: unknown) => {
      const { data } = await fn(params);
      return data;
    }),
  };
}

const baseLimits = {
  watchdogStaleThresholdMinutes: 30,
  maxCommitsPerPrForWatchdogScan: 250,
  maxPrsPerWatchdogRun: 50,
};

describe('checkForPublishedFinalReview', () => {
  const params = { owner: 'octo', repo: 'repo', prNumber: 1, headSha: 'headsha123' };

  it('returns null when there is no matching review for the given head_sha', async () => {
    const octokit = makeOctokit({ reviews: [] });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBeNull();
  });

  it('returns APPROVE when a bot-owned APPROVED review exists for the head_sha', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'headsha123', state: 'APPROVED', body: marker }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBe('APPROVE');
  });

  it('returns REQUEST_CHANGES when a bot-owned CHANGES_REQUESTED review exists for the head_sha', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'headsha123', state: 'CHANGES_REQUESTED', body: marker }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBe('REQUEST_CHANGES');
  });

  it('ignores a human-authored review without a bot marker', async () => {
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'headsha123', state: 'APPROVED', body: 'looks good to me' }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBeNull();
  });

  it('ignores a bot review for a different head_sha (stale/older push)', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'some-older-sha', state: 'APPROVED', body: marker }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBeNull();
  });

  it('ignores a bot review left in COMMENT state (not a final verdict)', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'headsha123', state: 'COMMENTED', body: marker }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBeNull();
  });
});

describe('runWatchdog', () => {
  it('does not finalize a check whose workflow run is still in_progress', async () => {
    const octokit = makeOctokit({
      checkRuns: [
        { id: 111, status: 'in_progress', started_at: isoMinutesAgo(60), external_id: makeExternalId('1000') },
      ],
      workflowRunStatus: 'in_progress',
    });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(octokit.rest.checks.update).not.toHaveBeenCalled();
    expect(results[0]?.finalizedCheckRunIds).toEqual([]);
  });

  it('finalizes a stale in_progress check as timed_out once its workflow run has completed', async () => {
    const octokit = makeOctokit({
      checkRuns: [
        { id: 111, status: 'in_progress', started_at: isoMinutesAgo(60), external_id: makeExternalId('1000') },
      ],
      workflowRunStatus: 'completed',
    });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 111, conclusion: 'timed_out' }),
    );
    expect(results[0]?.finalizedCheckRunIds).toEqual([111]);
  });

  it('does not finalize a check that has not yet crossed the stale threshold', async () => {
    const octokit = makeOctokit({
      checkRuns: [
        { id: 111, status: 'in_progress', started_at: isoMinutesAgo(5), external_id: makeExternalId('1000') },
      ],
      workflowRunStatus: 'completed',
    });

    await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(octokit.rest.checks.update).not.toHaveBeenCalled();
  });

  it('flags commitHistoryTruncated when the commit count reaches the configured max', async () => {
    const commits = Array.from({ length: 5 }, (_, i) => ({ sha: `sha-${i}` }));
    const octokit = makeOctokit({ commits });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: { ...baseLimits, maxCommitsPerPrForWatchdogScan: 5 },
    });

    expect(results[0]?.commitHistoryTruncated).toBe(true);
  });

  it('does not flag commitHistoryTruncated when the commit count is below the max', async () => {
    const octokit = makeOctokit({ commits: [{ sha: 'a' }, { sha: 'b' }] });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(results[0]?.commitHistoryTruncated).toBe(false);
  });

  it('backfills a stale check to success when a published APPROVE review is found instead of timing it out', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      checkRuns: [
        { id: 111, status: 'in_progress', started_at: isoMinutesAgo(60), external_id: makeExternalId('1000') },
      ],
      workflowRunStatus: 'completed',
      reviews: [{ commit_id: 'headsha123', state: 'APPROVED', body: marker }],
    });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 111, conclusion: 'success' }),
    );
    expect(results[0]?.finalizedCheckRunIds).toEqual([111]);
  });

  it('finalizes other stale checks even when one workflow-run lookup fails (e.g. a deleted run)', async () => {
    const octokit = makeOctokit({
      checkRuns: [
        { id: 111, status: 'in_progress', started_at: isoMinutesAgo(60), external_id: makeExternalId('1000') },
        { id: 222, status: 'in_progress', started_at: isoMinutesAgo(60), external_id: makeExternalId('2000') },
      ],
    });
    octokit.rest.actions.getWorkflowRun = vi.fn().mockImplementation(({ run_id }: { run_id: number }) => {
      if (run_id === 1000) return Promise.reject(new Error('workflow run not found'));
      return Promise.resolve({ data: { status: 'completed' } });
    });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(results[0]?.finalizedCheckRunIds).toEqual([222]);
    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 222, conclusion: 'timed_out' }),
    );
  });
});
