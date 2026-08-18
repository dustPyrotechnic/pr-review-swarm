import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  getInput: vi.fn((name: string) => (name === 'owner' ? 'octo' : 'repo')),
  warning: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
}));
const getOctokitFromInput = vi.hoisted(() => vi.fn());

vi.mock('@actions/core', () => core);
vi.mock('../lib/github-client.js', () => ({ getOctokitFromInput }));

const { run, runWatchdog } = await import('./watchdog.js');

const NOW = new Date('2026-08-17T15:49:00Z').getTime();

const baseLimits = {
  watchdogStaleThresholdMinutes: 30,
  maxCommitsPerPrForWatchdogScan: 250,
  maxPrsPerWatchdogRun: 50,
};

/**
 * Octokit stub whose per-PR listCommits can be made to fail for specific PR
 * numbers — that is the shape of the 2026-08-17 outage, where GitHub answered
 * some calls and 403'd others within the same run.
 */
function makeOctokit(options: {
  prNumbers?: number[];
  failCommitsForPrs?: number[];
  failList?: Error;
}) {
  const prNumbers = options.prNumbers ?? [1];
  const failCommitsForPrs = new Set(options.failCommitsForPrs ?? []);

  const list = vi.fn(async () => {
    if (options.failList) throw options.failList;
    return { data: prNumbers.map((number) => ({ number })) };
  });

  const listCommits = vi.fn(async (params: { pull_number: number }) => {
    if (failCommitsForPrs.has(params.pull_number)) {
      throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    }
    return { data: [{ sha: `sha-${params.pull_number}` }] };
  });

  return {
    rest: {
      pulls: { list, listCommits, listReviews: vi.fn().mockResolvedValue({ data: [] }) },
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
        update: vi.fn().mockResolvedValue({ data: {} }),
      },
      actions: { getWorkflowRun: vi.fn().mockResolvedValue({ data: { status: 'completed' } }) },
    },
    paginate: vi.fn(async (fn: (p: unknown) => Promise<{ data: unknown }>, params: unknown) => {
      const { data } = await fn(params);
      return data;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  core.getInput.mockImplementation((name: string) => (name === 'owner' ? 'octo' : 'repo'));
});

describe('runWatchdog 的单 PR 隔离', () => {
  it('一个 PR 扫描失败不能带走同一轮里的其它 PR', async () => {
    const octokit = makeOctokit({ prNumbers: [1, 2, 3], failCommitsForPrs: [2] });

    const results = await runWatchdog(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      nowMs: NOW,
      limits: baseLimits,
    });

    expect(results.map((r) => r.prNumber)).toEqual([1, 2, 3]);
    expect(results.find((r) => r.prNumber === 2)?.scanError).toContain(
      'Resource not accessible by integration',
    );
    expect(results.find((r) => r.prNumber === 1)?.scanError).toBeUndefined();
    expect(results.find((r) => r.prNumber === 3)?.scanError).toBeUndefined();
    expect(octokit.rest.pulls.listCommits).toHaveBeenCalledTimes(3);
  });
});

describe('run() 对 GitHub 抖动的容忍', () => {
  it('整轮扫描失败时写 warning 而不是 setFailed —— watchdog 是幂等巡检，单轮失败不是故障', async () => {
    getOctokitFromInput.mockReturnValue(
      makeOctokit({ failList: Object.assign(new Error('server error'), { status: 502 }) }),
    );

    await run();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('server error'));
  });

  it('单个 PR 扫描失败也要留下可观测记录（硬禁令 8：不许静默跳过）', async () => {
    getOctokitFromInput.mockReturnValue(makeOctokit({ prNumbers: [7, 8], failCommitsForPrs: [8] }));

    await run();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('#8'));
  });

  it('一切正常时既不 warning 也不 setFailed', async () => {
    getOctokitFromInput.mockReturnValue(makeOctokit({ prNumbers: [1] }));

    await run();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('缺少必填输入这类配置错误仍然要 setFailed，不能被容忍逻辑吞掉', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'owner') throw new Error('Input required and not supplied: owner');
      return 'repo';
    });
    getOctokitFromInput.mockReturnValue(makeOctokit({}));

    await expect(run()).rejects.toThrow('Input required and not supplied: owner');
  });
});
