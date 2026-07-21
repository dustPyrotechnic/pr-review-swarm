import { context, getOctokit } from '@actions/github';
import { listCheckRunsForRef, patchCheckConclusion } from '../lib/check-run.js';
import { getOctokitFromInput } from '../lib/github-client.js';

type Octokit = ReturnType<typeof getOctokit>;

export interface LightweightCleanupInput {
  owner: string;
  repo: string;
  headSha: string;
}

export interface LightweightCleanupResult {
  cancelledCheckRunIds: number[];
}

export async function cleanupLightweightStatus(
  octokit: Octokit,
  input: LightweightCleanupInput,
): Promise<LightweightCleanupResult> {
  const checkRuns = await listCheckRunsForRef(octokit, {
    owner: input.owner,
    repo: input.repo,
    ref: input.headSha,
  });

  const inProgress = checkRuns.filter((run) => run.status === 'in_progress');

  for (const run of inProgress) {
    try {
      await patchCheckConclusion(octokit, {
        owner: input.owner,
        repo: input.repo,
        checkRunId: run.id,
        conclusion: 'cancelled',
      });
    } catch {
      // A single inaccessible check run (deleted, 403, etc.) must not abort
      // cleanup for remaining in-progress checks — skip and keep going.
    }
  }

  return { cancelledCheckRunIds: inProgress.map((run) => run.id) };
}

export async function run(): Promise<void> {
  const pr = context.payload.pull_request;
  if (!pr) {
    throw new Error('lightweight-cleanup: missing pull_request in event payload');
  }

  const octokit = getOctokitFromInput();

  await cleanupLightweightStatus(octokit, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    headSha: pr.head.sha,
  });
}
