import { describe, expect, it, vi } from 'vitest';
import {
  cancelSupersededChecks,
  encodeExternalId,
  patchCheckConclusion,
  CHECK_NAME,
} from '../../src/lib/check-run.js';
import { runWatchdog } from '../../src/entrypoints/watchdog.js';

/**
 * Check Run 并发写入竞态（对抗性测试加固计划 Task 6.1）。
 *
 * status-start 的清理（cancelSupersededChecks）与 watchdog 的终结
 * （runWatchdog → patchCheckConclusion）可能同时作用于同一个 Check。Check Run 是权威门禁，
 * 一旦被写成错误终态、或从 completed 退回 in_progress，PR 的门禁结论就是错的。
 */
const OWNER = 'octo';
const REPO = 'repo';
const HEAD_SHA = 'headsha123';

type Status = 'queued' | 'in_progress' | 'completed';

interface CheckRunState {
  id: number;
  status: Status;
  conclusion?: string;
  started_at: string;
  external_id: string;
}

interface Transition {
  id: number;
  from: Status;
  to: Status;
  conclusion?: string;
}

/**
 * 一份共享可变状态的 GitHub fake：checks.update 真的改状态并记录每一次转移，
 * 这样"从 completed 退回 in_progress"这类非法转移才可能被观测到。
 */
function makeSharedGitHub(options: {
  checkRuns: CheckRunState[];
  workflowRunStatus?: string;
  updateBehaviour?: (callIndex: number) => { throw?: unknown };
}) {
  const state = new Map(options.checkRuns.map((r) => [r.id, { ...r }]));
  const transitions: Transition[] = [];
  let updateCalls = 0;

  const octokit = {
    rest: {
      checks: {
        listForRef: vi.fn(async () => ({
          data: { check_runs: [...state.values()].map((r) => ({ ...r, name: CHECK_NAME })) },
        })),
        update: vi.fn(
          async (params: { check_run_id: number; status: Status; conclusion?: string }) => {
            const index = updateCalls++;
            const behaviour = options.updateBehaviour?.(index);
            if (behaviour?.throw) throw behaviour.throw;

            const run = state.get(params.check_run_id);
            if (!run) throw new Error(`unknown check run ${params.check_run_id}`);
            transitions.push({
              id: run.id,
              from: run.status,
              to: params.status,
              conclusion: params.conclusion,
            });
            // GitHub 侧的真实语义：已完成的 Check 不会因为再写一次而回到 in_progress。
            run.status = params.status;
            if (params.conclusion) run.conclusion = params.conclusion;
            return { data: {} };
          },
        ),
      },
      actions: {
        getWorkflowRun: vi
          .fn()
          .mockResolvedValue({ data: { status: options.workflowRunStatus ?? 'completed' } }),
      },
      pulls: {
        list: vi.fn(async () => ({ data: [{ number: 42 }] })),
        listCommits: vi.fn(async () => ({ data: [{ sha: HEAD_SHA }] })),
        listReviews: vi.fn(async () => ({ data: [] })),
      },
    },
    paginate: vi.fn(async (fn: (params: unknown) => Promise<{ data: unknown }>, params: unknown) => {
      const { data } = await fn(params);
      return data;
    }),
  };

  return { octokit, state, transitions, updateCallCount: () => updateCalls };
}

function makeCheckRun(id: number, startedAtMs: number): CheckRunState {
  return {
    id,
    status: 'in_progress',
    started_at: new Date(startedAtMs).toISOString(),
    external_id: encodeExternalId({
      prNumber: 42,
      headSha: HEAD_SHA,
      runId: '9001',
      runAttempt: '1',
    }),
  };
}

const watchdogLimits = {
  watchdogStaleThresholdMinutes: 30,
  maxCommitsPerPrForWatchdogScan: 250,
  maxPrsPerWatchdogRun: 100,
};

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);
const LONG_AGO = NOW - 60 * 60_000; // 60 分钟前，已超过 30 分钟阈值

describe('Check Run 并发写入竞态', () => {
  it('status-start 清理与 watchdog 终结同时作用于同一 Check，不产生错误终态', async () => {
    // 交错执行 100 轮，两侧的调度顺序随机化。
    for (let round = 0; round < 100; round += 1) {
      const gh = makeSharedGitHub({ checkRuns: [makeCheckRun(1, LONG_AGO)] });

      const cleanup = () =>
        cancelSupersededChecks(gh.octokit as never, {
          owner: OWNER,
          repo: REPO,
          headSha: HEAD_SHA,
          currentCheckRunId: 999, // 本轮新建的 Check，1 号属于上一轮，应被取消
        });
      const watchdog = () =>
        runWatchdog(gh.octokit as never, {
          owner: OWNER,
          repo: REPO,
          nowMs: NOW,
          limits: watchdogLimits,
        });

      const order = round % 2 === 0 ? [cleanup, watchdog] : [watchdog, cleanup];
      await Promise.all(order.map((fn) => fn()));

      const final = gh.state.get(1)!;
      expect(final.status, `round ${round}`).toBe('completed');
      expect(['cancelled', 'timed_out'], `round ${round} 得到了意外终态`).toContain(
        final.conclusion,
      );

      // 绝不允许从 completed 退回 in_progress / queued。
      const illegal = gh.transitions.filter((t) => t.from === 'completed' && t.to !== 'completed');
      expect(illegal, `round ${round} 出现非法状态回退：${JSON.stringify(illegal)}`).toEqual([]);
    }
  });

  it('同一 PR 连续 20 次 synchronize，最终只有一个 in_progress Check', async () => {
    const gh = makeSharedGitHub({ checkRuns: [] });

    // 模拟 20 次快速推送：每次新建一个 Check，然后取消所有更早的。
    for (let i = 1; i <= 20; i += 1) {
      gh.state.set(i, makeCheckRun(i, NOW - 1000));
      await cancelSupersededChecks(gh.octokit as never, {
        owner: OWNER,
        repo: REPO,
        headSha: HEAD_SHA,
        currentCheckRunId: i,
      });
    }

    const inProgress = [...gh.state.values()].filter((r) => r.status === 'in_progress');
    expect(inProgress.map((r) => r.id)).toEqual([20]);
    for (const run of [...gh.state.values()].filter((r) => r.id !== 20)) {
      expect(run.conclusion, `Check ${run.id} 未被终结`).toBe('cancelled');
    }
  });

  it('watchdog 不会重复终结一个已经 completed 的 Check', async () => {
    const completed: CheckRunState = {
      ...makeCheckRun(1, LONG_AGO),
      status: 'completed',
      conclusion: 'failure',
    };
    const gh = makeSharedGitHub({ checkRuns: [completed] });

    await runWatchdog(gh.octokit as never, {
      owner: OWNER,
      repo: REPO,
      nowMs: NOW,
      limits: watchdogLimits,
    });

    expect(gh.octokit.rest.checks.update).not.toHaveBeenCalled();
    expect(gh.state.get(1)!.conclusion).toBe('failure');
  });

  it.each([409, 429, 500, 503])(
    'Check Run PATCH 返回 %s（并发冲突/瞬时故障）时重试到成功，不留下 in_progress',
    async (status) => {
      const err = Object.assign(new Error(`HTTP ${status}`), { status });
      const gh = makeSharedGitHub({
        checkRuns: [makeCheckRun(1, LONG_AGO)],
        // 头两次 PATCH 失败，第三次成功。
        updateBehaviour: (i) => (i < 2 ? { throw: err } : {}),
      });

      await patchCheckConclusion(gh.octokit as never, {
        owner: OWNER,
        repo: REPO,
        checkRunId: 1,
        conclusion: 'cancelled',
        retrySleep: async () => {},
      });

      expect(gh.state.get(1)!.status, `status=${status} 后仍停在 in_progress`).toBe('completed');
      expect(gh.state.get(1)!.conclusion).toBe('cancelled');
      expect(gh.updateCallCount(), `status=${status} 应当重试过`).toBe(3);
    },
  );

  it('网络错误（无 HTTP 状态码）同样重试', async () => {
    const gh = makeSharedGitHub({
      checkRuns: [makeCheckRun(1, LONG_AGO)],
      updateBehaviour: (i) => (i < 1 ? { throw: new Error('ECONNRESET') } : {}),
    });

    await patchCheckConclusion(gh.octokit as never, {
      owner: OWNER,
      repo: REPO,
      checkRunId: 1,
      conclusion: 'cancelled',
      retrySleep: async () => {},
    });

    expect(gh.state.get(1)!.status).toBe('completed');
  });

  it('422 不重试：请求本身不可处理，重试不会变好，静默吞掉会藏起真正的载荷错误', async () => {
    const err = Object.assign(new Error('HTTP 422'), { status: 422 });
    const gh = makeSharedGitHub({
      checkRuns: [makeCheckRun(1, LONG_AGO)],
      updateBehaviour: () => ({ throw: err }),
    });

    await expect(
      patchCheckConclusion(gh.octokit as never, {
        owner: OWNER,
        repo: REPO,
        checkRunId: 1,
        conclusion: 'cancelled',
        retrySleep: async () => {},
      }),
    ).rejects.toThrow(/422/);

    expect(gh.updateCallCount(), '422 不应被重试').toBe(1);
  });

  it('409 重试到上限仍失败时把错误抛出去，而不是静默把 Check 留在 in_progress', async () => {
    const err = Object.assign(new Error('HTTP 409'), { status: 409 });
    const gh = makeSharedGitHub({
      checkRuns: [makeCheckRun(1, LONG_AGO)],
      updateBehaviour: () => ({ throw: err }),
    });

    await expect(
      patchCheckConclusion(gh.octokit as never, {
        owner: OWNER,
        repo: REPO,
        checkRunId: 1,
        conclusion: 'cancelled',
        maxRetries: 2,
        retrySleep: async () => {},
      }),
    ).rejects.toThrow(/409/);

    // 这是可观测的失败：job 会红，watchdog 在超时阈值后兜底。最糟的情况是"悄悄成功"。
    expect(gh.state.get(1)!.status).toBe('in_progress');
    expect(gh.updateCallCount()).toBe(3);
  });
});
