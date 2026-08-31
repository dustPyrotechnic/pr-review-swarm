import type { getOctokit } from '@actions/github';

type Octokit = ReturnType<typeof getOctokit>;

export interface IdentityTuple {
  headRepo: string;
  headSha: string;
  baseRepo: string;
  baseRef: string;
  baseSha: string;
  mergeBaseSha: string;
}

/**
 * PR 的开闭状态。刻意与 IdentityTuple 并列而不是并入它 —— IdentityTuple 会进
 * verdict artifact，形状受 schemas/verdict.schema.json 约束，往里加字段会破坏校验。
 *
 * 数据来自 fetchIdentityTuple 已经发出的那次 pulls.get，不额外打 API。
 */
export interface PullRequestState {
  state: 'open' | 'closed';
  merged: boolean;
}

export interface FetchIdentityTupleResult {
  identityTuple: IdentityTuple;
  pullRequestState: PullRequestState;
}

export async function fetchIdentityTuple(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<IdentityTuple> {
  return (await fetchIdentityTupleWithState(octokit, owner, repo, prNumber)).identityTuple;
}

export async function fetchIdentityTupleWithState(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<FetchIdentityTupleResult> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const headRepo = pr.head.repo?.full_name ?? '';
  const headSha = pr.head.sha;
  const baseRepo = pr.base.repo?.full_name ?? '';
  const baseRef = pr.base.ref;
  const baseSha = pr.base.sha;

  const { data: comparison } = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base: baseSha,
    head: headSha,
  });

  return {
    identityTuple: {
      headRepo,
      headSha,
      baseRepo,
      baseRef,
      baseSha,
      mergeBaseSha: comparison.merge_base_commit.sha,
    },
    pullRequestState: {
      state: pr.state === 'closed' ? 'closed' : 'open',
      merged: pr.merged === true,
    },
  };
}

export interface SchemaIdentityTuple {
  head_repo: string;
  head_sha: string;
  base_repo: string;
  base_ref: string;
  base_sha: string;
  merge_base_sha: string;
}

export function toSchemaIdentityTuple(tuple: IdentityTuple): SchemaIdentityTuple {
  return {
    head_repo: tuple.headRepo,
    head_sha: tuple.headSha,
    base_repo: tuple.baseRepo,
    base_ref: tuple.baseRef,
    base_sha: tuple.baseSha,
    merge_base_sha: tuple.mergeBaseSha,
  };
}

export function identityTuplesEqual(a: IdentityTuple, b: IdentityTuple): boolean {
  return (
    a.headRepo === b.headRepo &&
    a.headSha === b.headSha &&
    a.baseRepo === b.baseRepo &&
    a.baseRef === b.baseRef &&
    a.baseSha === b.baseSha &&
    a.mergeBaseSha === b.mergeBaseSha
  );
}
