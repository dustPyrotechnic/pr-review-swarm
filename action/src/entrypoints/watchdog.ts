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
  /** 该 PR 本轮扫描失败的原因；缺省表示扫完了。 */
  scanError?: string;
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
    // 单个 PR 扫描失败（GitHub 抖动、PR 刚被删、分支被强推）不能带走同一轮里其它 PR
    // 的孤儿 Check —— 那些 Check 会一直挂在 in_progress 上，直到下一轮才有机会被终结。
    // 失败原因记进 scanError 交给 run() 上报，不静默丢弃（硬禁令 8）。
    try {
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
    } catch (err) {
      results.push({
        prNumber: pr.number,
        commitHistoryTruncated: false,
        finalizedCheckRunIds: [],
        scanError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export async function run(): Promise<void> {
  const octokit = getOctokitFromInput();
  const owner = core.getInput('owner', { required: true });
  const repo = core.getInput('repo', { required: true });

  // watchdog 是每 10 分钟一轮的幂等巡检：这一轮扫不动，下一轮会重扫同样的 Check，
  // 没有任何状态会因此丢失。所以整轮失败只写 warning、让 job 保持绿色，而不是
  // setFailed —— 2026-08-17 那 5 次连红就是 GitHub 侧抖动（codeload 429、
  // 请求超时 502、偶发 403）被顶层未捕获异常放大成的假故障告警。
  // 注意：这里换来的是「连续多轮 warning 才代表真故障」，单轮 warning 不必追。
  let results: WatchdogPrResult[];
  try {
    results = await runWatchdog(octokit, {
      owner,
      repo,
      nowMs: Date.now(),
      limits: {
        watchdogStaleThresholdMinutes: centralLimits.watchdogStaleThresholdMinutes,
        maxCommitsPerPrForWatchdogScan: centralLimits.maxCommitsPerPrForWatchdogScan,
        maxPrsPerWatchdogRun: centralLimits.maxPrsPerWatchdogRun,
      },
    });
  } catch (err) {
    core.warning(
      `watchdog: 本轮扫描整体失败，孤儿 Check 留待下一轮处理（连续多轮出现才说明是真故障）：` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const failedScans = results.filter((result) => result.scanError !== undefined);
  if (failedScans.length > 0) {
    core.warning(
      `watchdog: 以下 PR 本轮未扫完，孤儿 Check 留待下一轮处理：` +
        failedScans.map((r) => `#${r.prNumber}（${r.scanError}）`).join('、'),
    );
  }

  // 扫描范围被截断意味着更老 commit 上的孤儿 Check 这一轮扫不到 —— 属于硬禁令 8 说的
  // "静默截断"，必须留下可观测记录。这里只写日志而不发摘要评论：watchdog job 只持有
  // pull-requests: read / checks: write / actions: read，为了发评论去要 issues: write
  // 会违反硬禁令 6（不为临时需要扩大 Job 权限）。
  const truncated = results.filter((result) => result.commitHistoryTruncated);
  if (truncated.length > 0) {
    core.warning(
      `watchdog: commit 历史过长已被截断（每 PR 上限 ${centralLimits.maxCommitsPerPrForWatchdogScan} 条），` +
        `更早 commit 上的孤儿 Check 本轮未扫描：PR ${truncated.map((r) => `#${r.prNumber}`).join(', ')}`,
    );
  }
}
