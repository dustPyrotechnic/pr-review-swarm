import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_NAME,
  encodeExternalId,
  decodeExternalId,
  createInProgressCheck,
  patchCheckConclusion,
  listCheckRunsForRef,
  cancelSupersededChecks,
  type CheckRunExternalId,
} from './check-run.js';

const samplePayload: CheckRunExternalId = {
  owner: 'octo',
  repo: 'repo',
  prNumber: 42,
  headSha: 'headsha123',
  baseSha: 'basesha456',
  mergeBaseSha: 'mergebasesha789',
  runId: '1000',
  runAttempt: '1',
};

describe('encodeExternalId / decodeExternalId', () => {
  it('round-trips a payload', () => {
    const encoded = encodeExternalId(samplePayload);
    expect(decodeExternalId(encoded)).toEqual(samplePayload);
  });

  it('returns undefined for garbage input', () => {
    expect(decodeExternalId('not json at all')).toBeUndefined();
  });

  it('returns undefined for valid JSON missing required fields', () => {
    expect(decodeExternalId(JSON.stringify({ owner: 'octo' }))).toBeUndefined();
  });
});

function makeMockOctokit() {
  return {
    rest: {
      checks: {
        create: vi.fn().mockResolvedValue({ data: { id: 111 } }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                id: 111,
                status: 'in_progress',
                external_id: encodeExternalId(samplePayload),
                started_at: '2026-07-20T11:00:00Z',
              },
              {
                id: 222,
                status: 'in_progress',
                external_id: encodeExternalId({ ...samplePayload, runId: '999' }),
              },
              {
                id: 333,
                status: 'completed',
                external_id: encodeExternalId({ ...samplePayload, runId: '888' }),
              },
            ],
          },
        }),
      },
    },
  };
}

describe('createInProgressCheck', () => {
  it('creates a check-run with status in_progress and the given external_id', async () => {
    const octokit = makeMockOctokit();
    const externalId = encodeExternalId(samplePayload);

    const result = await createInProgressCheck(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      headSha: 'headsha123',
      externalId,
    });

    expect(result).toEqual({ id: 111 });
    expect(octokit.rest.checks.create).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'repo',
      name: CHECK_NAME,
      head_sha: 'headsha123',
      status: 'in_progress',
      external_id: externalId,
    });
  });
});

describe('patchCheckConclusion', () => {
  it('marks a check-run completed with the given conclusion', async () => {
    const octokit = makeMockOctokit();

    await patchCheckConclusion(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      checkRunId: 111,
      conclusion: 'action_required',
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octo',
        repo: 'repo',
        check_run_id: 111,
        status: 'completed',
        conclusion: 'action_required',
      }),
    );
  });
});

describe('listCheckRunsForRef', () => {
  it('lists and decodes check runs for a ref, filtered by CHECK_NAME', async () => {
    const octokit = makeMockOctokit();

    const result = await listCheckRunsForRef(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      ref: 'headsha123',
    });

    expect(octokit.rest.checks.listForRef).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'repo',
      ref: 'headsha123',
      check_name: CHECK_NAME,
    });
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ id: 111, status: 'in_progress' });
    expect(result[0]?.externalId?.runId).toBe('1000');
  });

  it('maps started_at to startedAtMs (epoch milliseconds) for staleness checks', async () => {
    const octokit = makeMockOctokit();

    const result = await listCheckRunsForRef(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      ref: 'headsha123',
    });

    expect(result[0]?.startedAtMs).toBe(new Date('2026-07-20T11:00:00Z').getTime());
  });
});

describe('cancelSupersededChecks', () => {
  it('cancels other in_progress checks on the same ref, excluding the current check run', async () => {
    const octokit = makeMockOctokit();

    await cancelSupersededChecks(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      headSha: 'headsha123',
      currentCheckRunId: 111,
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledTimes(1);
    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 222,
        status: 'completed',
        conclusion: 'cancelled',
      }),
    );
  });
});
