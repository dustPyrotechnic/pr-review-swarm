import { describe, expect, it, vi } from 'vitest';
import { cleanupLightweightStatus } from './lightweight-cleanup.js';
import { encodeExternalId } from '../lib/check-run.js';

function externalIdFor(runId: string) {
  return encodeExternalId({
    owner: 'octo',
    repo: 'repo',
    prNumber: 42,
    headSha: 'headsha123',
    baseSha: 'basesha456',
    mergeBaseSha: 'mergebasesha789',
    runId,
    runAttempt: '1',
  });
}

function makeMockOctokit() {
  return {
    rest: {
      checks: {
        update: vi.fn().mockResolvedValue({ data: {} }),
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              { id: 111, status: 'in_progress', external_id: externalIdFor('1000') },
              { id: 222, status: 'completed', external_id: externalIdFor('999') },
            ],
          },
        }),
      },
    },
  };
}

describe('cleanupLightweightStatus', () => {
  it('cancels the in_progress check-run for the given head_sha', async () => {
    const octokit = makeMockOctokit();

    const result = await cleanupLightweightStatus(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      headSha: 'headsha123',
    });

    expect(result.cancelledCheckRunIds).toEqual([111]);
    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 111, status: 'completed', conclusion: 'cancelled' }),
    );
  });

  it('does not touch a check-run that is already completed', async () => {
    const octokit = makeMockOctokit();

    await cleanupLightweightStatus(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      headSha: 'headsha123',
    });

    expect(octokit.rest.checks.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 222 }),
    );
  });

});
