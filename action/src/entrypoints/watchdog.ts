import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import centralLimits from '../../config/central-limits.json' with { type: 'json' };
import { listCheckRunsForRef, patchCheckConclusion, type CheckRunExternalId } from '../lib/check-run.js';
import { getOctokitFromInput } from '../lib/github-client.js';
import { isOwnedByThisBot } from '../lib/hidden-marker.js';

type Octokit = ReturnType<typeof getOctokit>;

export interface WatchdogLimits {
  watchdogStaleThresholdMinutes: number;
  maxCommitsPerPrForWatchdogScan: number;
  maxPrsPerWatchdogRun: number;
}

export interface WatchdogInput {
  owner: string;
  repo: string;
  nowMs: number;
  limits: WatchdogLimits;
}

export interface WatchdogPrResult {
  prNumber: number;
  commitHistoryTruncated: boolean;
  finalizedCheckRunIds: number[];
}

/**
 * Looks for an already-published final Review (APPROVE/REQUEST_CHANGES) on
 * this PR for the exact head_sha the stale check run was watching, so a
 * legitimately-completed publish job isn't misclassified as a true orphan
 * and finalized as timed_out. Only reviews carrying this bot's hidden batch
 * marker count — a human's own APPROVE/CHANGES_REQUESTED review must never
 * be mistaken for the bot's verdict.
 */
export async function checkForPublishedFinalReview(
  octokit: Octokit,
  params: { owner: string; repo: string; prNumber: number; headSha: string },
): Promise<'REQUEST_CHANGES' | 'APPROVE' | null> {
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
  });

  const finalReview = reviews.find(
    (review) =>
      review.commit_id === params.headSha &&
      isOwnedByThisBot(review) &&
      (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED'),
  );

  if (!finalReview) return null;
  return finalReview.state === 'APPROVED' ? 'APPROVE' : 'REQUEST_CHANGES';
}

async function finalizeStaleCheckRun(
  octokit: Octokit,
  input: WatchdogInput,
  run: { id: number; status: string; startedAtMs?: number; externalId?: CheckRunExternalId },
): Promise<number | undefined> {
  if (run.status !== 'in_progress') return undefined;

  const startedAtMs = run.startedAtMs ?? 0;
  const ageMinutes = (input.nowMs - startedAtMs) / 60_000;
  if (ageMinutes < input.limits.watchdogStaleThresholdMinutes) return undefined;

  const externalId = run.externalId;
  if (!externalId) return undefined;

  try {
    const { data: workflowRun } = await octokit.rest.actions.getWorkflowRun({
      owner: input.owner,
      repo: input.repo,
      run_id: Number(externalId.runId),
    });
    if (workflowRun.status === 'queued' || workflowRun.status === 'in_progress') {
      return undefined;
    }

    const publishedReview = await checkForPublishedFinalReview(octokit, {
      owner: input.owner,
      repo: input.repo,
      prNumber: externalId.prNumber,
      headSha: externalId.headSha,
    });
    const conclusion =
      publishedReview === 'APPROVE'
        ? 'success'
        : publishedReview === 'REQUEST_CHANGES'
          ? 'failure'
          : 'timed_out';

    await patchCheckConclusion(octokit, {
      owner: input.owner,
      repo: input.repo,
      checkRunId: run.id,
      conclusion,
    });
    return run.id;
  } catch {
    // A single bad/inaccessible workflow run (deleted, retention-expired,
    // malformed external_id) must not abort the scan for every other
    // check-run/commit/PR in this batch — skip and keep going.
    return undefined;
  }
}

async function processCommitCheckRuns(
  octokit: Octokit,
  input: WatchdogInput,
  commitSha: string,
): Promise<number[]> {
  const checkRuns = await listCheckRunsForRef(octokit, {
    owner: input.owner,
    repo: input.repo,
    ref: commitSha,
  });

  const finalized = await Promise.all(
    checkRuns.map((run) => finalizeStaleCheckRun(octokit, input, run)),
  );
  return finalized.filter((id): id is number => id !== undefined);
}

export async function runWatchdog(
  octokit: Octokit,
  input: WatchdogInput,
): Promise<WatchdogPrResult[]> {
  const openPrs = (await octokit.paginate(octokit.rest.pulls.list, {
    owner: input.owner,
    repo: input.repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  })) as Array<{ number: number }>;

  const prsToProcess = openPrs.slice(0, input.limits.maxPrsPerWatchdogRun);
  const results: WatchdogPrResult[] = [];

  for (const pr of prsToProcess) {
    const commits = (await octokit.paginate(octokit.rest.pulls.listCommits, {
      owner: input.owner,
      repo: input.repo,
      pull_number: pr.number,
      per_page: 100,
    })) as Array<{ sha: string }>;

    const commitHistoryTruncated = commits.length >= input.limits.maxCommitsPerPrForWatchdogScan;

    const finalizedPerCommit = await Promise.all(
      commits.map((commit) => processCommitCheckRuns(octokit, input, commit.sha)),
    );

    results.push({
      prNumber: pr.number,
      commitHistoryTruncated,
      finalizedCheckRunIds: finalizedPerCommit.flat(),
    });
  }

  return results;
}

export async function run(): Promise<void> {
  const octokit = getOctokitFromInput();
  const owner = core.getInput('owner', { required: true });
  const repo = core.getInput('repo', { required: true });

  await runWatchdog(octokit, {
    owner,
    repo,
    nowMs: Date.now(),
    limits: {
      watchdogStaleThresholdMinutes: centralLimits.watchdogStaleThresholdMinutes,
      maxCommitsPerPrForWatchdogScan: centralLimits.maxCommitsPerPrForWatchdogScan,
      maxPrsPerWatchdogRun: centralLimits.maxPrsPerWatchdogRun,
    },
  });
}
