import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runWatchdog, checkForPublishedFinalReview } from './watchdog.js';
import { encodeExternalId } from '../lib/check-run.js';
import { encodeBatchMarker } from '../lib/hidden-marker.js';

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
  reviews?: Array<{ commit_id: string; state: string; body: string | null }>;
}) {
  const commits = options.commits ?? [{ sha: 'headsha123' }];
  const checkRuns = options.checkRuns ?? [];

  return {
    rest: {
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [{ number: 1, updated_at: isoMinutesAgo(1) }] }),
        listCommits: vi.fn().mockResolvedValue({ data: commits }),
        listReviews: vi.fn().mockResolvedValue({ data: options.reviews ?? [] }),
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

describe('checkForPublishedFinalReview', () => {
  const params = { owner: 'octo', repo: 'repo', prNumber: 1, headSha: 'headsha123' };

  it('returns null when there is no matching review for the given head_sha', async () => {
    const octokit = makeOctokit({ reviews: [] });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBeNull();
  });

  it('returns APPROVE when a bot-owned APPROVED review exists for the head_sha', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'headsha123', state: 'APPROVED', body: marker }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBe('APPROVE');
  });

  it('returns REQUEST_CHANGES when a bot-owned CHANGES_REQUESTED review exists for the head_sha', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'headsha123', state: 'CHANGES_REQUESTED', body: marker }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBe('REQUEST_CHANGES');
  });

  it('ignores a human-authored review without a bot marker', async () => {
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'headsha123', state: 'APPROVED', body: 'looks good to me' }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBeNull();
  });

  it('ignores a bot review for a different head_sha (stale/older push)', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'some-older-sha', state: 'APPROVED', body: marker }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBeNull();
  });

  it('ignores a bot review left in COMMENT state (not a final verdict)', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      reviews: [{ commit_id: 'headsha123', state: 'COMMENTED', body: marker }],
    });
    expect(await checkForPublishedFinalReview(octokit as never, params)).toBeNull();
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

  it('backfills a stale check to success when a published APPROVE review is found instead of timing it out', async () => {
    const marker = encodeBatchMarker({ reviewSetId: 'set-1', batchIndex: 0, batchCount: 1, digest: 'd' });
    const octokit = makeOctokit({
      checkRuns: [
        { id: 111, status: 'in_progress', started_at: isoMinutesAgo(60), external_id: makeExternalId('1000') },
      ],
      workflowRunStatus: 'completed',
      reviews: [{ commit_id: 'headsha123', state: 'APPROVED', body: marker }],
    });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 111, conclusion: 'success' }),
    );
    expect(results[0]?.finalizedCheckRunIds).toEqual([111]);
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

// ---------------------------------------------------------------------------
// watchdog 边界条件（对抗性测试加固计划 Task 6.2）
// ---------------------------------------------------------------------------

describe('watchdog 边界条件', () => {
  const staleCheck = (startedMinutesAgo: number) => [
    {
      id: 1,
      status: 'in_progress',
      started_at: isoMinutesAgo(startedMinutesAgo),
      external_id: makeExternalId('9001'),
    },
  ];

  it.each([
    ['29 分 59 秒（阈值内侧）', 29 + 59 / 60, false],
    ['恰好 30 分（等于阈值）', 30, true],
    ['30 分 01 秒（阈值外侧）', 30 + 1 / 60, true],
  ])('Check 年龄 %s → 是否终结: %s', async (_label, minutes, shouldFinalize) => {
    const octokit = makeOctokit({ checkRuns: staleCheck(minutes as number) });
    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(results[0]!.finalizedCheckRunIds.length > 0).toBe(shouldFinalize);
  });

  it('open PR 数超过扫描上限时按上限截断，不超配额', async () => {
    const octokit = makeOctokit({});
    octokit.rest.pulls.list = vi.fn().mockResolvedValue({
      data: Array.from({ length: 120 }, (_, i) => ({ number: i + 1 })),
    });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: { ...baseLimits, maxPrsPerWatchdogRun: 50 },
    });

    expect(results).toHaveLength(50);
    // 每个 PR 只拉一次 commits，配额消耗与截断后的数量一致。
    expect(octokit.rest.pulls.listCommits).toHaveBeenCalledTimes(50);
  });

  it('force-push 后旧 commit 不在列表中：不 crash、不死循环，静默跳过', async () => {
    // listCommits 只返回新 commit，旧 commit 上的孤儿 Check 这一轮扫不到。
    const octokit = makeOctokit({ commits: [{ sha: 'brand-new-sha' }] });
    octokit.rest.checks.listForRef = vi.fn().mockResolvedValue({ data: { check_runs: [] } });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.finalizedCheckRunIds).toEqual([]);
    expect(octokit.rest.checks.listForRef).toHaveBeenCalledTimes(1);
  });

  it('run 已 completed 且存在 bot 的 CHANGES_REQUESTED Review → 回填 failure，不覆盖为 timed_out', async () => {
    const octokit = makeOctokit({
      checkRuns: staleCheck(60),
      workflowRunStatus: 'completed',
      reviews: [
        {
          commit_id: 'headsha123',
          state: 'CHANGES_REQUESTED',
          body: `已发布\n${encodeBatchMarker({ reviewSetId: 'rs-1', batchIndex: 0, batchCount: 1, digest: 'd' })}`,
        },
      ],
    });

    await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'failure' }),
    );
  });

  it('run 已 completed 但只有中间 COMMENT 批次 → 视为真孤儿，终结为 timed_out', async () => {
    const octokit = makeOctokit({
      checkRuns: staleCheck(60),
      workflowRunStatus: 'completed',
      reviews: [
        {
          commit_id: 'headsha123',
          state: 'COMMENTED',
          body: `中间批次\n${encodeBatchMarker({ reviewSetId: 'rs-1', batchIndex: 0, batchCount: 3, digest: 'd' })}`,
        },
      ],
    });

    await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'timed_out' }),
    );
  });

  it('commit 历史被截断时，run() 必须把它上报出去（不能算完就丢）', () => {
    // runWatchdog 会算出 commitHistoryTruncated，但这个标志此前在 run() 里完全没有被使用——
    // 扫描范围被截断意味着更老 commit 上的孤儿 Check 这一轮扫不到，属于硬禁令 8 说的
    // "静默截断"，必须留下可观测记录。
    //
    // 计划原文要求"摘要评论出现 commit 历史过长的降级说明"，但 watchdog job 只有
    // pull-requests: read / checks: write / actions: read，没有 issues: write，
    // 为此扩权会违反硬禁令 6。所以改为写进 job 日志。
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'watchdog.ts'),
      'utf-8',
    );
    const runBody = source.slice(source.indexOf('export async function run()'));
    expect(runBody).toContain('commitHistoryTruncated');
    expect(runBody).toMatch(/core\.warning/);
  });
});
