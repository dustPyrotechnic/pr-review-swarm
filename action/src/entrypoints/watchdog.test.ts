import { describe, expect, it, vi } from 'vitest';
import { runWatchdog, checkForPublishedFinalReview } from './watchdog.js';
import { encodeExternalId } from '../lib/check-run.js';

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
}) {
  const commits = options.commits ?? [{ sha: 'headsha123' }];
  const checkRuns = options.checkRuns ?? [];

  return {
    rest: {
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [{ number: 1, updated_at: isoMinutesAgo(1) }] }),
        listCommits: vi.fn().mockResolvedValue({ data: commits }),
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

describe('checkForPublishedFinalReview (Phase 1 stub)', () => {
  it('always returns null in Phase 1', async () => {
    expect(await checkForPublishedFinalReview()).toBeNull();
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
