import { describe, expect, it, vi } from 'vitest';
import { runDeploy } from './run-deploy.mjs';

function makeDeps(overrides = {}) {
  return {
    checkGhCli: vi.fn().mockResolvedValue(undefined),
    detectRepo: vi.fn().mockResolvedValue({ owner: 'octo', repo: 'repo' }),
    resolveDeepseekKey: vi.fn().mockResolvedValue('sk-test'),
    writeWorkflows: vi.fn().mockReturnValue({ written: ['.github/workflows/pr-review.yml', '.github/workflows/pr-review-watchdog.yml'], overwritten: [] }),
    writeRepoConfig: vi.fn().mockReturnValue({ written: ['.github/pr-review-swarm.yml'], skipped: [] }),
    setSecret: vi.fn().mockResolvedValue(undefined),
    deployChanges: vi.fn().mockResolvedValue({ mode: 'pr', prUrl: 'https://github.com/octo/repo/pull/1' }),
    pinnedSha: 'abc123',
    ...overrides,
  };
}

describe('runDeploy', () => {
  it('orchestrates every step in order and returns a summary for pr mode', async () => {
    const deps = makeDeps();
    const summary = await runDeploy({ deepseekKeyFlag: undefined, directPush: false, force: false }, deps);

    expect(deps.checkGhCli).toHaveBeenCalled();
    expect(deps.detectRepo).toHaveBeenCalled();
    expect(deps.writeWorkflows).toHaveBeenCalledWith(expect.objectContaining({ pinnedSha: 'abc123', force: false }));
    expect(deps.writeRepoConfig).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
    expect(deps.setSecret).toHaveBeenCalledWith(expect.objectContaining({ owner: 'octo', repo: 'repo', key: 'sk-test' }));
    expect(deps.deployChanges).toHaveBeenCalled();

    expect(summary).toEqual(
      expect.objectContaining({
        owner: 'octo',
        repo: 'repo',
        workflowFiles: ['.github/workflows/pr-review.yml', '.github/workflows/pr-review-watchdog.yml'],
        repoConfigFile: ['.github/pr-review-swarm.yml'],
        secretSet: true,
        deployResult: { mode: 'pr', prUrl: 'https://github.com/octo/repo/pull/1' },
      }),
    );
  });

  it('does not call an Actions-permissions check — the bot never creates/approves PRs, so it does not need that permission', async () => {
    const deps = makeDeps();
    expect(deps.checkActionsPermissions).toBeUndefined();
    await runDeploy({ deepseekKeyFlag: undefined, directPush: false, force: false }, deps);
  });

  it('passes directPush through to deployChanges', async () => {
    const deps = makeDeps();
    await runDeploy({ deepseekKeyFlag: undefined, directPush: true, force: false }, deps);

    expect(deps.deployChanges).toHaveBeenCalledWith(expect.objectContaining({ directPush: true }));
  });
});
