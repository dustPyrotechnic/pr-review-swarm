import { describe, expect, it, vi } from 'vitest';
import { evaluateAndStartStatus } from './status-start.js';
import { CHECK_NAME, encodeExternalId } from '../lib/check-run.js';

function toContentResponse(yamlText: string) {
  return {
    data: {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(yamlText, 'utf-8').toString('base64'),
    },
  };
}

const NOT_FOUND = Object.assign(new Error('Not Found'), { status: 404 });

function makeMockOctokit(options: {
  repoConfigYaml?: string | null;
  authorAssociation?: string;
  collaboratorPermission?: string;
  staleCheckRuns?: Array<{ id: number; status: string; runId: string }>;
}) {
  const staleCheckRuns = options.staleCheckRuns ?? [];

  return {
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            head: { repo: { full_name: 'octo/head-repo' }, sha: 'headsha123' },
            base: { repo: { full_name: 'octo/repo' }, ref: 'main', sha: 'basesha456' },
          },
        }),
      },
      repos: {
        compareCommits: vi.fn().mockResolvedValue({
          data: { merge_base_commit: { sha: 'mergebasesha789' } },
        }),
        getContent:
          options.repoConfigYaml === null || options.repoConfigYaml === undefined
            ? vi.fn().mockRejectedValue(NOT_FOUND)
            : vi.fn().mockResolvedValue(toContentResponse(options.repoConfigYaml)),
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: { permission: options.collaboratorPermission ?? 'none' },
        }),
      },
      checks: {
        create: vi.fn().mockResolvedValue({ data: { id: 111 } }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                id: 111,
                status: 'in_progress',
                external_id: encodeExternalId({
                  owner: 'octo',
                  repo: 'repo',
                  prNumber: 42,
                  headSha: 'headsha123',
                  baseSha: 'basesha456',
                  mergeBaseSha: 'mergebasesha789',
                  runId: '1000',
                  runAttempt: '1',
                }),
              },
              ...staleCheckRuns.map((c) => ({
                id: c.id,
                status: c.status,
                external_id: encodeExternalId({
                  owner: 'octo',
                  repo: 'repo',
                  prNumber: 42,
                  headSha: 'headsha123',
                  baseSha: 'basesha456',
                  mergeBaseSha: 'mergebasesha789',
                  runId: c.runId,
                  runAttempt: '1',
                }),
              })),
            ],
          },
        }),
      },
    },
  };
}

const baseDeps = {
  owner: 'octo',
  repo: 'repo',
  prNumber: 42,
  runId: '1000',
  runAttempt: '1',
};

describe('evaluateAndStartStatus', () => {
  it('passes the gate for a trusted author association on a normal PR event', async () => {
    const octokit = makeMockOctokit({
      repoConfigYaml: 'enabled: true\n',
      authorAssociation: 'OWNER',
    });

    const result = await evaluateAndStartStatus(octokit as never, {
      ...baseDeps,
      eventName: 'pull_request_target',
      authorAssociation: 'OWNER',
      senderLogin: 'octocat',
    });

    expect(result.gatePassed).toBe(true);
    expect(result.checkRunId).toBe(111);
    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: CHECK_NAME, status: 'in_progress', head_sha: 'headsha123' }),
    );
    // no action_required conclusion should have been written on the happy path
    expect(octokit.rest.checks.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 111 }),
    );
  });

  it('creates the check first, then writes action_required when the repo is not enabled', async () => {
    const octokit = makeMockOctokit({ repoConfigYaml: null });

    const result = await evaluateAndStartStatus(octokit as never, {
      ...baseDeps,
      eventName: 'pull_request_target',
      authorAssociation: 'OWNER',
      senderLogin: 'octocat',
    });

    expect(result.gatePassed).toBe(false);
    expect(octokit.rest.checks.create).toHaveBeenCalled();
    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 111, conclusion: 'action_required' }),
    );
  });

  it('writes action_required when trust-gate rejects the sender', async () => {
    const octokit = makeMockOctokit({ repoConfigYaml: 'enabled: true\n' });

    const result = await evaluateAndStartStatus(octokit as never, {
      ...baseDeps,
      eventName: 'pull_request_target',
      authorAssociation: 'NONE',
      senderLogin: 'random-user',
    });

    expect(result.gatePassed).toBe(false);
    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 111, conclusion: 'action_required' }),
    );
  });

  it('skips author_association and checks collaborator write permission for workflow_dispatch', async () => {
    const octokit = makeMockOctokit({
      repoConfigYaml: 'enabled: true\n',
      collaboratorPermission: 'write',
    });

    const result = await evaluateAndStartStatus(octokit as never, {
      ...baseDeps,
      eventName: 'workflow_dispatch',
      authorAssociation: 'NONE',
      senderLogin: 'manual-trigger-user',
    });

    expect(result.gatePassed).toBe(true);
    expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'repo',
      username: 'manual-trigger-user',
    });
  });

  it('rejects workflow_dispatch when the sender has only read permission', async () => {
    const octokit = makeMockOctokit({
      repoConfigYaml: 'enabled: true\n',
      collaboratorPermission: 'read',
    });

    const result = await evaluateAndStartStatus(octokit as never, {
      ...baseDeps,
      eventName: 'workflow_dispatch',
      authorAssociation: 'NONE',
      senderLogin: 'manual-trigger-user',
    });

    expect(result.gatePassed).toBe(false);
    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 111, conclusion: 'action_required' }),
    );
  });

  it('cancels a stale in_progress check on the same head_sha but does not touch a completed one', async () => {
    const octokit = makeMockOctokit({
      repoConfigYaml: 'enabled: true\n',
      staleCheckRuns: [
        { id: 222, status: 'in_progress', runId: '999' },
        { id: 333, status: 'completed', runId: '888' },
      ],
    });

    await evaluateAndStartStatus(octokit as never, {
      ...baseDeps,
      eventName: 'pull_request_target',
      authorAssociation: 'OWNER',
      senderLogin: 'octocat',
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 222, conclusion: 'cancelled' }),
    );
    expect(octokit.rest.checks.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 333 }),
    );
  });
});
