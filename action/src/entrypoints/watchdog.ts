import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import centralLimits from '../../config/central-limits.json' with { type: 'json' };
import { listCheckRunsForRef, patchCheckConclusion } from '../lib/check-run.js';
import { getOctokitFromInput } from '../lib/github-client.js';

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
 * PHASE 1 STUB: publish never emits a real REQUEST_CHANGES/APPROVE Review yet
 * (see publish.ts), so there is no legitimate final Review to discover here.
 * Every stale in_progress check is therefore treated as a true orphan and
 * finalized as timed_out. Phase 3 (Task 3.3) replaces this with a real
 * octokit.rest.pulls.listReviews-based check for an already-published final
 * Review before deciding to finalize.
 */
export async function checkForPublishedFinalReview(): Promise<'REQUEST_CHANGES' | 'APPROVE' | null> {
  return null;
}

async function finalizeStaleCheckRun(
  octokit: Octokit,
  input: WatchdogInput,
  run: { id: number; status: string; startedAtMs?: number; externalId?: { runId: string } },
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

    const publishedReview = await checkForPublishedFinalReview();
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
