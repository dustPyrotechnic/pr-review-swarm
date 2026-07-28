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
    resolveRef: vi.fn().mockResolvedValue({ ref: 'v1', mode: 'tag' }),
    ...overrides,
  };
}

describe('runDeploy', () => {
  it('orchestrates every step in order and returns a summary for pr mode', async () => {
    const deps = makeDeps();
    const summary = await runDeploy({ deepseekKeyFlag: undefined, directPush: false, force: false }, deps);

    expect(deps.checkGhCli).toHaveBeenCalled();
    expect(deps.detectRepo).toHaveBeenCalled();
    expect(deps.writeWorkflows).toHaveBeenCalledWith(expect.objectContaining({ ref: 'v1', force: false }));
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

  it('reports the resolved ref in the summary so the operator sees what got pinned', async () => {
    const deps = makeDeps();
    const summary = await runDeploy({ deepseekKeyFlag: undefined, directPush: false, force: false }, deps);

    expect(deps.resolveRef).toHaveBeenCalledWith(expect.objectContaining({ pinSha: false }));
    expect(summary).toEqual(expect.objectContaining({ ref: 'v1', refMode: 'tag' }));
  });

  it('passes --pin-sha through so the resolved immutable SHA lands in the workflow files', async () => {
    const sha = 'b'.repeat(40);
    const deps = makeDeps({ resolveRef: vi.fn().mockResolvedValue({ ref: sha, mode: 'sha' }) });
    await runDeploy({ deepseekKeyFlag: undefined, directPush: false, force: false, pinSha: true }, deps);

    expect(deps.resolveRef).toHaveBeenCalledWith(expect.objectContaining({ pinSha: true }));
    expect(deps.writeWorkflows).toHaveBeenCalledWith(expect.objectContaining({ ref: sha }));
  });

  it('passes directPush through to deployChanges', async () => {
    const deps = makeDeps();
    await runDeploy({ deepseekKeyFlag: undefined, directPush: true, force: false }, deps);

    expect(deps.deployChanges).toHaveBeenCalledWith(expect.objectContaining({ directPush: true }));
  });
});
