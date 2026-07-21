import { describe, expect, it, vi } from 'vitest';
import { fetchIdentityTuple, identityTuplesEqual, toSchemaIdentityTuple } from './identity-tuple.js';

function makeMockOctokit(overrides?: {
  pullsGet?: unknown;
  compareCommits?: unknown;
}) {
  return {
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: overrides?.pullsGet ?? {
            head: { repo: { full_name: 'octo/head-repo' }, sha: 'headsha123' },
            base: { repo: { full_name: 'octo/base-repo' }, ref: 'main', sha: 'basesha456' },
          },
        }),
      },
      repos: {
        compareCommits: vi.fn().mockResolvedValue({
          data: overrides?.compareCommits ?? {
            merge_base_commit: { sha: 'mergebasesha789' },
          },
        }),
      },
    },
  };
}

describe('fetchIdentityTuple', () => {
  it('maps the pulls.get and compareCommits responses into an IdentityTuple', async () => {
    const octokit = makeMockOctokit();

    const result = await fetchIdentityTuple(octokit as never, 'octo', 'base-repo', 42);

    expect(result).toEqual({
      headRepo: 'octo/head-repo',
      headSha: 'headsha123',
      baseRepo: 'octo/base-repo',
      baseRef: 'main',
      baseSha: 'basesha456',
      mergeBaseSha: 'mergebasesha789',
    });
  });

  it('calls pulls.get with the given owner/repo/pull_number', async () => {
    const octokit = makeMockOctokit();

    await fetchIdentityTuple(octokit as never, 'octo', 'base-repo', 42);

    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'base-repo',
      pull_number: 42,
    });
  });

  it('calls compareCommits with base...head using the base repo owner', async () => {
    const octokit = makeMockOctokit();

    await fetchIdentityTuple(octokit as never, 'octo', 'base-repo', 42);

    expect(octokit.rest.repos.compareCommits).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'base-repo',
      base: 'basesha456',
      head: 'headsha123',
    });
  });
});

describe('identityTuplesEqual', () => {
  const base = {
    headRepo: 'octo/head-repo',
    headSha: 'headsha123',
    baseRepo: 'octo/base-repo',
    baseRef: 'main',
    baseSha: 'basesha456',
    mergeBaseSha: 'mergebasesha789',
  };

  it('returns true for identical tuples', () => {
    expect(identityTuplesEqual(base, { ...base })).toBe(true);
  });

  it('returns false when baseRef changes', () => {
    expect(identityTuplesEqual(base, { ...base, baseRef: 'develop' })).toBe(false);
  });

  it('returns false when baseSha changes', () => {
    expect(identityTuplesEqual(base, { ...base, baseSha: 'other-sha' })).toBe(false);
  });

  it('returns false when headSha changes', () => {
    expect(identityTuplesEqual(base, { ...base, headSha: 'other-sha' })).toBe(false);
  });
});

describe('toSchemaIdentityTuple', () => {
  it('converts camelCase fields to the snake_case schema shape', () => {
    const tuple = {
      headRepo: 'octo/head-repo',
      headSha: 'headsha123',
      baseRepo: 'octo/base-repo',
      baseRef: 'main',
      baseSha: 'basesha456',
      mergeBaseSha: 'mergebasesha789',
    };

    expect(toSchemaIdentityTuple(tuple)).toEqual({
      head_repo: 'octo/head-repo',
      head_sha: 'headsha123',
      base_repo: 'octo/base-repo',
      base_ref: 'main',
      base_sha: 'basesha456',
      merge_base_sha: 'mergebasesha789',
    });
  });
});
